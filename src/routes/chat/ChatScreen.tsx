/**
 * The workspace: the transcript of a session, and what to do when there is none.
 *
 * The connection comes from Rust, because this screen outlives the machine that
 * opened it: a reload of the webview finds the same connection here.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { useConnection } from "@/hooks/use-connection";
import { useIsMobile } from "@/hooks/use-platform";
import { useWideWindow } from "@/hooks/use-wide-window";
import { useSession } from "@/hooks/use-session";
import { reasonFor } from "@/lib/failure-text";
import { UNFOLD, UNFOLD_HIDDEN, UNFOLD_SHOWN } from "@/lib/motion";
import * as bridge from "@/lib/bridge";
import { transcriptRows } from "@/lib/transcript";
import { TranscriptList } from "@/routes/chat/components/TranscriptList";
import { SessionDrawer } from "@/routes/chat/components/session/SessionDrawer";
import { SessionHeader } from "@/routes/chat/components/session/SessionHeader";
import { SessionSheet } from "@/routes/chat/components/session/SessionSheet";
import { FAILURE_REASON } from "@/routes/chat/failure-reason";
import { useTranscriptStore } from "@/stores/transcript.store";

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
            {/* The landing is the whole window, so it brings its own panel. A session
                brings its own too, and it is not always one: beside the transcript
                from `lg` the list is a second one. */}
            {connection.isPending ? null : session === null ? (
                <Panel id="chat-stage" solo={isMobile}>
                    <Landing disconnected={connection.isError || connection.data === null} idle={idle} />
                </Panel>
            ) : (
                <Session
                    session={session}
                    cwd={connection.data?.sessions[0]?.cwd ?? null}
                    endpoint={connection.data?.endpoint ?? "local"}
                />
            )}
        </main>
    );
}

function Session({ session, cwd, endpoint }: { session: string; cwd: string | null; endpoint: string }) {
    const wide = useWideWindow();
    const isMobile = useIsMobile();
    const still = useReducedMotion();
    const client = useQueryClient();
    const { state, snapshot, stats, listening, error, reopen, switchTo, switching } = useSession(session);
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

    // The drawer is which panel of the workspace the reader opened: pure UI, so it
    // lives here (`lg` it is the column; below that a sheet over the transcript).
    const [drawer, setDrawer] = useState(false);
    const currentSessionId = state.data?.sessionId ?? null;
    const working = state.data?.isStreaming ?? false;

    /**
     * Continues the conversation of the row that was chosen.
     *
     * The sheet closes before the switch is answered: a host across a network can take
     * a moment, and meanwhile the transcript says that it is opening the session.
     */
    function pick(path: string) {
        if (working || switching) return;
        setDrawer(false);
        void switchTo(path).catch((thrown: unknown) => {
            toast.error(reasonFor(bridge.asPieError(thrown), FAILURE_REASON));
        });
    }

    const drawerProps = { endpoint, currentSessionId, working, busy: working || switching, onPick: pick };
    const header = (
        <SessionHeader
            id="session-header"
            name={state.data?.sessionName ?? null}
            cwd={cwd}
            stats={stats.data ?? null}
            auto={state.data?.autoCompactionEnabled ?? false}
            onOpenSessions={() => setDrawer(true)}
        />
    );

    // What stands under the header: the transcript, or why there is none. An empty
    // one is not yet a fact while the listeners are opening or while a switch is
    // having the next conversation read. `switching`, not `isFetching`: a read that
    // an event asked for also fetches, and a transcript on screen beats a sentence.
    let content: ReactNode;
    if (failure !== null) {
        content = (
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
    } else if (!listening || snapshot.isPending || switching) {
        content = <p className="text-body-md text-muted-foreground m-auto">Opening the session…</p>;
    } else if (rows.length === 0) {
        // Pi writes a model and a thinking level into a new session before anything
        // is said; nothing of that is a message, so its transcript is empty.
        content = (
            <p className="text-body-md text-muted-foreground m-auto px-6 text-center">Nothing has been said yet.</p>
        );
    } else {
        content = <TranscriptList rows={rows} />;
    }

    return (
        <div id="chat-workspace" className="flex min-h-0 w-full flex-1">
            {/* A panel of its own from `lg`, and it unfolds: the transcript gives the
                room up as the column takes it. Below `lg` it is not mounted at all -
                a hidden column still subscribes, so a phone would read the host's
                sessions for nothing. */}
            <AnimatePresence initial={false}>
                {wide && (
                    <motion.div
                        id="session-reveal"
                        key="session-list"
                        className="flex min-h-0 flex-none overflow-hidden"
                        initial={UNFOLD_HIDDEN}
                        animate={UNFOLD_SHOWN}
                        exit={UNFOLD_HIDDEN}
                        transition={still ? { duration: 0 } : UNFOLD}
                    >
                        <Panel id="session-panel" className="bg-surface-dim w-64 flex-none">
                            <SessionDrawer id="session-drawer" {...drawerProps} className="flex-1" />
                        </Panel>
                    </motion.div>
                )}
            </AnimatePresence>
            <Panel id="chat-stage" solo={isMobile && !wide}>
                {header}
                {content}
            </Panel>
            <SessionSheet id="session-sheet" open={drawer} onOpenChange={setDrawer}>
                <SessionDrawer id="session-sheet-drawer" {...drawerProps} className="h-full" />
            </SessionSheet>
        </div>
    );
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
        <div id="chat-landing" className="m-auto flex flex-col items-center justify-center gap-3 p-6 text-center">
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
