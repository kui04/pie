/**
 * The main region of a session: the bar above the words, the transcript, and the composer
 * under it — and the list beside them, where the window holds a column.
 *
 * The chart of the session lives in the registry (`lib/sessions.ts`): this screen holds one
 * hand on it while it is on screen, and reads the transcript as the fold of the base read
 * and the records that arrived after it (`lib/transcript-merge.ts`).
 */

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { QueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useSession } from "@/hooks/use-session";
import * as bridge from "@/lib/bridge";
import { sessionKeys } from "@/lib/query";
import { ensureSession, forgetSession, sessionOf, subscribeSessions, type SessionRef } from "@/lib/sessions";
import { queuedRows, transcriptRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/stream";
import { mergedTranscript } from "@/lib/transcript-merge";
import { ChatFrame } from "@/routes/chat/ChatFrame";
import { Composer } from "@/routes/chat/composer/Composer";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SessionSidebar } from "@/routes/chat/sidebar/SessionSidebar";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { withLiveUsage } from "@/routes/chat/topbar/usage";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

export interface SessionMainProps {
    session: string;
    cwd: string | null;
    endpoint: string;
    wide: boolean;
    column: boolean;
    sheet: boolean;
    onOpenSheet: (open: boolean) => void;
    onToggleSessions: () => void;
    /** A conversation of the list was chosen: the chat chart attaches a session on it. */
    onFocus: (path: string) => void;
    client: QueryClient;
}

/**
 * The slot of one session: it holds the chart of the registry for as long as the screen
 * shows it, and hands the body the actor. The body is rendered only when the chart is
 * there, so its hooks are unconditional.
 */
export function SessionMain(props: SessionMainProps) {
    const { session, client } = props;
    useEffect(() => {
        ensureSession(session, client);
        return () => forgetSession(session);
    }, [session, client]);
    const machine = useSyncExternalStore(
        subscribeSessions,
        () => sessionOf(session),
        () => null,
    );
    if (machine === null) {
        return (
            <ChatFrame>
                <div className="relative flex min-h-0 flex-1">
                    <SessionLoading />
                </div>
            </ChatFrame>
        );
    }
    return <SessionBody {...props} machine={machine} />;
}

function SessionBody({
    machine,
    session,
    cwd,
    endpoint,
    wide,
    column,
    sheet,
    onOpenSheet,
    onToggleSessions,
    onFocus,
    client,
}: SessionMainProps & { machine: SessionRef }) {
    const { phase, working, state, entries, stats, ready, listening, error, reopen } = useSession(session, machine);
    const still = useReducedMotion();
    const overlay = useSelector(machine, (snapshot) => snapshot.context.overlay);
    const live = useSelector(machine, (snapshot) => snapshot.context.live);
    const queued = useSelector(machine, (snapshot) => snapshot.context.queued);
    const rowIds = useSelector(machine, (snapshot) => snapshot.context.rowIds);
    const liveUsage = useSelector(machine, (snapshot) => snapshot.context.usage);

    // The transcript is the base read and the records folded together, then the rows the
    // run writes now, the line under it, and the queue. The settled half is recomputed
    // only when the base or the overlay changes, not on every delta.
    const base = entries.data ?? null;
    const merged = useMemo(() => mergedTranscript(base, overlay), [base, overlay]);
    const settled = useMemo(() => transcriptRows(merged, merged.leaf, rowIds), [merged, rowIds]);
    const moving = useMemo(
        () => [...liveRows(live), ...activityRows(phase), ...queuedRows(queued)],
        [live, phase, queued],
    );
    const rows = useMemo(() => [...settled, ...moving], [settled, moving]);

    // The words of a conversation are on screen when its base read answered. A chart that
    // outlived the cache of an earlier screen can be ready with no base in hand; the view
    // then waits for the answer instead of painting the overlay alone.
    const loaded = ready && base !== null;
    const composerOn = loaded && error === null;
    const empty = loaded && rows.length === 0;

    // Two kinds of failure reach this screen: the listeners never opened, which the chart
    // reports, and a read, which the query holds. They are read in that order.
    const failure = error ?? entries.error ?? state.error ?? stats.error;

    const currentSessionId = state.data?.sessionId ?? null;

    const retry = () => {
        reopen();
        void client.invalidateQueries({ queryKey: ["connection"] });
        void client.invalidateQueries({ queryKey: sessionKeys.whole(session) });
    };

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
     * Opens the conversation of the row that was chosen.
     *
     * A session holds one conversation, so this is not a switch: the chat chart attaches a
     * session on the file and ends the one in view when the new one answers.
     */
    function pick(path: string) {
        if (!listening || working) {
            bridge.log.debug("a pick was not taken", { path, listening, working });
            return;
        }
        onOpenSheet(false);
        if (path === state.data?.sessionFile) {
            bridge.log.debug("a pick was already the open conversation", { path });
            return;
        }
        bridge.log.info("a conversation was picked", { path });
        onFocus(path);
    }

    const transcript = <SessionTranscript rows={rows} onRetractQueued={retractQueue} />;
    const leaving = still ? { duration: 0 } : ({ type: "tween", duration: 0.22, ease: [0.2, 0, 0, 1] } as const);
    let content: ReactNode;
    if (failure !== null) {
        content = (
            <motion.div
                key="failure"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={leaving}
                className="flex min-h-0 flex-1"
            >
                <div
                    id="chat-failure"
                    role="alert"
                    className="text-body-md text-muted-foreground m-auto flex max-w-prose flex-col items-center gap-3 px-6 text-center"
                >
                    <p>{bridge.asPieError(failure).message}</p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={retry}>
                            Try again
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                            <Link to="/">Connect</Link>
                        </Button>
                    </div>
                </div>
            </motion.div>
        );
    } else if (!loaded) {
        content = (
            <motion.div
                key="loading"
                initial={false}
                exit={{ opacity: 0 }}
                transition={leaving}
                className="relative flex min-h-0 flex-1"
            >
                <SessionLoading />
            </motion.div>
        );
    } else if (rows.length === 0) {
        content = null;
    } else {
        content = (
            <motion.div
                key="words"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={leaving}
                className="flex min-h-0 flex-1"
            >
                {transcript}
            </motion.div>
        );
    }

    return (
        <ChatFrame
            sidebar={
                <SessionSidebar
                    id="session"
                    endpoint={endpoint}
                    currentSessionId={currentSessionId}
                    working={working}
                    busy={!listening || working}
                    onPick={pick}
                    wide={wide}
                    column={column}
                    sheet={sheet}
                    onOpenSheet={onOpenSheet}
                />
            }
            topbar={
                <SessionTopbar
                    name={state.data?.sessionName ?? null}
                    cwd={cwd}
                    stats={withLiveUsage(stats.data ?? null, liveUsage?.usage ?? null)}
                    auto={state.data?.autoCompactionEnabled ?? false}
                    expanded={wide ? column : undefined}
                    onToggleSessions={onToggleSessions}
                    ready={loaded}
                />
            }
        >
            <AnimatePresence mode="wait" initial={false}>
                {content}
            </AnimatePresence>
            <AnimatePresence initial={false}>
                {composerOn && (
                    <motion.div
                        id="composer-band"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={leaving}
                        className="my-2 mt-auto flex shrink-0 items-center justify-center"
                    >
                        {/* The composer's box and the transcript's content share one
                            line, so its corner curves over exactly where the transcript
                            ends on a curve of the same 8px (`rounded-b-lg` there). */}
                        <div className="mx-auto w-full max-w-5xl px-4">
                            {empty && (
                                <p className="text-body-md text-muted-foreground pb-3 text-center">
                                    Nothing has been said yet.
                                </p>
                            )}
                            <Composer session={session} working={working} machine={machine} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </ChatFrame>
    );
}
