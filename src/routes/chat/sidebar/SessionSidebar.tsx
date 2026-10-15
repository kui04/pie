/**
 * The sessions of the host, as the window's sidebar: the column that stands beside
 * the transcript where the window holds one, and the sheet that covers it where the
 * window does not.
 *
 * The rows are files, not protocol: `listSessions` reads the sessions directory of the
 * host. What a row says is the work of `session-list.ts` beside this file.
 *
 * A pick returns the path of a row, and nothing here decides what that does: the
 * workspace knows which session pi holds.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder, Loader2, RefreshCw, Search } from "lucide-react";
import { AnimatePresence, motion, useAnimationFrame } from "motion/react";
import { cn } from "cn";

import {
    Drawer,
    DrawerContent,
    DrawerTitle,
    InputGroup,
    InputGroupAddon,
    InputGroupInput,
    Skeleton,
} from "@/components/ui";
import { SafeArea, ScrollPane } from "@/components";
import type { AttachedConversation } from "@/hooks/useAttachedConversations";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useMotion } from "@/hooks/useMotion";
import { useWideWindow } from "@/hooks/useWideWindow";
import * as bridge from "@/lib/bridge";
import { sessionsQueries } from "@/lib/query";
import { breatheAt, groupSessions, matchesSearch, pathKey, relativeTime, sessionTitle } from "./session-list";

/** What a stage tells the sidebar about the sessions of the host. */
export interface SessionList {
    /** The host whose sessions these are (`local`, or `user@host:port`). */
    endpoint: string;
    /**
     * The conversations that running sessions hold, by the path of pi's session file. A row
     * lights when one of them holds it, and the light says whether that session works now.
     */
    attached: ReadonlyMap<string, AttachedConversation>;
    /** Continue the conversation of the row that was chosen. */
    onPick: (path: string) => void;
}

export interface SessionSidebarProps extends SessionList {
    /** The base of the panel's ids: its column, its sheet, and the sheet's panel. */
    id: string;
    /** Whether the window is wide enough for a permanent column. */
    wide: boolean;
    /** Whether the column is out; the wrapper animates its width. */
    column: boolean;
    /** Whether the sheet is open, where the window holds no column. */
    sheet: boolean;
    onOpenSheet: (open: boolean) => void;
    /** Merged into the sheet's surface last, so a preview can pin it open. */
    sheetClassName?: string;
}

export function SessionSidebar({ id, wide, column, sheet, onOpenSheet, sheetClassName, ...list }: SessionSidebarProps) {
    const { frame } = useMotion();

    return (
        <>
            <AnimatePresence initial={false}>
                {wide && column && (
                    <motion.div
                        id="sidebar"
                        key="session-list"
                        className={cn(
                            "bg-surface-dim border-border flex min-h-0 flex-none flex-col overflow-hidden border-r",
                            // The width the frame animates is the list's own, and the hairline that
                            // parts it from the chat sits outside that (`box-content`), so the panel
                            // below keeps the width it was drawn at and the frame reveals it by
                            // clipping: what moves is the edge, not the rows.
                            "box-content",
                        )}
                        {...frame(256)}
                    >
                        <SessionListPanel id={`${id}-drawer`} className="w-64 flex-1" breathing {...list} />
                    </motion.div>
                )}
            </AnimatePresence>
            <SessionSheet id={`${id}-sheet`} open={sheet} onOpenChange={onOpenSheet} className={sheetClassName}>
                <SessionListPanel id={`${id}-sheet-drawer`} className="h-full" breathing={sheet} {...list} />
            </SessionSheet>
        </>
    );
}

/** The list itself, whatever holds it: the search, the refresh, the groups, the rows. */
function SessionListPanel({
    id,
    className,
    breathing,
    ...list
}: SessionList & { id: string; className?: string; breathing: boolean }) {
    const { endpoint, attached, onPick } = list;
    const { stage, swap, turn } = useMotion();
    const client = useQueryClient();
    const sessions = useQuery(sessionsQueries.list(endpoint));
    const [search, setSearch] = useState("");
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    const now = useMinutes();
    const reading = sessions.isFetching;
    // The element that scrolls, as state rather than a ref: its height is read from a value the
    // compiler can follow, and it arrives with the pane's first layout.
    const [pane, setPane] = useState<HTMLDivElement | null>(null);
    const held = usePaneHeight(pane);
    // Whether the key itself is reading: the read the reader asked for, and not a read of the
    // window's own (a window that came back to the front).
    const [asked, setAsked] = useState(false);
    // The read this key started, held until it settles: the key is out of reach while a read
    // is in flight, and this closes the frame before the flag it draws from comes back.
    const asking = useRef(false);

    async function refresh() {
        if (asking.current) return;
        asking.current = true;
        setAsked(true);
        try {
            await client.invalidateQueries({ queryKey: ["sessions", endpoint] });
        } finally {
            asking.current = false;
            setAsked(false);
        }
    }

    const filtered = useMemo(
        () => (sessions.data ?? []).filter((session) => matchesSearch(session, search)),
        [sessions.data, search],
    );
    const groups = useMemo(() => groupSessions(filtered), [filtered]);

    const toggle = (cwd: string) =>
        setFolded((before) => {
            const next = new Set(before);
            if (!next.delete(cwd)) next.add(cwd);
            return next;
        });

    return (
        <div id={id} className={cn("bg-surface-dim flex min-h-0 flex-col", className)}>
            <div className="p-2">
                <InputGroup>
                    <InputGroupAddon aria-hidden>
                        <Search />
                    </InputGroupAddon>
                    <InputGroupInput
                        id={`${id}-search`}
                        // The primitive carries a size of its own (`text-base`,
                        // `text-sm` on a wide window); this panel is body-md
                        // throughout, so the size is forced here.
                        className="placeholder:text-outline text-body-md!"
                        // The placeholder is not a name: a screen reader reads the
                        // label for the field.
                        aria-label="Search sessions"
                        placeholder="Search sessions"
                        type="search"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        enterKeyHint="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
                    />
                </InputGroup>
            </div>
            <div className="flex items-center justify-between px-2 py-1">
                <span className="text-body-md text-muted-foreground">Sessions</span>
                {/* A key is a key wherever it stands: the box, the corner, the hover and the
                    focus ring are the window controls' own. */}
                <button
                    id={`${id}-refresh`}
                    type="button"
                    aria-label="Refresh the session list"
                    disabled={reading}
                    onClick={() => void refresh()}
                    className={cn(
                        "hover:bg-muted focus-visible:outline-primary text-foreground",
                        "size-6 shrink-0 rounded-sm bg-transparent p-1",
                        "disabled:pointer-events-none disabled:opacity-50",
                        "transition-colors duration-50 ease-in-out",
                    )}
                >
                    {/* A turning ring while the key itself reads, and out as the words land -
                        and no `initial={false}`, which reaches the whole subtree and would leave
                        the turn standing at the end it never ran. The glyph arrives with a swap
                        of its own: a part arriving is a slot. */}
                    <AnimatePresence mode="wait">
                        <motion.span key={asked ? "reading" : "done"} className="flex" {...swap}>
                            {asked ? (
                                <motion.span className="flex" {...turn}>
                                    <Loader2 className="size-4" aria-hidden />
                                </motion.span>
                            ) : (
                                <RefreshCw className="size-4" aria-hidden />
                            )}
                        </motion.span>
                    </AnimatePresence>
                </button>
            </div>
            <ScrollPane className="min-h-0 flex-1" viewportRef={setPane} viewportClassName="p-2 pb-4">
                {/* The panel holds one of four things, and a change of one for another is a
                    change of the page it reads: it fades through (`stage`), and what is
                    leaving goes first. A read the reader asked for is not such a change: the
                    rows stay where they are, at the position they were read to, and the key
                    that asked is the whole of the progress. */}
                <AnimatePresence mode="wait" initial={false}>
                    {sessions.isError ? (
                        <motion.div key="failure" className="space-y-2" {...stage}>
                            <p
                                id={`${id}-failure`}
                                role="alert"
                                className="text-body-md text-muted-foreground px-1 py-2"
                            >
                                {bridge.asPieError(sessions.error).message}
                            </p>
                        </motion.div>
                    ) : sessions.isPending ? (
                        <motion.div key="pending" className="space-y-2" {...stage}>
                            <SessionSkeleton id={`${id}-pending`} height={Math.max(0, held - AIR)} />
                        </motion.div>
                    ) : groups.length === 0 ? (
                        <motion.div key="empty" className="space-y-2" {...stage}>
                            <p id={`${id}-empty`} className="text-body-md text-muted-foreground px-1 py-2">
                                {search.trim() === "" ? "No sessions yet" : "No session matches"}
                            </p>
                        </motion.div>
                    ) : (
                        <motion.div key="rows" className="space-y-2" {...stage}>
                            {groups.map((group) => (
                                <section key={group.cwd} className="space-y-0.5">
                                    <button
                                        type="button"
                                        aria-expanded={!folded.has(group.cwd)}
                                        onClick={() => toggle(group.cwd)}
                                        className={cn(
                                            "text-muted-foreground hover:text-foreground flex",
                                            // The icon leads from the heading's own left edge, and
                                            // the directory's words keep the line the names keep.
                                            "w-full items-center gap-2.5 rounded-md py-1.5 pr-1 text-left",
                                        )}
                                    >
                                        <Folder className="size-4 shrink-0" aria-hidden />
                                        <span className="text-body-md min-w-0 flex-1 truncate">
                                            {group.cwd || "No directory"}
                                        </span>
                                        {folded.has(group.cwd) ? (
                                            <ChevronRight className="size-4 shrink-0" aria-hidden />
                                        ) : (
                                            <ChevronDown className="size-4 shrink-0" aria-hidden />
                                        )}
                                    </button>
                                    {!folded.has(group.cwd) &&
                                        group.sessions.map((session) => (
                                            <SessionRow
                                                key={session.path}
                                                id={id}
                                                session={session}
                                                now={now}
                                                held={attached.get(session.path) ?? null}
                                                breathing={breathing}
                                                onPick={onPick}
                                            />
                                        ))}
                                </section>
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>
            </ScrollPane>
        </div>
    );
}

/**
 * The list before the host answers: the shape of a directory and its sessions, drawn as bars,
 * so nothing moves when the words land. A group's bar leads where its folder leads and a
 * session's where its name stands, and the bars stand as far down as the pane reaches - a
 * skeleton covers the area the content will cover, and a pane of bars half full would say the
 * list is half the size it may be. A reader who asked for less motion gets bars that stand
 * still.
 */
function SessionSkeleton({ id, height }: { id: string; height: number }) {
    return (
        <div id={id} role="status" aria-label="Loading the sessions" className="flex flex-col gap-2">
            {shapeFor(height).map((group, at) => (
                <div key={at} className="flex flex-col gap-0.5">
                    {/* The folder stands where the directory's folder stands, from the edge the
                        heading starts at. */}
                    <div aria-hidden className="flex items-center gap-2.5 py-1.5 pr-1">
                        <Skeleton className="size-4 shrink-0 motion-reduce:animate-none" />
                        <Skeleton className={cn("h-5", group.heading, "motion-reduce:animate-none")} />
                    </div>
                    {group.sessions.map((width, row) => (
                        <div key={row} aria-hidden className="flex items-center gap-1.5 px-1 py-1.5">
                            {/* Where a session's light stands, and a name beside it. */}
                            <span className="size-4 shrink-0" />
                            <Skeleton className={cn("h-5", width, "motion-reduce:animate-none")} />
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

/** The height of one bar's row: a line of `text-body-md` in its 6px of padding, and the 2px under it. */
const BAR = 34;

/** One directory's heading row, and the 6px more that its group stands apart by. */
const HEAD = 40;

/** The pane's own air: the 8px above and below the bars that its height includes (`p-2`). */
const AIR = 16;

/** How many sessions one directory's heading stands over before the next directory begins. */
const PER_GROUP = 4;

/** The shape a pane that has not been measured yet holds: a directory, and four of its sessions. */
const BEFORE_MEASURED = HEAD + PER_GROUP * BAR;

/** The widths of the bars, so a column of them does not read as one row repeated. */
const HEADS = ["w-3/5", "w-2/5", "w-1/2", "w-4/5"];
const NAMES = ["w-1/2", "w-2/3", "w-2/5", "w-4/5", "w-1/3", "w-3/5"];

/**
 * The shape of the list as far as a pane of this height reaches: a directory, the sessions under
 * it, and the next directory. Nothing is drawn that the pane cannot hold - the bars stand where
 * the words will stand, down to its foot - and a directory stands only if one of its
 * conversations stands under it.
 */
function shapeFor(height: number): Array<{ heading: string; sessions: string[] }> {
    const groups: Array<{ heading: string; sessions: string[] }> = [];
    let left = Math.max(BEFORE_MEASURED, height);
    let drawn = 0;
    while (left >= HEAD + BAR) {
        const group = { heading: HEADS[groups.length % HEADS.length], sessions: [] as string[] };
        left -= HEAD;
        while (left >= BAR && (group.sessions.length < PER_GROUP || left < HEAD + BAR)) {
            group.sessions.push(NAMES[drawn % NAMES.length]);
            drawn += 1;
            left -= BAR;
        }
        groups.push(group);
    }
    return groups;
}

/**
 * The sheet of a narrow window: the same list over the transcript.
 *
 * From `lg` the list is the column instead, and the button that opens this sheet
 * lives below that breakpoint. A window that grows past it lets the sheet go: a
 * hidden sheet is not a closed one, and the body has no pointer events of its own
 * while a modal is up (see `useWideWindow.ts`).
 */
function SessionSheet({
    id,
    open,
    onOpenChange,
    children,
    className,
}: {
    /** The id of the sheet's surface; the panel inside it has its own. */
    id: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
    /** Merged last, so a caller can overrule the frame (a preview pins it open). */
    className?: string;
}) {
    const wide = useWideWindow();
    const keyboardInset = useKeyboardInset();

    useEffect(() => {
        if (wide) onOpenChange(false);
    }, [wide, onOpenChange]);

    return (
        <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="left">
            <DrawerContent id={id} className={cn("border-border w-72 max-w-[85%]", "lg:hidden", className)}>
                <DrawerTitle className="sr-only">Sessions</DrawerTitle>
                {/* The sheet leaves the page for a portal, where the shell's safe area
                    does not reach: it keeps its own sides, or the panel's first and last
                    rows would sit under the system bars. The keyboard pad only applies
                    where the layout did not already shrink for it. */}
                <SafeArea
                    side="vertical"
                    className="h-full"
                    style={{ paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + ${keyboardInset}px)` }}
                >
                    {children}
                </SafeArea>
            </DrawerContent>
        </Drawer>
    );
}

/**
 * One session of the list.
 *
 * A row says its name, or the words that opened it, or the time it was last
 * written when it has neither. The light of a row is a fact of a process: the
 * conversation it names is held by a running session, and the colour says whether
 * that session is in a run now - the light covers the same slot either way, and it
 * breathes: a light that is there is a light that is alive.
 */
function SessionRow({
    id,
    session,
    now,
    held,
    breathing,
    onPick,
}: {
    id: string;
    session: bridge.SessionSummary;
    now: number;
    /** The session that holds this conversation, or `null` when no process holds it. */
    held: AttachedConversation | null;
    /** Whether the list this row belongs to is on screen, and its light is driven. */
    breathing: boolean;
    onPick: (path: string) => void;
}) {
    const title = sessionTitle(session);
    const when = relativeTime(session.modified, now);
    const mark = held === null ? null : held.working ? "working" : "attached";

    return (
        <button
            type="button"
            // The key of the file names the row: a path is not a selector, and a copy
            // of a session file carries the same id in its header (see `pathKey`).
            id={`${id}-row-${pathKey(session.path)}`}
            data-path={session.path}
            aria-current={held !== null ? "true" : undefined}
            onClick={() => onPick(session.path)}
            className={cn("hover:bg-accent flex w-full items-center gap-1.5", "rounded-md px-1 py-1.5 text-left")}
        >
            <span className="size-4 shrink-0" aria-hidden />
            <span className="text-body-md min-w-0 flex-1 truncate">{title ?? when}</span>
            {mark !== null && (
                <>
                    <Light
                        breathing={breathing}
                        // The light of the row, and the only thing here that moves:
                        // the colour says which state it reports.
                        className={cn(
                            "size-1 shrink-0 rounded-full",
                            mark === "working" ? "bg-primary" : "bg-tertiary",
                        )}
                    />
                    <span className="sr-only">{mark === "working" ? "working" : "attached"}</span>
                </>
            )}
            {title !== null && (
                <span className="text-label-md text-muted-foreground shrink-0" aria-hidden>
                    {when}
                </span>
            )}
        </button>
    );
}

/**
 * The light of a row: a dot that breathes while a process is there.
 *
 * The brightness is written on Motion's frame clock rather than handed to Motion as
 * a transition: the browser's own animation of `opacity` leaves a rejected promise
 * when a row goes away mid-breath (the breath runs a `MOTION.breath` cycle in
 * `session-list.ts` beside this file). A light is breathed only while its list is on
 * screen - the column that is out, or the sheet that is open - and a reader who asked
 * for less motion gets a dot that is simply lit. Both are asked once, by the light.
 */
function Light({ className, breathing }: { className?: string; breathing: boolean }) {
    const dot = useRef<HTMLSpanElement>(null);
    const { still } = useMotion();
    useAnimationFrame((ms) => {
        if (dot.current === null) return;
        if (still || !breathing) {
            // Not driven: the light stands at its full brightness, and nothing is written
            // on a frame for a list nobody is looking at.
            if (dot.current.style.opacity !== "") dot.current.style.opacity = "";
            return;
        }
        dot.current.style.opacity = breatheAt(ms).toFixed(3);
    });
    return <span ref={dot} aria-hidden className={className} />;
}

/**
 * The height of a pane, on the frames it changes: how far down its bars reach is the pane's own
 * business, and the pane has more than one size (the column beside the chat, the sheet over it).
 * A pane that is not there yet is as tall as nothing.
 */
function usePaneHeight(pane: HTMLDivElement | null): number {
    const subscribe = useCallback(
        (read: () => void) => {
            if (pane === null || typeof ResizeObserver === "undefined") return () => undefined;
            const watch = new ResizeObserver(read);
            watch.observe(pane);
            return () => watch.disconnect();
        },
        [pane],
    );
    return useSyncExternalStore(
        subscribe,
        () => pane?.clientHeight ?? 0,
        () => 0,
    );
}

/**
 * The clock of the rows, to the minute.
 *
 * The first value comes with the first render, and the ticks come from a timer: a
 * clock that runs during a render is not the same answer twice (the rule the cards'
 * clock follows too).
 */
function useMinutes(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}
