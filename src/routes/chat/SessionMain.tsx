/**
 * The main region of a session: the bar above the words, the transcript, and the
 * composer under it — and the list beside them, where the window holds a column.
 *
 * This subtree holds the reads of one conversation (`useSession`): the shape of its
 * feed, its run and its queue. The screen mounts it per session (`ChatScreen`), so a
 * session is another mount.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { QueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useSession } from "@/hooks/use-session";
import { chatMachine, stageOf } from "@/machines/chat.machine";
import * as bridge from "@/lib/bridge";
import { queuedRows, transcriptRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/stream";
import { ChatFrame } from "@/routes/chat/ChatFrame";
import { Composer } from "@/routes/chat/composer/Composer";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SessionSidebar } from "@/routes/chat/sidebar/SessionSidebar";
import { SessionTopbar } from "@/routes/chat/topbar/SessionTopbar";
import { withLiveUsage } from "@/routes/chat/topbar/usage";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";
import { useTranscriptStore } from "@/stores/transcript.store";

export interface SessionMainProps {
    /** The chart of the screen: this subtree is what hears its reads answer. */
    machine: ActorRefFrom<typeof chatMachine>;
    session: string;
    cwd: string | null;
    endpoint: string;
    wide: boolean;
    column: boolean;
    sheet: boolean;
    onOpenSheet: (open: boolean) => void;
    onToggleSessions: () => void;
    client: QueryClient;
}

export function SessionMain({
    machine,
    session,
    cwd,
    endpoint,
    wide,
    column,
    sheet,
    onOpenSheet,
    onToggleSessions,
    client,
}: SessionMainProps) {
    const { phase, working, state, snapshot, stats, listening, error, reopen, switchTo, switching } =
        useSession(session);
    const still = useReducedMotion();
    const stage = useSelector(machine, stageOf);
    const loaded = stage === "loaded";
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
    const rowIds = useTranscriptStore((state) => state.rowIds);

    const rows = useMemo(
        () => [
            ...transcriptRows({ entries, order }, leafId, rowIds),
            ...liveRows(live),
            ...activityRows(phase),
            ...queuedRows(queued),
        ],
        [entries, order, leafId, rowIds, live, phase, queued],
    );

    const composerOn = loaded && error === null;
    const empty = loaded && rows.length === 0;
    const arrived = listening && !switching && !snapshot.isPending;
    useEffect(() => {
        if (arrived) machine.send({ type: "ARRIVED" });
    }, [arrived, machine]);

    // Two kinds of failure reach this screen: the listeners never opened, which the
    // hook reports, and a read, which the query holds. They are read in that order.
    const failure = error ?? snapshot.error ?? state.error ?? stats.error;

    const currentSessionId = state.data?.sessionId ?? null;

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
        // While the feed is opening or has failed there is no conversation to leave:
        // the switch would reach Rust and the chart would drop its answer. The rows of
        // the list are disabled for the same reason (`busy` below).
        if (!listening || working || switching) {
            bridge.log.debug("a pick was not taken", { path, listening, working, switching });
            return;
        }
        onOpenSheet(false);
        // The conversation that is on screen is not opened a second time: pi reloads
        // the file it is asked for even when it already holds it, and the window
        // would empty itself for the read it did not need (`switchSession`).
        if (path === state.data?.sessionFile) {
            bridge.log.debug("a pick was already the open conversation", { path });
            return;
        }
        bridge.log.info("a conversation was picked", { path });
        machine.send({ type: "SWITCH" });
        void switchTo(path).catch((thrown: unknown) => {
            const error = bridge.asPieError(thrown);
            bridge.log.error("the switch failed", { path, reason: error.message });
            toast.error(error.message);
        });
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
                    busy={!listening || working || switching}
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
                        {/* The composer's box stands 8px outside the transcript's
                            content line on each side (`px-4` there), which is where
                            its own 8px corner ends. */}
                        <div className="mx-2 w-full max-w-5xl">
                            {empty && (
                                <p className="text-body-md text-muted-foreground pb-3 text-center">
                                    Nothing has been said yet.
                                </p>
                            )}
                            <Composer session={session} working={working} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </ChatFrame>
    );
}
