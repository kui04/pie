/**
 * The workspace: the transcript of a session, and what to do when there is none.
 *
 * The connection comes from Rust, because this screen outlives the machine that
 * opened it: a reload of the webview finds the same connection here.
 */

import { useMemo } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { useConnection } from "@/hooks/use-connection";
import { useIsMobile } from "@/hooks/use-platform";
import { useSession } from "@/hooks/use-session";
import { reasonFor, type FailureText } from "@/lib/failure-text";
import * as bridge from "@/lib/bridge";
import { transcriptRows } from "@/lib/transcript";
import { TranscriptList } from "@/routes/chat/components/TranscriptList";
import { useTranscriptStore } from "@/stores/transcript.store";

/**
 * The words of this screen for the failures it can meet.
 *
 * The names of the IPC layer are here as well: Rust holds the union of the screens'
 * tables against its own enums (`tests/failure_kinds.rs`), and this is the only
 * other screen.
 */
const FAILURE_REASON: FailureText = {
    // `connection::Error`: which session a screen asked for.
    unknown_session: "That session is gone from this connection. Connect again.",
    not_connected: "There is no connection.",
    // `pi_rpc::Error`: the reads behind the transcript.
    closed: "The connection to pi ended.",
    timeout: "pi did not answer in time.",
    rpc: "pi refused the command.",
    payload: "pi answered in a way pie does not know.",
    io: "The connection to pi failed.",
    no_runtime: "Pie could not reach its own runtime.",
    // `commands::Error`: the IPC layer itself.
    unusable_name: "That name cannot be used for a connection.",
    no_host_key_store: "Pie cannot find where to keep host keys.",
    unopenable_url: "That link is not one pie opens.",
    open_failed: "The machine would not open that link.",
};

export function ChatScreen() {
    const isMobile = useIsMobile();
    const connection = useConnection();
    // A connection holds one session, so the one in the list is the one.
    const session = connection.data?.sessions[0]?.id ?? null;
    // A connection with no session of its own is not a disconnected one: the
    // landing page says so rather than offering a way that leads nowhere.
    const idle = connection.data !== null && connection.data !== undefined && session === null;

    return (
        <main id="chat-root" className="text-foreground flex min-h-0 w-full flex-1 flex-col overflow-hidden font-sans">
            <Panel id="chat-stage" solo={isMobile} className="justify-center">
                {connection.isPending ? null : session === null ? (
                    <Landing disconnected={connection.isError || connection.data === null} idle={idle} />
                ) : (
                    <Session session={session} />
                )}
            </Panel>
        </main>
    );
}

function Session({ session }: { session: string }) {
    const client = useQueryClient();
    const { state, snapshot, stats, listening, error, reopen } = useSession(session);
    // The failure may be the subscription itself, which no cache holds.
    const retry = () => {
        reopen();
        void client.invalidateQueries({ queryKey: ["connection"] });
        void client.invalidateQueries({ queryKey: ["session", session] });
    };
    const entries = useTranscriptStore((state) => state.entries);
    const order = useTranscriptStore((state) => state.order);
    const leafId = useTranscriptStore((state) => state.leafId);

    // The fold runs when the entries change, which is once per event and once per
    // read: the store copies its map on every append, so the map's identity is the
    // event's, and a render that changed nothing else pays for neither.
    const rows = useMemo(() => transcriptRows({ entries, order }, leafId), [entries, order, leafId]);

    // Two kinds of failure reach this screen: the listeners never opened, which the
    // hook reports, and a read, which the query holds. They are read in that order.
    const failure = error ?? snapshot.error ?? state.error ?? stats.error;
    if (failure !== null) {
        return (
            <div
                id="chat-failure"
                role="alert"
                className="text-body-md text-muted-foreground m-auto flex max-w-prose flex-col items-center gap-3 px-6 text-center"
            >
                <p>{reasonFor(bridge.asPieError(failure), FAILURE_REASON)}</p>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={retry}>
                        Try again
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                        <Link to="/">Connect</Link>
                    </Button>
                </div>
            </div>
        );
    }
    // An empty transcript is not yet a fact while the first read is on its way.
    if (!listening || snapshot.isPending) {
        return <p className="text-body-md text-muted-foreground m-auto">Opening the session…</p>;
    }
    if (rows.length === 0) {
        // Pi writes a model and a thinking level into a new session before anything
        // is said; nothing of that is a message, so its transcript is empty.
        return <p className="text-body-md text-muted-foreground m-auto px-6 text-center">Nothing has been said yet.</p>;
    }
    return <TranscriptList rows={rows} />;
}

/**
 * What the screen shows when there is no session to read.
 *
 * A window may be here with no connection at all, which is what a reload of this
 * route leaves behind. Then the gate is offered, because this route has no way
 * back to it.
 */
function Landing({ disconnected, idle }: { disconnected: boolean; idle: boolean }) {
    return (
        <div id="chat-landing" className="flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-title-lg text-foreground font-medium">pie</p>
            <p className="text-body-md text-muted-foreground">
                {idle ? "This connection has no session yet" : "Open a session"}
            </p>
            {disconnected && (
                <>
                    <p className="text-body-sm text-muted-foreground">This window is not connected to a host.</p>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/">Connect</Link>
                    </Button>
                </>
            )}
        </div>
    );
}
