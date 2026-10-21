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
import { ChevronsDownUp, ChevronsUpDown, Folder, FolderOpen, Plus, RotateCw, Settings } from "lucide-react";
import { AnimatePresence, motion, useAnimationFrame } from "motion/react";
import { cn } from "cn";

import {
    Drawer,
    DrawerContent,
    DrawerTitle,
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
    Skeleton,
} from "@/components/ui";
import { SafeArea, ScrollPane, Icon, TruncatedText } from "@/components";
import { useLongPress, useMotion, useWindowSize } from "@/hooks";
import * as bridge from "@/lib/bridge";
import { directoryQueries, sessionsQueries } from "@/lib/query";
import { SessionMenu } from "@/routes/chat/SessionMenu";
import {
    breatheAt,
    formatCwd,
    groupSessions,
    pathKey,
    relativeTime,
    relativeTimeAgo,
    sessionTitle,
} from "./session-list";

/** One attached conversation: the session that holds it, and whether that session runs now. */
export interface AttachedConversation {
    session: string;
    working: boolean;
}

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
    /** Open the directory picker, for a new conversation. */
    onNew: () => void;
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

interface SessionPreviewPayload {
    title: string;
    ago: string;
}

/** The session row preview: the full name and the relative time the row yields to its menu. */
const ROW_PREVIEW = `
    w-max min-w-56 max-w-[var(--available-width,calc(100vw-2rem))] bg-card p-3 duration-150 ease-out
    motion-safe:transition-[opacity,scale]
    motion-safe:data-ending-style:scale-95 motion-safe:data-ending-style:opacity-0
    motion-safe:data-starting-style:scale-95 motion-safe:data-starting-style:opacity-0
`;

export function SessionSidebar({ id, wide, column, sheet, onOpenSheet, sheetClassName, ...list }: SessionSidebarProps) {
    const { frame } = useMotion();

    return (
        <>
            <AnimatePresence initial={false}>
                {wide && column && (
                    <motion.div
                        id="sidebar"
                        key="session-list"
                        className="
                            box-content flex min-h-0 flex-none flex-col overflow-hidden border-r border-border
                            bg-surface-dim
                        "
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

/** The list itself, whatever holds it: the new session button, the fold/refresh controls, the groups, the rows. */
function SessionListPanel({
    id,
    className,
    breathing,
    ...list
}: SessionList & { id: string; className?: string; breathing: boolean }) {
    const { endpoint, attached, onPick, onNew } = list;
    const { stage } = useMotion();
    const client = useQueryClient();
    const sessions = useQuery(sessionsQueries.list(endpoint));
    const dirs = useQuery(directoryQueries.list(endpoint));
    const homePath = dirs.data?.directory ?? "";

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

    const groups = useMemo(() => groupSessions(sessions.data ?? []), [sessions.data]);
    const allFolded = groups.length > 0 && groups.every((group) => folded.has(group.cwd));

    const toggle = (cwd: string) =>
        setFolded((before) => {
            const next = new Set(before);
            if (!next.delete(cwd)) next.add(cwd);
            return next;
        });

    const toggleAll = () => {
        if (allFolded) {
            setFolded(new Set());
        } else {
            setFolded(new Set(groups.map((group) => group.cwd)));
        }
    };

    return (
        <div id={id} className={cn("flex min-h-0 flex-col gap-2 bg-surface-dim p-2", className)}>
            {/* Top action section */}
            <div className="flex-none border-b border-border/40 pb-2">
                <button
                    id={`${id}-new`}
                    type="button"
                    onClick={onNew}
                    className="
                        flex h-8 w-full cursor-pointer items-center justify-start gap-2 rounded-lg border
                        border-border/60 bg-surface/50 ps-1.75 pe-2 text-sm font-normal text-foreground
                        transition-colors
                        hover:bg-accent/50 hover:text-foreground
                    "
                >
                    <Icon className="shrink-0 justify-start">
                        <Plus aria-hidden />
                    </Icon>
                    <TruncatedText offset={{ top: 8, right: 12, bottom: 8, left: 12 }}>New Conversation</TruncatedText>
                </button>
            </div>

            {/* Middle sessions section */}
            <div className="flex min-h-0 flex-1 flex-col gap-1">
                <div id={`${id}-head`} className="flex h-7 items-center justify-between px-2 py-1">
                    <span className="text-body-md font-medium text-muted-foreground">Sessions</span>
                    <span className="flex items-center gap-1">
                        <button
                            id={`${id}-fold-toggle`}
                            type="button"
                            aria-label={allFolded ? "Expand all groups" : "Collapse all groups"}
                            onClick={toggleAll}
                            className="
                                inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm
                                bg-transparent p-1 text-muted-foreground transition-colors duration-50 ease-in-out
                                hover:bg-accent/50 hover:text-foreground
                                focus-visible:outline-primary
                            "
                        >
                            {allFolded ? (
                                <Icon>
                                    <ChevronsUpDown aria-hidden />
                                </Icon>
                            ) : (
                                <Icon>
                                    <ChevronsDownUp aria-hidden />
                                </Icon>
                            )}
                        </button>
                        <button
                            id={`${id}-refresh`}
                            type="button"
                            aria-label="Refresh the session list"
                            disabled={reading}
                            onClick={() => void refresh()}
                            className="
                                inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm
                                bg-transparent p-1 text-muted-foreground transition-colors duration-50 ease-in-out
                                hover:bg-accent/50 hover:text-foreground
                                focus-visible:outline-primary
                                disabled:pointer-events-none disabled:opacity-50
                            "
                        >
                            <Icon>
                                <RotateCw
                                    className={cn("size-4", (reading || asked) && "animate-spin text-primary")}
                                    aria-hidden
                                />
                            </Icon>
                        </button>
                    </span>
                </div>
                <ScrollPane className="min-h-0 flex-1" viewportRef={setPane} viewportClassName="py-1 pb-4">
                    <AnimatePresence mode="wait" initial={false}>
                        {sessions.isError ? (
                            <motion.div key="failure" className="space-y-2" {...stage}>
                                <p id={`${id}-failure`} role="alert" className="p-2 text-body-md text-muted-foreground">
                                    {bridge.asPieError(sessions.error).message}
                                </p>
                            </motion.div>
                        ) : sessions.isPending ? (
                            <motion.div key="pending" className="space-y-2" {...stage}>
                                <SessionSkeleton id={`${id}-pending`} height={Math.max(0, held - AIR)} />
                            </motion.div>
                        ) : groups.length === 0 ? (
                            <motion.div key="empty" className="space-y-2" {...stage}>
                                <p id={`${id}-empty`} className="p-2 text-body-md text-muted-foreground">
                                    No sessions yet
                                </p>
                            </motion.div>
                        ) : (
                            <motion.div key="rows" className="space-y-2" {...stage}>
                                <HoverCard>
                                    {({ payload }: { payload?: unknown }) => {
                                        const preview = payload as SessionPreviewPayload | undefined;
                                        return (
                                            <>
                                                {groups.map((group) => (
                                                    <section key={group.cwd} className="space-y-0.5">
                                                        <SessionDirectory
                                                            cwd={group.cwd}
                                                            homePath={homePath}
                                                            folded={folded.has(group.cwd)}
                                                            onToggle={() => toggle(group.cwd)}
                                                        />
                                                        {!folded.has(group.cwd) &&
                                                            (group.sessions.length === 0 ? (
                                                                <p
                                                                    className="
                                                                        flex h-8 items-center px-2 pl-8 text-body-md
                                                                        text-muted-foreground/60 select-none
                                                                    "
                                                                >
                                                                    No conversations yet
                                                                </p>
                                                            ) : (
                                                                group.sessions.map((session) => (
                                                                    <SessionRow
                                                                        key={session.path}
                                                                        id={id}
                                                                        session={session}
                                                                        now={now}
                                                                        held={attached.get(session.path) ?? null}
                                                                        breathing={breathing}
                                                                        endpoint={endpoint}
                                                                        onPick={onPick}
                                                                    />
                                                                ))
                                                            ))}
                                                    </section>
                                                ))}
                                                {preview !== undefined && (
                                                    <HoverCardContent
                                                        side="right"
                                                        align="center"
                                                        alignOffset={0}
                                                        sideOffset={16}
                                                        className={ROW_PREVIEW}
                                                    >
                                                        <div className="flex flex-col gap-1">
                                                            <p
                                                                className="
                                                                    text-body-md font-medium wrap-break-word
                                                                    text-foreground
                                                                "
                                                            >
                                                                {preview.title}
                                                            </p>
                                                            <p className="text-body-sm text-muted-foreground">
                                                                {preview.ago}
                                                            </p>
                                                        </div>
                                                    </HoverCardContent>
                                                )}
                                            </>
                                        );
                                    }}
                                </HoverCard>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </ScrollPane>
            </div>

            {/* Bottom settings section */}
            <div className="mt-auto flex-none border-t border-border/40 pt-2">
                <button
                    id={`${id}-settings`}
                    type="button"
                    className="
                        flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm
                        text-muted-foreground transition-colors duration-100 ease-in-out
                        hover:bg-accent/50 hover:text-foreground
                    "
                >
                    <Icon className="shrink-0 justify-start">
                        <Settings aria-hidden />
                    </Icon>
                    <TruncatedText offset={{ top: 8, right: 12, bottom: 8, left: 12 }}>Settings</TruncatedText>
                </button>
            </div>
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
                    <div aria-hidden className="flex h-8 items-center gap-2 px-2">
                        <span className="flex size-6 shrink-0 items-center justify-start">
                            <Skeleton className="size-4 motion-reduce:animate-none" />
                        </span>
                        <Skeleton className={cn("h-4", group.heading, "motion-reduce:animate-none")} />
                    </div>
                    {group.sessions.map((width, row) => (
                        <div key={row} aria-hidden className="flex h-8 items-center gap-2 px-2">
                            {/* Where a session's light stands, and a name beside it. */}
                            <span className="size-6 shrink-0" />
                            <Skeleton className={cn("h-4", width, "motion-reduce:animate-none")} />
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
 * while a modal is up.
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
    const { windowWidth } = useWindowSize();
    const wide = windowWidth >= 1024;

    useEffect(() => {
        if (wide) onOpenChange(false);
    }, [wide, onOpenChange]);

    return (
        <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="left">
            <DrawerContent
                id={id}
                className={cn(
                    "w-72 max-w-[85%] border-border bg-surface-dim data-nested-drawer-open:opacity-0 lg:hidden",
                    className,
                )}
            >
                <DrawerTitle className="sr-only">Sessions</DrawerTitle>
                {/* The sheet leaves the page for a portal, where the shell's safe area
                    does not reach: it keeps its own sides, or the panel's first and last
                    rows would sit under the system bars. */}
                <SafeArea side="vertical" className="h-full">
                    {children}
                </SafeArea>
            </DrawerContent>
        </Drawer>
    );
}

/** The directory heading: a button whose clipped path opens the full path. */
function SessionDirectory({
    cwd,
    homePath,
    folded,
    onToggle,
}: {
    cwd: string;
    homePath: string;
    folded: boolean;
    onToggle: () => void;
}) {
    const text = useRef<HTMLSpanElement>(null);

    return (
        <TruncatedText
            render={
                <button
                    type="button"
                    aria-expanded={!folded}
                    onClick={onToggle}
                    className="
                        flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left
                        text-muted-foreground transition-colors duration-100 ease-in-out select-none
                        hover:bg-accent/50 hover:text-foreground
                    "
                />
            }
            measureRef={text}
            content={cwd === "" ? null : cwd}
            contentClassName="break-all"
            side="right"
            align="center"
            offset={{ top: 8, right: 12, bottom: 8, left: 12 }}
            alignOffset={0}
        >
            {folded ? (
                <Icon className="shrink-0 justify-start">
                    <Folder aria-hidden />
                </Icon>
            ) : (
                <Icon className="shrink-0 justify-start">
                    <FolderOpen aria-hidden />
                </Icon>
            )}
            <span ref={text} className="min-w-0 flex-1 truncate text-body-md font-normal">
                {cwd ? formatCwd(cwd, homePath) : "No directory"}
            </span>
        </TruncatedText>
    );
}

/**
 * One session of the list.
 *
 * /**
 * A row says its name, or the words that opened it, or the time it was last
 * written when it has neither. The light of a row is a fact of a process: the
 * conversation it names is held by a running session, and the colour says whether
 * that session is in a run now. When active, it displays a BreathLight indicator
 * aligned numerically alongside the timestamp. On hover, the session actions
 * menu fades in smoothly in place of the timestamp.
 */
function SessionRow({
    id,
    session,
    now,
    held,
    breathing,
    endpoint,
    onPick,
}: {
    id: string;
    session: bridge.SessionSummary;
    now: number;
    /** The session that holds this conversation, or `null` when no process holds it. */
    held: AttachedConversation | null;
    /** Whether the list this row belongs to is on screen, and its light is driven. */
    breathing: boolean;
    endpoint: string;
    onPick: (path: string) => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const longPress = useLongPress(() => setMenuOpen(true));
    const title = sessionTitle(session);
    const when = relativeTime(session.modified, now);
    const ago = relativeTimeAgo(session.modified, now);
    const mark = held === null ? null : held.working ? "working" : "attached";
    const payload = useMemo(() => (title !== null ? { title, ago } : undefined), [title, ago]);

    return (
        <HoverCardTrigger
            render={<div data-path={session.path} />}
            id={`${id}-row-${pathKey(session.path)}`}
            payload={payload}
            aria-current={held !== null ? "true" : undefined}
            onClick={() => {
                if (!longPress.consumeClick()) onPick(session.path);
            }}
            onClickCapture={(event) => {
                if (longPress.consumeClick()) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            onPointerDown={longPress.onPointerDown}
            onPointerMove={longPress.onPointerMove}
            onPointerUp={longPress.onPointerUp}
            onPointerCancel={longPress.onPointerCancel}
            onContextMenu={longPress.onContextMenu}
            className={cn(
                `
                    group relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left
                    select-none
                    hover:bg-accent/50
                `,
                menuOpen && "bg-accent",
            )}
        >
            <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
            >
                {/* A 24px slot puts the title on the directory's left edge; the light is
                        centred on the folder's 16px glyph. */}
                <span className="flex size-6 shrink-0 items-center justify-start ps-1.25" aria-hidden>
                    {mark !== null && <BreathLight breathing={breathing} mark={mark} />}
                </span>
                {mark !== null && <span className="sr-only">{mark === "working" ? "working" : "attached"}</span>}

                {/* Session title */}
                <span className="min-w-0 flex-1 truncate text-body-md font-normal text-foreground">
                    {title ?? when}
                </span>
            </button>

            {/* Trailing slot: relative timestamp when idle, session actions menu on hover/open */}
            <div className="group/slot relative ml-auto flex size-6 shrink-0 items-center justify-center">
                {title !== null && (
                    <div
                        className={cn(
                            `
                                absolute inset-0 flex items-center justify-center transition-opacity duration-150
                                ease-out
                                group-has-focus-visible/slot:pointer-events-none group-has-focus-visible/slot:opacity-0
                            `,
                            menuOpen ? "pointer-events-none opacity-0" : "opacity-100 group-hover:opacity-0",
                        )}
                    >
                        <span className="text-label-md text-muted-foreground tabular-nums select-none" aria-hidden>
                            {when}
                        </span>
                    </div>
                )}
                <div
                    className={cn(
                        "absolute inset-0 flex items-center justify-center transition-opacity duration-150 ease-out",
                        menuOpen
                            ? "pointer-events-auto opacity-100"
                            : `
                                pointer-events-none opacity-0
                                group-hover:pointer-events-auto group-hover:opacity-100
                                has-focus-visible:pointer-events-auto has-focus-visible:opacity-100
                            `,
                    )}
                    onClick={(event) => event.stopPropagation()}
                >
                    <SessionMenu
                        id={`${id}-menu-${pathKey(session.path)}`}
                        session={held?.session ?? null}
                        file={session.path}
                        initialName={session.name ?? null}
                        working={held?.working ?? false}
                        endpoint={endpoint}
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        triggerClassName="hover:bg-accent/50 dark:hover:bg-accent/50 text-muted-foreground hover:text-foreground size-6 p-1 rounded-sm cursor-pointer"
                    />
                </div>
            </div>
        </HoverCardTrigger>
    );
}

/**
 * The light of a row: one crisp dot that breathes while a process is there.
 *
 * The former concentric layers read as a blur at this size; a single 8px dot fades as
 * a whole, so its edge stays sharp through the breath.
 */
function BreathLight({
    className,
    breathing,
    mark,
}: {
    className?: string;
    breathing: boolean;
    mark: "working" | "attached";
}) {
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
    return (
        <span
            ref={dot}
            aria-hidden
            className={cn(
                "size-1.5 shrink-0 rounded-full bg-current",
                mark === "working" ? "text-primary" : "text-tertiary",
                className,
            )}
        />
    );
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
