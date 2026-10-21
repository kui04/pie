import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import { Button } from "@/components/ui";
import { connectionQueries, sessionQueries } from "@/lib/query";
import { useMotion, useWindowSize } from "@/hooks";

import { chatMachine, errorOf, pathOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";
import * as bridge from "@/lib/bridge";
import { phases, sessionOf as chartOf, subscribeSessions } from "@/lib/session";
import { ChatFrame } from "@/routes/chat/ChatFrame";
import { ChatTopbar } from "@/routes/chat/ChatTopbar";
import { SessionLanding } from "@/routes/chat/SessionLanding";
import { SessionSidebar, type AttachedConversation } from "@/routes/chat/sidebar/SessionSidebar";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SidebarToggle } from "@/routes/chat/topbar/SidebarToggle";
import { SessionExtensions } from "@/routes/chat/topbar/SessionExtensions";
import { SessionSlots, SessionUsage } from "@/routes/chat/topbar/SessionSlots";
import { SessionMain } from "@/routes/chat/SessionMain";
import { SessionMenu } from "@/routes/chat/SessionMenu";
import { DirectoryPicker } from "@/routes/chat/picker/DirectoryPicker";

/** The page fills the column the frame gives it, and nothing of it scrolls as a whole. */
const COLUMN = "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";

export function ChatScreen() {
    const connection = useQuery(connectionQueries.current());
    const client = useQueryClient();
    const { windowWidth } = useWindowSize();
    const wide = windowWidth >= 1024;
    const { stage: pageOf } = useMotion();

    const deps = useMemo<ChatDeps>(
        () => ({
            attach: async (path) => {
                const info = await bridge.attachSession(path);
                await client.invalidateQueries({ queryKey: ["connection"] });
                return info;
            },
            start: async (cwd) => {
                const info = await bridge.startSession(cwd ?? undefined);
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
    // conversation of a row: the match is what a pick and the list light read. The list is one
    // value across a render: the readers below keep it in their dependencies, and a fresh array
    // every render would run their effects again.
    const sessions = useMemo(() => connection.data?.sessions ?? [], [connection.data]);
    const endpoint = connection.data?.endpoint ?? "local";
    const phaseOfEach = useSyncExternalStore(subscribeSessions, phases, phases);
    const sessionStateReads = useQueries({
        queries: sessions.map((item) => sessionQueries.state(item.id)),
    });
    const attached = useMemo(() => {
        const result = new Map<string, AttachedConversation>();
        sessionStateReads.forEach((read, index) => {
            const item = sessions[index];
            const file = read.data?.sessionFile ?? null;
            if (item === undefined || file === null) return;
            result.set(file, { session: item.id, working: phaseOfEach.get(item.id) !== "idle" });
        });
        return result;
    }, [sessionStateReads, sessions, phaseOfEach]);
    // The chart of the session in view, for the bar's own slots: the registry holds it, and a
    // screen only selects it.
    const chart = useSyncExternalStore(
        subscribeSessions,
        () => (session === null ? null : chartOf(session)),
        () => null,
    );
    const cwd = sessions.find((running) => running.id === session)?.cwd ?? null;

    // The sheet is a narrow window's way to the list; the column is a wide one's.
    // Pure UI, so the two live here, above both stages that draw a list.
    const [sheet, setSheet] = useState(false);
    const [column, setColumn] = useState(true);
    // The directory picker of a new conversation: a sheet of its own, above both stages
    // that offer the action (the list and the landing).
    const [picking, setPicking] = useState(false);
    // The popup of the conversation's own actions, at the end of the bar.
    const [menu, setMenu] = useState(false);
    const toggleSessions = () => (wide ? setColumn((open) => !open) : setSheet(true));
    // The picker is its own modal layer. The list steps aside while it is open
    // and comes back if the picker is dismissed, so a resumed app keeps one
    // modal at a time.
    const openPicker = () => setPicking(true);

    // A connection that was replaced never held the session in view: the reach was brought
    // back, and every pi of the old one went with it. The list of the connection says so, and
    // the screen goes back to that list. The read must have answered - while it is in flight
    // the answer in hand is the one from before the attach that opened this session.
    useEffect(() => {
        if (stage !== "viewing" || session === null) return;
        if (connection.isFetching || connection.data == null) return;
        if (sessions.some((running) => running.id === session)) return;
        bridge.log.info("the connection no longer holds the session in view", { session });
        machine.send({ type: "GONE" });
    }, [stage, connection.data, connection.isFetching, session, sessions, machine]);

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
                    onNew={openPicker}
                    wide={wide}
                    column={column}
                    sheet={sheet}
                    onOpenSheet={setSheet}
                />
            }
        >
            {/* The bar is the window's: only the conversation's own slots in it change. */}
            <ChatTopbar
                start={
                    <>
                        <SidebarToggle expanded={expanded} onToggleSessions={toggleSessions} />
                        {stage === "viewing" && chart !== null && session !== null && (
                            <SessionSlots session={session} machine={chart} endpoint={endpoint} cwd={cwd} />
                        )}
                    </>
                }
                end={
                    stage === "viewing" && chart !== null && session !== null ? (
                        <>
                            <SessionUsage session={session} machine={chart} />
                            <SessionExtensions session={session} />
                            <SessionMenu
                                session={session}
                                machine={chart}
                                endpoint={endpoint}
                                open={menu}
                                onOpenChange={setMenu}
                                onClose={() => machine.send({ type: "CLOSE" })}
                                onGone={() => machine.send({ type: "GONE" })}
                                triggerClassName="size-6"
                                alignOffset={2}
                            />
                        </>
                    ) : undefined
                }
            />
            <AnimatePresence mode="wait" initial={false}>
                <motion.div id="session-page" key={page} {...pageOf} className={COLUMN}>
                    {body()}
                </motion.div>
            </AnimatePresence>
            <DirectoryPicker
                endpoint={endpoint}
                open={picking}
                onOpenChange={setPicking}
                onPick={(cwd) => {
                    setSheet(false);
                    setPicking(false);
                    machine.send({ type: "ATTACH", cwd });
                }}
            />
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
                    className="
                        m-auto flex max-w-prose flex-col items-center gap-3 px-6 text-center text-body-md
                        text-muted-foreground
                    "
                >
                    <p>{detached.message}</p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => machine.send({ type: "RETRY" })}>
                            Try again
                        </Button>
                        <Button variant="ghost" size="sm" render={<Link to="/" />} nativeButton={false}>
                            Connect
                        </Button>
                    </div>
                </div>
            );
        }

        if (stage === "viewing" && session !== null) {
            return <SessionMain session={session} client={client} />;
        }

        return <SessionLanding onSessions={toggleSessions} onNew={openPicker} />;
    }
}
