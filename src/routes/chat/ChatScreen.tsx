import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSelector, useMachine } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui";
import { Window } from "@/components";
import { useConnection } from "@/hooks/use-connection";
import { useWideWindow } from "@/hooks/use-wide-window";
import { useSession } from "@/hooks/use-session";
import { chatMachine, errorOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";
import { sessionQueries } from "@/lib/query";
import * as bridge from "@/lib/bridge";
import { transcriptRows, queuedRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/stream";
import {
    ChatLanding,
    Composer,
    SessionDrawer,
    type SessionDrawerProps,
    SessionHeader,
    SessionLoading,
    SessionSheet,
    SidebarToggle,
    TranscriptList,
    withLiveUsage,
} from "@/routes/chat/components";
import { useTranscriptStore } from "@/stores/transcript.store";

export function ChatScreen() {
    const connection = useConnection();
    const client = useQueryClient();
    const wide = useWideWindow();
    // What the chart reaches outside for: starting a pi is a command, and the read
    // of the connection is what has to be asked again once it answers.
    const deps = useMemo<ChatDeps>(
        () => ({
            attach: async () => {
                await bridge.attachSession();
                await client.invalidateQueries({ queryKey: ["connection"] });
            },
        }),
        [client],
    );
    const [chat, , machine] = useMachine(chatMachine, { input: deps });
    const stage = stageOf(chat);
    const session = sessionOf(chat);
    const detached = errorOf(chat);
    // A connection holds one session, so the one in the list is the one.
    const held = connection.data?.sessions[0] ?? null;
    const endpoint = connection.data?.endpoint ?? "local";
    const disconnected = connection.isError || connection.data === null || connection.data === undefined;

    // Whether the workspace has to start pi is Rust's answer, not this screen's
    // guess: the read of the connection shows the session of a pi that is already
    // speaking (a reload of the webview), and no session when the machine was only
    // reached. The chart ignores a second ATTACH, so a pass of this effect over a
    // stage that is already starting one costs nothing.
    useEffect(() => {
        if (connection.data === null || connection.data === undefined) return;
        machine.send(held === null ? { type: "ATTACH" } : { type: "HELD" });
    }, [connection.data, held, machine]);

    // The sheet is a narrow window's way to the list; the column is a wide one's.
    // Pure UI, so the two live here, above both stages that draw a list.
    const [sheet, setSheet] = useState(false);
    const [column, setColumn] = useState(true);
    const toggleSessions = () => (wide ? setColumn((open) => !open) : setSheet(true));

    // What the list shows while no conversation is open: the file pi holds, so the
    // row it belongs to is the one in use, and a pick of it needs no switch (pi
    // reloads the conversation it is asked for, even when it is already the one).
    const heldState = useQuery({
        ...sessionQueries.state(held?.id ?? ""),
        enabled: stage === "landing" && held !== null,
    });

    // Which stage the window reached, and for which conversation: the shape of a
    // report about a window that would not open, where nothing else on this side
    // of the boundary says how far it got.
    useEffect(() => {
        bridge.log.info("the window is at a stage", { stage, session });
    }, [stage, session]);

    /**
     * Opens a session from the landing.
     *
     * The feed of the screen is not open yet, so the switch is asked for here: the
     * chart of a session takes a switch only while it lives (`session.machine.ts`),
     * and nothing lives before a conversation is chosen.
     */
    async function open(path: string) {
        setSheet(false);
        if (held === null) return;
        const heldFile = heldState.data?.sessionFile ?? null;
        try {
            bridge.log.info("a conversation was picked from the landing", { path, held: heldFile });
            if (path !== heldFile) await bridge.switchSession(held.id, path);
            machine.send({ type: "OPEN", session: held.id });
        } catch (thrown) {
            const error = bridge.asPieError(thrown);
            bridge.log.error("the conversation could not be opened", { path, reason: error.message });
            toast.error(error.message);
        }
    }

    if (connection.isPending) return <Window />;

    // Pi is on its way: every page below names a session, and none exists yet.
    if (stage === "attaching") {
        return (
            <Window bodyClassName="items-center justify-center">
                <SessionLoading label="Starting pi…" />
            </Window>
        );
    }

    // The machine is reached, and no pi speaks on it: the attempt failed, and the
    // page says why. A reload is not an answer - Rust holds the failure of that
    // attempt nowhere - so the way on is the attempt again, or another machine.
    if (stage === "unattached" && detached !== null) {
        return (
            <Window bodyClassName="items-center justify-center">
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
            </Window>
        );
    }

    // The landing: no conversation is open yet, which is where a window starts and
    // where the list hands the next one over.
    if (held === null || stage === "landing") {
        return (
            <ChatShell
                list={{
                    endpoint,
                    currentSessionId: heldState.data?.sessionId ?? null,
                    // Nothing is loading and nothing runs: the rows are the way in,
                    // and every one of them is open to a press.
                    working: false,
                    busy: false,
                    onPick: (path: string) => void open(path),
                }}
                wide={wide}
                column={column}
                sheet={sheet}
                onOpenSheet={setSheet}
                topbar={<SidebarToggle expanded={wide ? column : undefined} onToggleSessions={toggleSessions} />}
            >
                <ChatLanding disconnected={disconnected} />
            </ChatShell>
        );
    }
    return (
        <Session
            // Another session is another screen: the run state of a session, its queue
            // and its live command are per-session state, and a remount is what gives
            // them to it (`useSession`).
            key={session ?? held.id}
            machine={machine}
            session={session ?? held.id}
            cwd={held.cwd}
            endpoint={endpoint}
            wide={wide}
            column={column}
            sheet={sheet}
            onOpenSheet={setSheet}
            onToggleSessions={toggleSessions}
            client={client}
        />
    );
}

function Session({
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
}: {
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
}) {
    const { phase, working, state, snapshot, stats, listening, error, reopen, switchTo, switching } =
        useSession(session);
    const still = useReducedMotion();
    const stage = useSelector(machine, stageOf);
    // The conversation has arrived, so the window may draw it: the bar carries its
    // name and its usage, the body its rows, and the foot its composer. Until then
    // the window is on the page that says a conversation is coming, and the bar is
    // the landing's own - nothing of a conversation that is not here can be said.
    const loaded = stage === "loaded";
    // What a read of this session failed with, if it did. The failure of the feed
    // itself is not here: it reaches the chart of the screen (`error` below).
    const retry = () => {
        // A subscription is not held in a cache, so the retry has to ask for the
        // listeners as well as for the reads. The page stays the loading page it is
        // on: a feed that opens after this brings `ARRIVED` and the words with it.
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
            ...activityRows(phase),
            ...queuedRows(queued),
        ],
        [entries, order, leafId, rowIds, live, phase, queued],
    );

    // The composer band covers the foot of the stage. The pane measures it and the
    // transcript pads itself by that height, so no row hides behind the card (the
    // design's `_ComposerBand`). The first frame has no measurement yet; nine rem is
    // the design's own stand-in.
    const band = useRef<HTMLDivElement>(null);
    const [clearance, setClearance] = useState(9 * 16);
    const composerOn = loaded && error === null;
    // Pi writes a model and a thinking level into a new session before anything is
    // said; nothing of that is a message, so its transcript is empty. Such a
    // conversation has no words to stand under, so its composer waits in the middle
    // of the window instead of at the foot.
    const empty = loaded && rows.length === 0;

    // The chart of the screen hears one thing from here, because only this subtree
    // holds the reads: the conversation has arrived. A failure is not an event of
    // that chart - the page the reader is on says what went wrong, and a switch pi
    // refused or one that failed needs nothing at all, because the conversation
    // that stayed is still in the reads and answers for itself.
    const arrived = listening && !switching && !snapshot.isPending;
    useEffect(() => {
        if (arrived) machine.send({ type: "ARRIVED" });
    }, [arrived, machine]);

    // Two kinds of failure reach this screen: the listeners never opened, which the
    // hook reports, and a read, which the query holds. They are read in that order.
    const failure = error ?? snapshot.error ?? state.error ?? stats.error;

    const currentSessionId = state.data?.sessionId ?? null;
    useEffect(() => {
        const element = band.current;
        // A pane in a test environment lays nothing out and has no observer; the
        // stand-in of the first frame stays, which is the design's own fallback.
        if (!element || typeof ResizeObserver === "undefined") return;
        let frame: number | null = null;
        // The height is written a frame later, and only when it moved: a state that
        // sizes the transcript is a layout change, and one made inside the observer's
        // own delivery is a resize loop - the browser then reports the loop and leaves
        // the notifications it had queued undelivered, so the rows drawn in that same
        // delivery keep the height they were estimated with, and a jump to the end of
        // the transcript lands where the sizes used to be.
        const measure = () => {
            const height = Math.round(element.getBoundingClientRect().height);
            if (frame !== null || height <= 0) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                setClearance(height);
            });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => {
            observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
        };
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
        // While the feed is opening or has failed there is no conversation to leave:
        // the switch would reach Rust and the chart would drop its answer. The rows of
        // the drawer are disabled for the same reason (`busy` below).
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

    const drawerProps = { endpoint, currentSessionId, working, busy: !listening || working || switching, onPick: pick };

    // What stands under the bar. Three stages, three pages, and one leaves before the
    // next arrives (`mode="wait"`): the landing says the window is not connected to a
    // conversation, the loading page says one is coming, and the words are the
    // conversation itself. A switch is the same passage - the page of the conversation
    // that is leaving is given up at once - so nothing of those words can come back
    // and go again on the way.
    const transcript = <TranscriptList rows={rows} clearance={clearance} onRetractQueued={retractQueue} />;
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
        // The loading page does not keep the landing, the words or anything else under
        // it: a page of its own, entered and left with the same motion as the others.
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
        // The words of an empty conversation stand in its composer's band, in the
        // middle of the window (`composerOn` below): a body with nothing in it has
        // nothing to draw.
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
        <ChatShell
            list={drawerProps}
            wide={wide}
            column={column}
            sheet={sheet}
            onOpenSheet={onOpenSheet}
            topbar={
                // The bar says what the page it stands on can say: the way to the list
                // always, and the conversation's own slots only once it has arrived. The
                // header stays mounted so those slots leave as the loaded page does
                // rather than blinking out with it.
                <SessionHeader
                    name={state.data?.sessionName ?? null}
                    cwd={cwd}
                    stats={withLiveUsage(stats.data ?? null, liveUsage?.usage ?? null)}
                    auto={state.data?.autoCompactionEnabled ?? false}
                    expanded={wide ? column : undefined}
                    onToggleSessions={onToggleSessions}
                    ready={loaded}
                />
            }
            // The band is placed against the foot of the body, so the body is what
            // it is positioned in. The body itself is the whole region - the
            // transcript scrolls it edge to edge, bar and all - and only what is
            // drawn inside it is capped to the content column.
            bodyClassName="relative"
        >
            <AnimatePresence mode="wait" initial={false}>
                {content}
            </AnimatePresence>
            <AnimatePresence initial={false}>
                {composerOn && (
                    // The composer covers the foot of a conversation that has words:
                    // the transcript keeps room for its whole height (measured above),
                    // so no row hides behind it. A conversation with nothing in it
                    // holds the composer — and the sentence that says so — in the middle
                    // of the window, where the reader is looking.
                    <motion.div
                        id="composer-band"
                        ref={band}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={leaving}
                        // The list's bar floats over the region, so the band takes
                        // the region's whole width and the content column is centred
                        // in it - the same centreline the rows are centred on.
                        className={cn(empty ? "m-auto py-2" : "absolute right-0 bottom-0 left-0 z-10 py-2")}
                    >
                        {/* The band's own gap is above and below the composer; the
                            phone's navigation bar is room the content adds on top
                            of it, or the keys would sit under the bar. */}
                        <div className="pb-safe mx-auto w-full max-w-5xl px-2 min-[840px]:px-4">
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
        </ChatShell>
    );
}

/**
 * The window of the chat, in every stage of it: the list, the bar, the body.
 *
 * The list is one node in both, so the column and the sheet are drawn from one
 * description: a stage that re-created it would be a stage that could lose it.
 */
function ChatShell({
    list,
    wide,
    column,
    sheet,
    onOpenSheet,
    topbar,
    bodyClassName,
    children,
}: {
    list: Omit<SessionDrawerProps, "id" | "className">;
    wide: boolean;
    column: boolean;
    sheet: boolean;
    onOpenSheet: (open: boolean) => void;
    topbar: ReactNode;
    bodyClassName?: string;
    children?: ReactNode;
}) {
    const still = useReducedMotion();
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
                                initial={{ width: 0 }}
                                animate={{ width: 256 }}
                                exit={{ width: 0 }}
                                transition={
                                    still ? { duration: 0 } : { type: "tween", duration: 0.28, ease: [0.2, 0, 0, 1] }
                                }
                            >
                                <SessionDrawer id="session-drawer" className="w-64 flex-1" {...list} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                }
                topbar={topbar}
                bodyClassName={bodyClassName}
            >
                {children}
            </Window>
            <SessionSheet id="session-sheet" open={sheet} onOpenChange={onOpenSheet}>
                <SessionDrawer id="session-sheet-drawer" className="h-full" {...list} />
            </SessionSheet>
        </>
    );
}
