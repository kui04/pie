/**
 * The startup gate: get pie onto a host, then get out of the way.
 *
 * Connecting away is not a state of this screen — it leaves it — so all that
 * happens on success is a route change.
 */

import { useMachine } from "@xstate/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ConnectionCard, type ConnectionForm } from "@/routes/connect/components/ConnectionCard";
import { HostKeyPrompt } from "@/routes/connect/components/HostKeyPrompt";
import { connectionMachine, type ConnectionDeps } from "@/machines/connection.machine";
import { Panel } from "@/components/Panel";
import { useIsMobile } from "@/hooks/use-platform";
import { toast } from "sonner";
import * as bridge from "@/lib/bridge";

/** What the card starts as: this machine, nothing typed. */
const EMPTY_FORM: ConnectionForm = {
    transport: "local",
    auth: "password",
    address: "",
    password: "",
    privateKeyMaterial: "",
    passphrase: "",
};

/** The boundary of every port there is. */
const LAST_PORT = 65535;

/**
 * The port an address names, or `undefined` when what follows the colon is not
 * one.
 *
 * Digits only, checked before the number is read: `Number` would take `"+22"`
 * and `"1e3"` and `"0x16"` for ports 22, 1000 and 22, and a field where the
 * person typed a port should not go looking for one ssh would also refuse.
 */
function portOrUndefined(text: string): number | undefined {
    if (!/^\d+$/.test(text)) return undefined;
    const port = Number(text);
    return port >= 1 && port <= LAST_PORT ? port : undefined;
}

/** The host and port an address names, or `undefined` when it names none. */
function splitHost(text: string): { host: string; port?: number } | undefined {
    // A bracketed literal is read as one whole host, which is the only way a
    // colon can belong to the host rather than to the port's separator.
    // Without the brackets `[::1]:22` and `host:notaport` are ambiguous, and the
    // field is a plain text box, so the brackets are the person saying which.
    if (text.startsWith("[")) {
        const close = text.indexOf("]");
        if (close === -1) return undefined;
        const host = text.slice(1, close);
        if (host === "") return undefined;
        const rest = text.slice(close + 1);
        if (rest === "") return { host };
        if (!rest.startsWith(":")) return undefined;
        const port = portOrUndefined(rest.slice(1));
        return port === undefined ? undefined : { host, port };
    }

    const colon = text.lastIndexOf(":");
    if (colon === -1) return text === "" ? undefined : { host: text };
    const host = text.slice(0, colon);
    if (host === "") return undefined;
    // No port is the common case and Rust defaults it; a colon followed by
    // something that is not a port is a typo, not a host with no port.
    const port = text.slice(colon + 1);
    if (port === "") return { host };
    const parsed = portOrUndefined(port);
    return parsed === undefined ? undefined : { host, port: parsed };
}

/**
 * The target an address names, or `undefined` when it names none.
 *
 * This is the form people already know from ssh and scp: `user@host`,
 * `user@host:port`, or a bracketed IPv6 literal with either. Rust takes the
 * three parts separately, and a connection to a host pie cannot name is not a
 * connection worth attempting.
 */
function parseSshAddress(address: string): { user: string; host: string; port?: number } | undefined {
    const trimmed = address.trim();
    const at = trimmed.indexOf("@");
    if (at <= 0) return undefined;

    const user = trimmed.slice(0, at);
    // The field is a login address, not an scp target: `pi:pass@host` is a
    // mistake, and Rust would read the whole thing as a login name.
    if (user.includes(":")) return undefined;

    const host = splitHost(trimmed.slice(at + 1));
    return host === undefined ? undefined : { user, ...host };
}

/**
 * What the card's contents mean to Rust, or `undefined` while they name no
 * host. The card reads `canConnect` off this, so an address that cannot name a
 * target keeps Connect off instead of failing one round trip later.
 *
 * A port the person did not type stays absent rather than being filled in here:
 * Rust already defaults it, and that default is Rust's to own.
 */
function connectSpec(form: ConnectionForm): bridge.ConnectSpec | undefined {
    if (form.transport === "local") return { transport: "local" };

    const target = parseSshAddress(form.address);
    if (target === undefined) return undefined;
    if (form.auth === "password") {
        return form.password === ""
            ? undefined
            : { transport: "ssh", ...target, auth: { type: "password", password: form.password } };
    }
    const credential: { type: "key"; key: string } = {
        type: "key",
        key: form.privateKeyMaterial.trim(),
    };
    if (credential.key === "") return undefined;
    return { transport: "ssh", ...target, auth: keyAuth(credential, form.passphrase) };
}

/**
 * The key credential, with its passphrase when there is one.
 *
 * A passphrase only rides along when it was typed: an absent field and an empty
 * string mean the same thing to the host, and sending `""` where nothing is
 * expected is a different request.
 */
function keyAuth(credential: { type: "key"; key: string }, passphrase: string): bridge.SshAuthSpec {
    return passphrase === "" ? credential : { ...credential, passphrase };
}

/**
 * What the screen talks to when nothing has said otherwise: the real bridge,
 * under the one connection name pie uses.
 */
const REAL_DEPS: ConnectScreenDeps = {
    connection: bridge.CONNECTION_ID,
    connect: bridge.connect,
    trustHostKey: bridge.trustHostKey,
    onConnectionState: bridge.onConnectionState,
    pickPrivateKey: bridge.pickPrivateKey,
};

/**
 * What each failure category means for the person reading it.
 *
 * Rust's message says what went wrong; this says what to do about it, which is
 * the half a message like "authentication failed" cannot carry on its own. The
 * categories are the boundary's own (`PieError`), so the wording for all of
 * them lives here in one table.
 */
const FAILURE_REASON: Record<bridge.PieErrorTag, string> = {
    transport: "The host could not be reached.",
    file: "That file could not be read. Another one may work.",
    auth: "The host would not accept who pie said it was.",
    host_key: "This host is not the machine you meant to reach.",
    process: "pi is not there, or is not the release pie speaks.",
    rpc: "pi refused the command.",
    already_connected: "pie is already connected to a host.",
    not_connected: "There is no connection.",
    internal: "Something on pie's own side went wrong.",
};

/**
 * What the screen needs: everything the machine needs, plus the one call only
 * the screen makes. The picker is not machine business, so it is not in
 * {@link ConnectionDeps} — putting it there would make every test of the machine
 * stub a call the machine never makes.
 */
export type ConnectScreenDeps = ConnectionDeps & {
    pickPrivateKey: typeof bridge.pickPrivateKey;
};

export interface ConnectScreenProps {
    /** Overridable so stories and tests walk the real screen against a stub. */
    deps?: ConnectScreenDeps;
}

export function ConnectScreen({ deps = REAL_DEPS }: ConnectScreenProps = {}) {
    const { pickPrivateKey } = deps;
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const [form, setForm] = useState(EMPTY_FORM);
    const [state, send] = useMachine(connectionMachine, { input: deps });

    // The one place a connection being up has to mean something else happens.
    const reached = state.matches("connected");
    useEffect(() => {
        if (reached) navigate("/chat", { replace: true });
    }, [navigate, reached]);

    // A failed dial is announced rather than shown on the form. Nothing about
    // the form changed, so an inline line would be the only thing on the card
    // about the attempt instead of about the connection; the toast also
    // carries the category, which is the part Rust's message leaves out.
    const failure = state.context.error;
    useEffect(() => {
        if (failure) toast.error(failure.message, { description: FAILURE_REASON[failure.type] });
    }, [failure]);

    const spec = useMemo(() => connectSpec(form), [form]);
    const patch = useCallback(
        (change: Partial<ConnectionForm>) => setForm((previous) => ({ ...previous, ...change })),
        [],
    );

    /**
     * Puts the key the picker brought back into the one field the card has for
     * it, which is the whole of what choosing a file amounts to.
     */
    const pickKey = useCallback(async () => {
        try {
            const key = await pickPrivateKey();
            if (key !== null) setForm((previous) => ({ ...previous, privateKeyMaterial: key }));
        } catch (thrown) {
            const failure = bridge.asPieError(thrown);
            toast.error(failure.message, { description: FAILURE_REASON[failure.type] });
        }
    }, [pickPrivateKey]);

    return (
        <main
            id="connect-root"
            // `flex-1 min-h-0` rather than a viewport height: the app shell owns
            // the height, and on a desktop it has already spent a row on the
            // title bar — a screen-sized panel below it would overflow the window.
            className="bg-background text-foreground flex min-h-0 w-full flex-1 flex-col overflow-hidden font-sans"
        >
            <Panel
                id="connect-stage"
                // A phone's OS owns no title bar, so this is the whole window. A
                // desktop window's title bar is itself a panel, which is what
                // earns this one its chrome.
                solo={isMobile}
                // Keeps the card off the window edge on a phone, which has no
                // chrome to separate it.
                //
                // The panel does not scroll, and the card caps itself to it and
                // scrolls its own contents instead. A panel that scrolled would
                // take the card's top edge and border out of view with it, and
                // would have to start-align the card to keep the top reachable.
                className="items-center justify-center p-4"
            >
                <ConnectionCard
                    form={form}
                    connecting={state.matches("connecting")}
                    canConnect={spec !== undefined}
                    onChange={patch}
                    onConnect={() => spec && send({ type: "CONNECT", spec })}
                    onPickKey={() => void pickKey()}
                />
            </Panel>

            <HostKeyPrompt
                // Rust keeps one question open at a time and replaces it rather
                // than queueing, so a new fingerprint has to remount the prompt
                // instead of leaving the old one's keys on screen.
                key={state.context.hostKey?.fingerprint}
                presentedKey={state.context.hostKey}
                onAnswer={(trusted) => send({ type: "ANSWER_HOST_KEY", trusted })}
            />
        </main>
    );
}
