/**
 * The startup gate. This screen connects pie to a host. Then the screen is
 * removed.
 *
 * A successful connection is not a state of this screen. The screen goes away.
 * Therefore a successful connection causes a route change only.
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
 * The meaning of each named failure for the person.
 *
 * The message from Rust tells what went wrong. This table tells what to do. A
 * message such as "authentication failed" does not tell what to do.
 *
 * The keys are the variant names of the error enums of Rust. These names are
 * the values of `PieError.error.kind`. If pie has no text for a failure, the
 * text of the module is used.
 */
const FAILURE_REASON: Record<bridge.PieErrorKind, string> = {
    // `pi_rpc::Error`: the connect to the host, and the run of pi on the host.
    connect: "The host could not be reached.",
    connect_timeout: "The host did not answer in time.",
    ssh: "The SSH handshake with the host failed.",
    auth: "The host would not accept who pie said it was.",
    auth_timeout: "The host never answered about who pie said it was.",
    ssh_key: "That private key could not be read.",
    host_key_rejected: "This host is not the machine you meant to reach.",
    spawn: "pi is not there, or could not be started.",
    exec: "The host would not run pi.",
    exec_timeout: "The host never answered about running pi.",
    subsystem: "The host would not open a channel to read files through.",
    subsystem_timeout: "The host never answered about a file channel.",
    version_probe: "pi would not say which release it is.",
    version_mismatch: "pi is not the release pie speaks.",
    // `pi_rpc::Error`: the protocol itself.
    rpc: "pi refused the command.",
    timeout: "pi did not answer in time.",
    payload: "pi answered in a way pie does not know.",
    encode: "Pie could not write a request pi understands.",
    closed: "The connection to pi ended.",
    no_runtime: "Pie could not reach its own runtime.",
    io: "The connection to pi failed.",
    // `connection::Error`: the connect of pie to the machine.
    already_connected: "pie is already connected to a host.",
    not_connected: "There is no connection.",
    remote_version: "pi on the host would not say which release it is.",
    unreadable_local: "That file could not be read. Another one may work.",
    unreadable_remote: "That file could not be read on the host. Another one may work.",
    sftp_unanswered: "The host would not open a channel to read files through.",
    not_absolute: "That path is not a path on the host.",
    no_home_directory: "This machine has no home directory to browse.",
    // `commands::Error`: what the IPC layer itself cannot do.
    unusable_name: "That name cannot be used for a connection.",
    no_host_key_store: "Pie cannot find where to keep host keys.",
};

/** The text for a failure with a name in the table above. */
const MODULE_REASON: Record<bridge.PieErrorModule, string> = {
    connection: "Something went wrong reaching the host.",
    commands: "Something on pie's own side went wrong.",
    rpc: "Something went wrong talking to pi.",
    io: "That file could not be read. Another one may work.",
};

/**
 * The action for a failure, in the words of the named variant.
 *
 * The two tables are a lookup. They do not decide the meaning of a failure. A
 * new variant of Rust without text uses the text of its module. The toast is
 * never empty.
 */
function reasonFor(failure: bridge.PieError): string {
    const named = failure.error ? FAILURE_REASON[failure.error.kind] : undefined;
    return named ?? MODULE_REASON[failure.type];
}

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
    const isMobile = useIsMobile();
    const [form, setForm] = useState(EMPTY_FORM);
    const [state, send] = useMachine(connectionMachine, { input: deps });

    // This is the one place where a ready connection causes another action.
    const reached = state.matches("connected");
    useEffect(() => {
        if (reached) navigate("/chat", { replace: true });
    }, [navigate, reached]);

    // A failed connect is announced, not shown on the form. The form did not
    // change. An inline line would be the only text about the attempt, not about
    // the connection. The toast also carries the name of the failure, which the
    // message from Rust does not carry.
    const failure = state.context.error;
    useEffect(() => {
        if (failure) toast.error(failure.message, { description: reasonFor(failure) });
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
            toast.error(failure.message, { description: reasonFor(failure) });
        }
    }, [pickPrivateKey]);

    return (
        <main
            id="connect-root"
            // `flex-1 min-h-0` and not a viewport height. The app shell owns the
            // height. On a desktop, the app shell already uses one row for the
            // title bar. A panel with the height of the screen would overflow the
            // window.
            className="flex min-h-0 w-full flex-1 flex-col overflow-hidden font-sans"
        >
            <Panel
                id="connect-stage"
                // The OS of a phone has no title bar. Therefore this panel is the
                // whole window. The title bar of a desktop window is a panel
                // itself.
                solo={isMobile}
                // Keeps the card away from the edge of the window on a phone. A
                // phone has no chrome to separate them.
                //
                // The panel does not scroll. The card has the height of the panel
                // and scrolls its own contents. A panel that scrolled would move
                // the top edge and the border of the card out of view.
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
                // Rust keeps one question open at a time. A new question replaces
                // the old question. Therefore a new fingerprint must start a new
                // prompt. If not, the keys of the old question stay on screen.
                key={state.context.hostKey?.fingerprint}
                presentedKey={state.context.hostKey}
                onAnswer={(trusted) => send({ type: "ANSWER_HOST_KEY", trusted })}
            />
        </main>
    );
}
