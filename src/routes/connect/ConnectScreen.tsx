import { useMachine } from "@xstate/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ConnectionCard, type ConnectionForm, HostKeyPrompt } from "@/routes/connect/components";
import { connectionMachine, type ConnectionDeps } from "@/machines/connection.machine";
import { Window } from "@/components";
import { toast } from "sonner";
import * as bridge from "@/lib/bridge";

/** The first contents of the card: this machine, no data typed. */
const EMPTY_FORM: ConnectionForm = {
    transport: "local",
    auth: "password",
    address: "",
    password: "",
    privateKeyMaterial: "",
    passphrase: "",
};

/** The largest port number. */
const LAST_PORT = 65535;

/**
 * The port of an address. Returns `undefined` if the text after the colon is
 * not a port.
 *
 * The function checks for digits first. `Number` accepts `"+22"`, `"1e3"`, and
 * `"0x16"` as the ports 22, 1000, and 22. Ssh refuses these values too.
 */
function portOrUndefined(text: string): number | undefined {
    if (!/^\d+$/.test(text)) return undefined;
    const port = Number(text);
    return port >= 1 && port <= LAST_PORT ? port : undefined;
}

/** The host and port of an address. Returns `undefined` if the address has none. */
function splitHost(text: string): { host: string; port?: number } | undefined {
    // Read a bracketed literal as one host. Then the colons belong to the
    // host, not to the port separator. Without the brackets, `[::1]:22` and
    // `host:notaport` are not clear. The field is a plain text box.
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
    // No port is the usual case. Rust supplies the default. A colon and a
    // value that is not a port is a typing error.
    const port = text.slice(colon + 1);
    if (port === "") return { host };
    const parsed = portOrUndefined(port);
    return parsed === undefined ? undefined : { host, port: parsed };
}

/**
 * The target of an address. Returns `undefined` if the address has none.
 *
 * The forms are the known forms of ssh and scp: `user@host`, `user@host:port`,
 * or a bracketed IPv6 literal with either. Rust takes the three parts
 * separately. Pie must not attempt a connection to a host that pie cannot name.
 */
function parseSshAddress(address: string): { user: string; host: string; port?: number } | undefined {
    const trimmed = address.trim();
    const at = trimmed.indexOf("@");
    if (at <= 0) return undefined;

    const user = trimmed.slice(0, at);
    // The field is a login address, not an scp target. `pi:pass@host` is a
    // mistake. Rust reads the whole value as a login name.
    if (user.includes(":")) return undefined;

    const host = splitHost(trimmed.slice(at + 1));
    return host === undefined ? undefined : { user, ...host };
}

/**
 * The request for Rust from the contents of the card. Returns `undefined` while
 * the contents name no host. The card reads `canConnect` from this value.
 * Therefore an address that cannot name a target keeps Connect off. There is no
 * failed round trip.
 *
 * A port that the person did not type stays absent. Rust supplies the default.
 * Rust owns that default.
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
 * The key credential, with the passphrase if one is present.
 *
 * The passphrase goes with the credential only if the person typed it. An
 * absent field and an empty string are the same to the host. A `""` where
 * nothing is expected is a different request.
 */
function keyAuth(credential: { type: "key"; key: string }, passphrase: string): bridge.SshAuthSpec {
    return passphrase === "" ? credential : { ...credential, passphrase };
}

/**
 * The bridge that the screen uses by default: the real bridge, with the one
 * connection name of pie.
 */
const REAL_DEPS: ConnectScreenDeps = {
    connection: bridge.CONNECTION_ID,
    connect: bridge.connect,
    trustHostKey: bridge.trustHostKey,
    onConnectionState: bridge.onConnectionState,
    pickPrivateKey: bridge.pickPrivateKey,
};

/**
 * The needs of the screen: the needs of the machine, and the one call that only
 * the screen makes. The picker is not the business of the machine. Therefore it
 * is not in {@link ConnectionDeps}. In that type, each test of the machine would
 * replace a call that the machine never makes.
 */
export type ConnectScreenDeps = ConnectionDeps & {
    pickPrivateKey: typeof bridge.pickPrivateKey;
};

export interface ConnectScreenProps {
    /** A test or a story can give a stub here and walk the real screen. */
    deps?: ConnectScreenDeps;
}

export function ConnectScreen({ deps = REAL_DEPS }: ConnectScreenProps = {}) {
    const { pickPrivateKey } = deps;
    const navigate = useNavigate();
    const [form, setForm] = useState(EMPTY_FORM);
    const [state, send] = useMachine(connectionMachine, { input: deps });

    // This is the one place where a ready connection causes another action.
    const reached = state.matches("connected");
    useEffect(() => {
        if (reached) navigate("/chat", { replace: true });
    }, [navigate, reached]);

    // A failed connect is announced, not shown on the form. The form did not
    // change. An inline line would be the only text about the attempt, not about
    // the connection.
    const failure = state.context.error;
    useEffect(() => {
        if (failure) toast.error(failure.message);
    }, [failure]);

    const spec = useMemo(() => connectSpec(form), [form]);
    const patch = useCallback(
        (change: Partial<ConnectionForm>) => setForm((previous) => ({ ...previous, ...change })),
        [],
    );

    /**
     * Puts the key from the picker into the one field of the card for the key.
     * That step is the full result of the selection of a file.
     */
    const pickKey = useCallback(async () => {
        try {
            const key = await pickPrivateKey();
            if (key !== null) setForm((previous) => ({ ...previous, privateKeyMaterial: key }));
        } catch (thrown) {
            const failure = bridge.asPieError(thrown);
            toast.error(failure.message);
        }
    }, [pickPrivateKey]);

    return (
        <Window
            // The gate's card: centred, and kept away from the window's edge.
            // The body does not scroll. The card has the height of the body and
            // scrolls its own contents - a body that scrolled would move the top
            // edge and the border of the card out of view.
            bodyClassName="items-center justify-center p-4"
        >
            <ConnectionCard
                form={form}
                connecting={state.matches("connecting")}
                canConnect={spec !== undefined}
                onChange={patch}
                onConnect={() => spec && send({ type: "CONNECT", spec })}
                onPickKey={() => void pickKey()}
            />

            <HostKeyPrompt
                // Rust keeps one question open at a time. A new question replaces
                // the old question. Therefore a new fingerprint must start a new
                // prompt. If not, the keys of the old question stay on screen.
                key={state.context.hostKey?.fingerprint}
                presentedKey={state.context.hostKey}
                onAnswer={(trusted) => send({ type: "ANSWER_HOST_KEY", trusted })}
            />
        </Window>
    );
}
