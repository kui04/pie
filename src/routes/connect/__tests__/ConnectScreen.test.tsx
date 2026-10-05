/**
 * The gate, in the steps of a person: select a transport, complete the
 * credential, connect. Each dial goes through a stub bridge. Therefore no test
 * here starts pi. The graph is under test in the tests of the machine.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { ConnectScreen, type ConnectScreenDeps } from "@/routes/connect/ConnectScreen";
import type { ConnectionInfo, PieError, PresentedKey } from "@/lib/bridge";

const KEY: PresentedKey = {
    host: "192.168.1.10",
    port: 22,
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:2a:b4:c1:88:9f:0e",
};

afterEach(cleanup);

/** A dial that stays open. A test can then look at the locked form. */
const never = () => new Promise<ConnectionInfo>(() => undefined);

/**
 * A bridge that records each request and keeps the dial open. Nothing here
 * reaches Tauri. The screen is under test, not the IPC.
 */
function stubBridge(overrides: Partial<ConnectScreenDeps> = {}) {
    let publish: ((state: { type: "host_key"; key: PresentedKey }) => void) | undefined;
    let abandonDial: ((reason: unknown) => void) | undefined;
    const deps: ConnectScreenDeps = {
        connection: "main",
        // It completes only when a test says so. Therefore a test can abandon a
        // dial during a question, as a host key does at the timeout.
        connect: vi.fn(
            () =>
                new Promise<ConnectionInfo>((_resolve, reject) => {
                    abandonDial = reject;
                }),
        ),
        trustHostKey: vi.fn(async () => true),
        onConnectionState: vi.fn(async (_id, onState) => {
            publish = onState as typeof publish;
            return () => undefined;
        }),
        pickPrivateKey: vi.fn(async () => null),
        ...overrides,
    };
    return {
        deps,
        /** Puts the question on the wire, as Rust does during the handshake. */
        askHostKey: () => publish?.({ type: "host_key", key: KEY }),
        /** Ends the dial, as a host key without an answer does at the timeout. */
        failDial: (reason: unknown = new Error("the host never answered")) => abandonDial?.(reason),
    };
}

function renderGate(deps: ConnectScreenDeps) {
    return render(
        <MemoryRouter initialEntries={["/"]}>
            {/* The toast stack belongs to the app. The announcements of the
                gate exist only where the app puts them. */}
            <Toaster position="top-center" />
            <Routes>
                <Route path="/" element={<ConnectScreen deps={deps} />} />
                <Route path="/chat" element={<p>the workspace</p>} />
            </Routes>
        </MemoryRouter>,
    );
}

const CONNECT = () => screen.getByRole("button", { name: "Connect" });

/**
 * Fills a field with a paste, not with a type.
 *
 * `user.type` reads its argument as a keyboard script. Therefore `[` starts a
 * key descriptor. An IPv6 literal contains many of them.
 */
async function paste(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
    const field = screen.getByLabelText(label);
    await user.click(field);
    await user.paste(text);
}

const KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

/** The two clicks at the start of each private-key test. */
async function openKeyAuth(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("radio", { name: /SSH/ }));
    await paste(user, "Address", "pi@example.com");
    await user.click(screen.getByRole("radio", { name: "Private key" }));
}

describe("ConnectScreen", () => {
    it("starts on this machine, with nothing a host would need on screen", () => {
        const { deps } = stubBridge();
        renderGate(deps);

        expect(screen.getByRole("heading", { name: "Connect to pi" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: /Local process/ })).toBeChecked();
        expect(screen.queryByLabelText("Address")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    });

    it("connects to a local pi and hands over to the workspace", async () => {
        const user = userEvent.setup();
        const connect = vi.fn(async () => ({ id: "main", endpoint: "local", sessions: [] }));
        renderGate(stubBridge({ connect }).deps);

        await user.click(CONNECT());

        await waitFor(() => expect(connect).toHaveBeenCalledWith("main", { transport: "local" }));
        await screen.findByText("the workspace");
    });

    it("wants an address and a password before it will dial an SSH host", async () => {
        const user = userEvent.setup();
        renderGate(stubBridge().deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));

        expect(screen.getByLabelText("Address")).toBeInTheDocument();
        expect(screen.getByLabelText("Password")).toBeInTheDocument();
        // An address without a host keeps Connect off. There is no round trip
        // that finds the error.
        expect(CONNECT()).toBeDisabled();

        await user.type(screen.getByLabelText("Address"), "pi@192.168.1.10:22");
        expect(CONNECT()).toBeDisabled();

        await user.type(screen.getByLabelText("Password"), "hunter2");
        expect(CONNECT()).toBeEnabled();
    });

    it("sends the address as Rust wants it, port included", async () => {
        const user = userEvent.setup();
        const connect = vi.fn(never);
        renderGate(stubBridge({ connect }).deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));
        await user.type(screen.getByLabelText("Address"), "pi@box.example:2222");
        await user.type(screen.getByLabelText("Password"), "hunter2");
        await user.click(CONNECT());

        await waitFor(() =>
            expect(connect).toHaveBeenCalledWith("main", {
                transport: "ssh",
                user: "pi",
                host: "box.example",
                port: 2222,
                auth: { type: "password", password: "hunter2" },
            }),
        );
    });

    it("leaves a typed-out port to Rust, which owns the default", async () => {
        const user = userEvent.setup();
        const connect = vi.fn(never);
        renderGate(stubBridge({ connect }).deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));
        await user.type(screen.getByLabelText("Address"), "pi@box.example");
        await user.type(screen.getByLabelText("Password"), "hunter2");
        await user.click(CONNECT());

        // `port` in Rust is `Option<u16>` with `#[serde(default)]`. Therefore the
        // omission of the field is a real answer. Rust can change the default.
        await waitFor(() =>
            expect(connect).toHaveBeenCalledWith("main", {
                transport: "ssh",
                user: "pi",
                host: "box.example",
                auth: { type: "password", password: "hunter2" },
            }),
        );
    });

    it("keeps a bracketed IPv6 literal whole, port or not", async () => {
        const user = userEvent.setup();
        const connect = vi.fn(never);
        renderGate(stubBridge({ connect }).deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));
        await paste(user, "Address", "pi@[2001:db8::1]:2222");
        await user.type(screen.getByLabelText("Password"), "hunter2");
        await user.click(CONNECT());

        await waitFor(() =>
            expect(connect).toHaveBeenCalledWith("main", {
                transport: "ssh",
                user: "pi",
                host: "2001:db8::1",
                port: 2222,
                auth: { type: "password", password: "hunter2" },
            }),
        );
    });

    it("reads a bracketed literal with no port as a host, not as a port", async () => {
        const user = userEvent.setup();
        const connect = vi.fn(never);
        renderGate(stubBridge({ connect }).deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));
        await paste(user, "Address", "pi@[::1]");
        await user.type(screen.getByLabelText("Password"), "hunter2");
        await user.click(CONNECT());

        await waitFor(() =>
            expect(connect).toHaveBeenCalledWith("main", {
                transport: "ssh",
                user: "pi",
                host: "::1",
                auth: { type: "password", password: "hunter2" },
            }),
        );
    });

    it.each([
        ["no login name at all", "192.168.1.10:22"],
        ["an empty login name", "@192.168.1.10"],
        ["no host", "pi@"],
        ["no host before the port", "pi@:22"],
        ["a port that cannot exist", "pi@box.example:70000"],
        ["a service name where a port belongs", "pi@box.example:ssh"],
        ["an unclosed literal", "pi@[::1"],
        ["text after the literal", "pi@[::1]x"],
        ["an scp target rather than a login", "pi:hunter2@box.example"],
        // `Number` accepts each of these as a port. Ssh does not.
        ["a signed port", "pi@box.example:+22"],
        ["a port in exponent form", "pi@box.example:1e3"],
        ["a port in hex", "pi@box.example:0x16"],
    ])("names no host for %s, so Connect stays off", async (_case, address) => {
        const user = userEvent.setup();
        const connect = vi.fn(never);
        renderGate(stubBridge({ connect }).deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));
        await paste(user, "Address", address);
        await user.type(screen.getByLabelText("Password"), "hunter2");

        expect(CONNECT()).toBeDisabled();
        await user.click(CONNECT());
        expect(connect).not.toHaveBeenCalled();
    });

    it("swaps the credential field when the method changes", async () => {
        const user = userEvent.setup();
        renderGate(stubBridge().deps);

        await user.click(screen.getByRole("radio", { name: /SSH/ }));
        await user.click(screen.getByRole("radio", { name: "Private key" }));

        expect(screen.getByLabelText("Private key")).toBeInTheDocument();
        expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    });

    it("sends the key itself, and no passphrase when none was typed", async () => {
        const user = userEvent.setup();
        const { deps } = stubBridge();
        renderGate(deps);
        await openKeyAuth(user);

        await paste(user, "Private key", KEY_TEXT);
        await user.click(CONNECT());

        expect(deps.connect).toHaveBeenCalledWith(
            "main",
            expect.objectContaining({ auth: { type: "key", key: KEY_TEXT } }),
        );
    });

    it("rides along a passphrase that was typed", async () => {
        const user = userEvent.setup();
        const { deps } = stubBridge();
        renderGate(deps);
        await openKeyAuth(user);

        await paste(user, "Private key", KEY_TEXT);
        await paste(user, "Passphrase", "letmein");
        await user.click(CONNECT());

        expect(deps.connect).toHaveBeenCalledWith(
            "main",
            expect.objectContaining({ auth: { type: "key", key: KEY_TEXT, passphrase: "letmein" } }),
        );
    });

    it("keeps Connect off while the key field is empty", async () => {
        const user = userEvent.setup();
        const { deps } = stubBridge();
        renderGate(deps);
        await openKeyAuth(user);

        expect(CONNECT()).toBeDisabled();
        await paste(user, "Passphrase", "letmein");
        expect(CONNECT()).toBeDisabled();
    });

    it("drops a picked key into the one field the card has", async () => {
        const user = userEvent.setup();
        const { deps } = stubBridge({ pickPrivateKey: vi.fn(async () => KEY_TEXT) });
        renderGate(deps);
        await openKeyAuth(user);

        expect(CONNECT()).toBeDisabled();
        await user.click(screen.getByRole("button", { name: /Choose a key file/ }));

        expect(screen.getByLabelText("Private key")).toHaveValue(KEY_TEXT);
        expect(CONNECT()).toBeEnabled();
    });

    it("leaves the field alone when the picker was closed", async () => {
        const user = userEvent.setup();
        const { deps } = stubBridge({ pickPrivateKey: vi.fn(async () => null) });
        renderGate(deps);
        await openKeyAuth(user);

        await user.click(screen.getByRole("button", { name: /Choose a key file/ }));

        expect(screen.getByLabelText("Private key")).toHaveValue("");
        expect(CONNECT()).toBeDisabled();
    });

    it("locks the whole form while the dial is in flight", async () => {
        const user = userEvent.setup();
        renderGate(stubBridge().deps);

        await user.click(CONNECT());

        // All fields of the person become inactive together. Therefore the
        // credential cannot change during a handshake that already read the old
        // credential.
        await waitFor(() => expect(screen.getByRole("radio", { name: /Local process/ })).toBeDisabled());
        expect(screen.getByRole("button", { name: /Connecting/ })).toBeDisabled();
        expect(screen.getByText("Connecting")).toBeInTheDocument();
    });

    it("announces a failed dial, and unlocks the form to retry", async () => {
        const user = userEvent.setup();
        const connect = vi
            .fn()
            .mockRejectedValueOnce({
                type: "rpc",
                message: "pi is not on PATH",
                error: { kind: "spawn" },
            } satisfies PieError)
            .mockImplementation(never);
        renderGate(stubBridge({ connect }).deps);

        await user.click(CONNECT());

        // The toast carries the message from Rust and the meaning of the named
        // variant. Each one alone does not tell the person the next step.
        const announced = await screen.findByText("pi is not on PATH");
        expect(announced).toBeInTheDocument();
        expect(screen.getByText("pi is not there, or could not be started.")).toBeInTheDocument();

        // The form did not change. Therefore it is ready for another attempt.
        expect(CONNECT()).toBeEnabled();
        await user.click(CONNECT());
        await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    });

    it("says nothing on a second failure once the first toast has gone", async () => {
        const user = userEvent.setup();
        const connect = vi.fn().mockRejectedValue({
            type: "rpc",
            message: "connection refused",
            error: { kind: "connect" },
        } satisfies PieError);
        const { unmount } = renderGate(stubBridge({ connect }).deps);

        await user.click(CONNECT());
        await screen.findByText("connection refused");
        // A connect failure reads as a connect failure. The named kind has its
        // own text, not the wider text of the module.
        expect(screen.getByText("The host could not be reached.")).toBeInTheDocument();
        unmount();

        // A new mount starts with no failure. Therefore there is no announcement.
        // The toast follows the error of the machine, not the record of the form.
        renderGate(stubBridge({ connect: vi.fn(never) }).deps);
        expect(screen.queryByText("connection refused")).not.toBeInTheDocument();
    });

    it("puts the host key up while the handshake waits, and can trust it", async () => {
        const user = userEvent.setup();
        const stub = stubBridge();
        renderGate(stub.deps);

        await user.click(CONNECT());
        stub.askHostKey();

        // The sheet tells the person what to check and what the result of the
        // check is.
        const sheet = await screen.findByRole("dialog");
        expect(sheet).toHaveTextContent("Trust this host?");
        expect(sheet).toHaveTextContent(KEY.fingerprint);
        expect(sheet).toHaveTextContent(KEY.algorithm);

        await user.click(screen.getByRole("button", { name: "Trust" }));

        await waitFor(() => expect(stub.deps.trustHostKey).toHaveBeenCalledWith("main", true));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("treats a dismissal as a refusal, because Rust is waiting on an answer", async () => {
        const user = userEvent.setup();
        const stub = stubBridge();
        renderGate(stub.deps);

        await user.click(CONNECT());
        stub.askHostKey();
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(stub.deps.trustHostKey).toHaveBeenCalledWith("main", false));
    });

    it("takes the prompt away when the handshake is abandoned with it on screen", async () => {
        // A host key without an answer reaches the timeout. The failure arrives
        // while the question is on screen. The prompt must go also. The prompt is
        // open only while `hostKey` is set. After the machine leaves `connecting`,
        // no handler accepts an answer. Therefore Cancel, Trust, Escape, and a
        // drag have no effect.
        const user = userEvent.setup();
        const stub = stubBridge();
        renderGate(stub.deps);

        await user.click(CONNECT());
        stub.askHostKey();
        await screen.findByRole("dialog");

        stub.failDial(new Error("the host never answered"));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Trust" })).not.toBeInTheDocument();
        // The form operates again. This is the second result of the closed
        // prompt.
        expect(CONNECT()).toBeEnabled();
    });

    it("asks for no host key at all until one is actually presented", () => {
        const stub = stubBridge();
        renderGate(stub.deps);

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});
