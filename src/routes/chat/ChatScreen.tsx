import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import { Button } from "@/components/ui";
import { useAttachedConversations } from "@/hooks/use-attached-conversations";
import { useConnection } from "@/hooks/use-connection";
import { useMotion } from "@/hooks/use-motion";
import { useWideWindow } from "@/hooks/use-wide-window";

import { chatMachine, errorOf, pathOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";
import * as bridge from "@/lib/bridge";
import { sessionOf as chartOf, subscribeSessions } from "@/lib/sessions";
import { ChatFrame } from "@/routes/chat/ChatFrame";
import { ChatTopbar } from "@/routes/chat/ChatTopbar";
import { SessionLanding } from "@/routes/chat/SessionLanding";
import { SessionSidebar } from "@/routes/chat/sidebar/SessionSidebar";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";
import { SessionSlots } from "@/routes/chat/topbar/SessionSlots";
import { SessionMain } from "@/routes/chat/SessionMain";

/** The page fills the column the frame gives it, and nothing of it scrolls as a whole. */
const COLUMN = "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";

export function ChatScreen() {
    const connection = useConnection();
    const client = useQueryClient();
    const wide = useWideWindow();
    const navigate = useNavigate();
    const { stage: pageOf } = useMotion();

    const deps = useMemo<ChatDeps>(
        () => ({
            attach: async (path) => {
                const info = await bridge.attachSession(path ?? undefined);
                await client.invalidateQueries({ queryKey: ["connection"] });
                return info;
            },
            detach: async (session) => {
                await bridge.detachSession(session);
                await client.invalidateQueries({ queryKey: ["connection"] });
            },
        }),
        [client],
    );
    const [chat, , machine] = useMachine(chatMachine, { input: deps });
    const stage = stageOf(chat);
    const session = sessionOf(chat);
    const loading = pathOf(chat);
    const detached = errorOf(chat);
    // Every session the connection holds runs its own process, and any of them may hold the
    // conversation of a row: the match is what a pick and the list light read.
    const sessions = connection.data?.sessions ?? [];
    const endpoint = connection.data?.endpoint ?? "local";
    const attached = useAttachedConversations(sessions);
    // The chart of the session in view, for the bar's own slots: the registry holds it, and a
    // screen only selects it.
    const chart = useSyncExternalStore(
        subscribeSessions,
        () => (session === null ? null : chartOf(session)),
        () => null,
    );
    const cwd = sessions.find((running) => running.id === session)?.cwd ?? null;

    // A workspace with no host is not a workspace: the gate is where a connection is made,
    // so the window returns to it rather than sit on a page no command can answer. The read
    // is fresh on every mount (`connectionQueries.current`), so this is also where a reload
    // that finds the connection gone lands.
    useEffect(() => {
        if (connection.isPending || connection.isFetching) return;
        if (connection.data !== null && connection.data !== undefined) return;
        bridge.log.info("the workspace has no connection, so the window returns to the gate", {
            reason: connection.isError ? bridge.asPieError(connection.error).message : "no connection is held",
        });
        navigate("/", { replace: true });
    }, [connection.isPending, connection.isFetching, connection.data, connection.isError, connection.error, navigate]);

    // The sheet is a narrow window's way to the list; the column is a wide one's.
    // Pure UI, so the two live here, above both stages that draw a list.
    const [sheet, setSheet] = useState(false);
    const [column, setColumn] = useState(true);
    const toggleSessions = () => (wide ? setColumn((open) => !open) : setSheet(true));

    // Which stage the window reached, and for which conversation: the shape of a report
    // about a window that would not open, where nothing else on this side of the boundary
    // says how far it got.
    useEffect(() => {
        bridge.log.info("the window is at a stage", { stage, session });
    }, [stage, session]);

    /**
     * Opens a conversation from a list, for the landing and for the sidebar.
     *
     * The session that already holds the file is the one to show; without one, another session
     * is attached on it. A session is one process with one conversation, and the sessions that
     * are not in view keep running: only a close ends one.
     */
    function open(path: string) {
        setSheet(false);
        const held = attached.get(path);
        if (held !== undefined) {
            if (held.session === session) return;
            bridge.log.info("the conversation is held by a session already", { path, session: held.session });
            machine.send({ type: "OPEN", session: held.session });
            return;
        }
        bridge.log.info("a conversation was picked", { path, sessions: sessions.length });
        machine.send({ type: "FOCUS", path });
    }

    if (connection.isPending)
        return (
            <ChatFrame>
                <ChatTopbar />
            </ChatFrame>
        );
    if (connection.data === null || connection.data === undefined)
        return (
            <ChatFrame>
                <ChatTopbar />
            </ChatFrame>
        );

    const expanded = wide ? column : undefined;
    // The bar belongs to the window, and so does the list: the way to the list and the
    // window's own keys stand still for every stage and every conversation. What changes is
    // the region under the bar and the session's own slots in it - its name and its context -
    // and the region that is leaving goes first (`mode="wait"`).
    const page = session !== null && stage === "viewing" ? `${stage}:${session}` : stage;
    return (
        <ChatFrame
            sidebar={
                <SessionSidebar
                    id="session"
                    endpoint={endpoint}
                    attached={attached}
                    onPick={open}
                    wide={wide}
                    column={column}
                    sheet={sheet}
                    onOpenSheet={setSheet}
                />
            }
        >
            {/* The bar is the window's: only the conversation's own slots in it change. */}
            <ChatTopbar>
                <SidebarToggle expanded={expanded} onToggleSessions={toggleSessions} />
                {/* A conversation that is on its way has nothing to say about itself: its slots
                    arrive with its words, and the bar keeps the window's own keys until then. */}
                {stage === "viewing" && chart !== null && session !== null && (
                    <SessionSlots session={session} machine={chart} cwd={cwd} />
                )}
            </ChatTopbar>
            <AnimatePresence mode="wait" initial={false}>
                <motion.div id="session-page" key={page} {...pageOf} className={COLUMN}>
                    {body()}
                </motion.div>
            </AnimatePresence>
        </ChatFrame>
    );

    function body() {
        if (stage === "attaching") {
            return (
                <div className="relative flex min-h-0 flex-1 items-center justify-center">
                    <SessionLoading label={loading === null ? "Starting pi…" : "Opening the conversation…"} />
                </div>
            );
        }

        if (stage === "unattached" && detached !== null) {
            return (
                <div
                    id="chat-unattached"
                    role="alert"
                    className="text-body-md text-muted-foreground m-auto flex max-w-prose flex-col items-center gap-3 px-6 text-center"
                >
                    <p>{detached.message}</p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => machine.send({ type: "RETRY" })}>
                            Try again
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                            <Link to="/">Connect</Link>
                        </Button>
                    </div>
                </div>
            );
        }

        if (stage === "viewing" && session !== null) {
            return <SessionMain session={session} client={client} />;
        }

        return <SessionLanding />;
    }
}
