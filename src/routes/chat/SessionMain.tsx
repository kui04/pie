/**
 * The main region of a session: the bar above the words, the transcript, and the composer
 * under it.
 *
 * The chart of the session lives in the registry (`lib/sessions.ts`), which follows the
 * sessions of the connection: this region selects it and never creates it. The transcript is
 * the fold of the base read and the records that arrived after it (`lib/transcript-merge.ts`).
 *
 * The list and the window's frame belong to the workspace (`ChatScreen`), so a pick rebuilds
 * this region alone.
 */

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { QueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useSession } from "@/hooks/use-session";
import * as bridge from "@/lib/bridge";
import { sessionKeys } from "@/lib/query";
import { sessionOf, subscribeSessions, type SessionRef } from "@/lib/sessions";
import { queuedRows, transcriptRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/stream";
import { mergedTranscript } from "@/lib/transcript-merge";
import { ChatTopbar } from "@/routes/chat/ChatTopbar";
import { Composer } from "@/routes/chat/composer/Composer";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";
import { withLiveUsage } from "@/routes/chat/topbar/usage";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

export interface SessionMainProps {
    session: string;
    /** Where pi of this session started, for a session pi has no name for. */
    cwd: string | null;
    /** Whether the list is out beside the chat; undefined where it is a sheet. */
    expanded: boolean | undefined;
    onToggleSessions: () => void;
    client: QueryClient;
}

/**
 * The slot of one session: it selects the chart of the registry and hands the body that actor.
 * The body is rendered only when the chart is there, so its hooks are unconditional.
 */
export function SessionMain(props: SessionMainProps) {
    const { session } = props;
    const machine = useSyncExternalStore(
        subscribeSessions,
        () => sessionOf(session),
        () => null,
    );
    if (machine === null) {
        // The registry has the charts of the connection, and this session is one of them;
        // this is the frame or two before it arrived.
        return (
            <>
                <ChatTopbar>
                    <SidebarToggle expanded={props.expanded} onToggleSessions={props.onToggleSessions} />
                </ChatTopbar>
                <div className="relative flex min-h-0 flex-1">
                    <SessionLoading />
                </div>
            </>
        );
    }
    return <SessionBody {...props} machine={machine} />;
}

function SessionBody({
    machine,
    session,
    cwd,
    expanded,
    onToggleSessions,
    client,
}: SessionMainProps & { machine: SessionRef }) {
    const { phase, working, state, entries, stats, ready, error, reopen } = useSession(session, machine);
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
        <>
            <ChatTopbar>
                <SessionTopbar
                    name={state.data?.sessionName ?? null}
                    cwd={cwd}
                    stats={withLiveUsage(stats.data ?? null, liveUsage?.usage ?? null)}
                    auto={state.data?.autoCompactionEnabled ?? false}
                    expanded={expanded}
                    onToggleSessions={onToggleSessions}
                    ready={loaded}
                />
            </ChatTopbar>
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
        </>
    );
}
