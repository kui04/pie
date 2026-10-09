/**
 * The workspace: the transcript of a session, and what to do when there is none.
 *
 * The connection comes from Rust, because this screen outlives the machine that
 * opened it: a reload of the webview finds the same connection here.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Window } from "@/components/Window";
import { useConnection } from "@/hooks/use-connection";
import { useWideWindow } from "@/hooks/use-wide-window";
import { useSession } from "@/hooks/use-session";
import { reasonFor } from "@/lib/failure-text";
import { CONTENT_COLUMN } from "@/routes/chat/content-column";
import { UNFOLD, UNFOLD_HIDDEN, UNFOLD_SHOWN } from "@/lib/motion";
import * as bridge from "@/lib/bridge";
import { transcriptRows, queuedRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/stream";
import { withLiveUsage } from "@/routes/chat/components/session/session";
import { TranscriptList } from "@/routes/chat/components/TranscriptList";
import { Composer } from "@/routes/chat/components/composer/Composer";
import { SessionDrawer } from "@/routes/chat/components/session/SessionDrawer";
import { SessionHeader } from "@/routes/chat/components/session/SessionHeader";
import { SessionSheet } from "@/routes/chat/components/session/SessionSheet";
import { FAILURE_REASON } from "@/routes/chat/failure-reason";
import { useTranscriptStore } from "@/stores/transcript.store";

export function ChatScreen() {
    const connection = useConnection();
    // A connection holds one session, so the one in the list is the one.
    const session = connection.data?.sessions[0]?.id ?? null;
    // A connection with no session of its own is not a disconnected one: the
    // landing page says so rather than offering a way that leads nowhere.
    const idle = connection.data !== null && connection.data !== undefined && session === null;

    if (connection.isPending) return <Window />;
    if (session === null) {
        return (
            <Window>
                <Landing disconnected={connection.isError || connection.data === null} idle={idle} />
            </Window>
        );
    }
    return (
        <Session
            // Another session is another screen: the run state of a session, its queue
            // and its live command are per-session state, and a remount is what gives
            // them to it (`useSession`).
            key={session}
            session={session}
            cwd={connection.data?.sessions[0]?.cwd ?? null}
            endpoint={connection.data?.endpoint ?? "local"}
        />
    );
}

function Session({ session, cwd, endpoint }: { session: string; cwd: string | null; endpoint: string }) {
    const wide = useWideWindow();
    const still = useReducedMotion();
    const client = useQueryClient();
    const { machine, state, snapshot, stats, listening, error, reopen, switchTo, switching } = useSession(session);
    // The failure may be the subscription itself, which no cache holds.
    const retry = () => {
        reopen();
        void client.invalidateQueries({ queryKey: ["connection"] });
        void client.invalidateQueries({ queryKey: ["session", session] });
    };
    const entries = useTranscriptStore((state) => state.entries);
    const order = useTranscriptStore((state) => state.order);
    const leafId = useTranscriptStore((state) => state.leafId);
    const queued = useTranscriptStore((state) => state.queued);
    const live = useTranscriptStore((state) => state.live);
    const liveUsage = useTranscriptStore((state) => state.liveUsage);
    // The run state comes from the session machine, not from the state read: a read
    // is a round trip behind, and the composer answers a key with it.
    const working = useSelector(machine, (snapshot) => snapshot.matches("working"));
    const rowIds = useTranscriptStore((state) => state.rowIds);

    // The fold runs when the entries change, which is once per event and once per
    // read: the store copies its map on every append, so the map's identity is the
    // event's, and a render that changed nothing else pays for neither. The messages
    // of the run that go on right now follow the entries, and the messages that wait
    // are rows of the same thread: the page hangs them below the working row, and they
    // scroll with it.
    const rows = useMemo(
        () => [
            ...transcriptRows({ entries, order }, leafId, rowIds),
            ...liveRows(live),
            ...activityRows(working, live),
            ...queuedRows(queued),
        ],
        [entries, order, leafId, rowIds, live, working, queued],
    );

    // The composer band covers the foot of the stage. The pane measures it and the
    // transcript pads itself by that height, so no row hides behind the card (the
    // design's `_ComposerBand`). The first frame has no measurement yet; nine rem is
    // the design's own stand-in.
    const band = useRef<HTMLDivElement>(null);
    const [clearance, setClearance] = useState(9 * 16);
    const composerOn = listening && error === null && !switching;

    // Two kinds of failure reach this screen: the listeners never opened, which the
    // hook reports, and a read, which the query holds. They are read in that order.
    const failure = error ?? snapshot.error ?? state.error ?? stats.error;

    // The sheet is a narrow window's way to the list; the column is a wide one's.
    // Pure UI, so the two live here.
    const [sheet, setSheet] = useState(false);
    const [column, setColumn] = useState(true);
    const currentSessionId = state.data?.sessionId ?? null;
    useEffect(() => {
        const element = band.current;
        // A pane in a test environment lays nothing out and has no observer; the
        // stand-in of the first frame stays, which is the design's own fallback.
        if (!element || typeof ResizeObserver === "undefined") return;
        const measure = () => {
            const height = element.getBoundingClientRect().height;
            if (height > 0) setClearance(height);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [composerOn]);

    /** Drops every queued message, and says how many went: pi cannot take back one. */
    function retractQueue() {
        void bridge
            .clearQueue(session)
            .then((dropped) => {
                const count = dropped.steering.length + dropped.followUp.length;
                toast(count === 1 ? "The queued message was dropped." : `${count} queued messages were dropped.`);
            })
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    }

    /**
     * Continues the conversation of the row that was chosen.
     *
     * The sheet closes before the switch is answered: a host across a network can take
     * a moment, and meanwhile the transcript says that it is opening the session.
     */
    function pick(path: string) {
        if (working || switching) return;
        setSheet(false);
        void switchTo(path).catch((thrown: unknown) => {
            toast.error(reasonFor(bridge.asPieError(thrown), FAILURE_REASON));
        });
    }

    const drawerProps = { endpoint, currentSessionId, working, busy: working || switching, onPick: pick };
    const toggleSessions = () => (wide ? setColumn((open) => !open) : setSheet(true));

    // What stands under the bar: the transcript, or why there is none. An empty
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
        content = <TranscriptList rows={rows} clearance={clearance} onRetractQueued={retractQueue} />;
    }

    return (
        <>
            <Window
                sidebar={
                    // The list is a column of the window from `lg`, and not mounted below
                    // it: a hidden column still subscribes, so a phone would read the
                    // host's sessions for nothing. The bar's key closes it, and the column
                    // keeps its own width while the window clips it open.
                    <AnimatePresence initial={false}>
                        {wide && column && (
                            <motion.div
                                id="sidebar"
                                key="session-list"
                                className="bg-surface-dim border-border flex min-h-0 flex-none flex-col overflow-hidden border-r"
                                initial={UNFOLD_HIDDEN}
                                animate={UNFOLD_SHOWN}
                                exit={UNFOLD_HIDDEN}
                                transition={still ? { duration: 0 } : UNFOLD}
                            >
                                <SessionDrawer id="session-drawer" {...drawerProps} className="w-64 flex-1" />
                            </motion.div>
                        )}
                    </AnimatePresence>
                }
                topbar={
                    <SessionHeader
                        name={state.data?.sessionName ?? null}
                        cwd={cwd}
                        stats={withLiveUsage(stats.data ?? null, liveUsage)}
                        auto={state.data?.autoCompactionEnabled ?? false}
                        expanded={wide ? column : undefined}
                        onToggleSessions={toggleSessions}
                    />
                }
                // The band is placed against the foot of the body, so the body is what
                // it is positioned in. The body itself is the whole region - the
                // transcript scrolls it edge to edge, bar and all - and only what is
                // drawn inside it is capped to the content column.
                bodyClassName="relative"
            >
                {content}
                {composerOn && (
                    // The composer covers the foot of the chat. The transcript keeps room
                    // for its whole height (measured above), so no row hides behind it.
                    <div
                        id="composer-band"
                        ref={band}
                        className={cn("absolute inset-x-0 bottom-0 z-10 py-2", CONTENT_COLUMN)}
                    >
                        <Composer session={session} machine={machine} />
                    </div>
                )}
            </Window>
            <SessionSheet id="session-sheet" open={sheet} onOpenChange={setSheet}>
                <SessionDrawer id="session-sheet-drawer" {...drawerProps} className="h-full" />
            </SessionSheet>
        </>
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
