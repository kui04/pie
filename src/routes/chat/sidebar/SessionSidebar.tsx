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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder, RefreshCw, Search } from "lucide-react";
import { AnimatePresence, motion, useAnimationFrame } from "motion/react";
import { cn } from "cn";

import { Button, InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui";
import { SafeArea, ScrollPane, Sheet, SheetContent, SheetTitle } from "@/components";
import type { AttachedConversation } from "@/hooks/use-attached-conversations";
import { useMotion } from "@/hooks/use-motion";
import { useWideWindow } from "@/hooks/use-wide-window";
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
                        className="bg-surface-dim border-border flex min-h-0 flex-none flex-col overflow-hidden border-r"
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
    const { turn, still } = useMotion();
    const client = useQueryClient();
    const sessions = useQuery(sessionsQueries.list(endpoint));
    const [search, setSearch] = useState("");
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    // The turn of the key, counted rather than held: every press is one turn of its
    // own, and two presses in a row play two (the `key` of the icon is this number).
    const [turns, setTurns] = useState(0);
    const now = useMinutes();

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
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </InputGroup>
            </div>
            <div className="flex items-center justify-between py-1 pr-1 pl-1">
                <span className="text-body-md text-muted-foreground px-1">Recent</span>
                <Button
                    id={`${id}-refresh`}
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Refresh the session list"
                    disabled={sessions.isFetching}
                    onClick={() => {
                        setTurns((before) => before + 1);
                        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
                    }}
                >
                    <motion.span
                        key={turns}
                        className="flex"
                        initial={turns === 0 || still ? false : { rotate: 0 }}
                        {...turn}
                    >
                        <RefreshCw className="size-4" />
                    </motion.span>
                </Button>
            </div>
            <ScrollPane className="min-h-0 flex-1" viewportClassName="p-2">
                <div className="space-y-2">
                    {sessions.isError ? (
                        <p id={`${id}-failure`} role="alert" className="text-body-md text-muted-foreground px-1 py-2">
                            {bridge.asPieError(sessions.error).message}
                        </p>
                    ) : sessions.isPending ? (
                        <p id={`${id}-pending`} className="text-body-md text-muted-foreground px-1 py-2">
                            Looking for sessions…
                        </p>
                    ) : groups.length === 0 ? (
                        <p id={`${id}-empty`} className="text-body-md text-muted-foreground px-1 py-2">
                            {search.trim() === "" ? "No sessions yet" : "No session matches"}
                        </p>
                    ) : (
                        groups.map((group) => (
                            <section key={group.cwd} className="space-y-0.5">
                                <button
                                    type="button"
                                    aria-expanded={!folded.has(group.cwd)}
                                    onClick={() => toggle(group.cwd)}
                                    className={cn(
                                        "text-muted-foreground hover:text-foreground flex",
                                        "w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left",
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
                        ))
                    )}
                </div>
            </ScrollPane>
        </div>
    );
}

/**
 * The sheet of a narrow window: the same list over the transcript.
 *
 * From `lg` the list is the column instead, and the button that opens this sheet
 * lives below that breakpoint. A window that grows past it lets the sheet go: a
 * hidden sheet is not a closed one, and the body has no pointer events of its own
 * while a modal is up (see `use-wide-window.ts`).
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

    useEffect(() => {
        if (wide) onOpenChange(false);
    }, [wide, onOpenChange]);

    return (
        // Vaul assumes the bottom of the screen unless it is told: a drawer anchored
        // to the left edge has to arrive from the left and be dragged sideways.
        <Sheet open={open} onOpenChange={onOpenChange} direction="left">
            <SheetContent
                id={id}
                overlayClassName="bg-surface-container-highest/70 fixed inset-0 z-40 lg:hidden"
                className={cn(
                    // A square left edge and a round right one: the sheet arrives
                    // from the edge it is anchored to. The clip is what holds it:
                    // the panel inside paints its own square background, and
                    // nothing cuts it to the corner without this.
                    "bg-surface-dim border-border w-72 max-w-[85%]",
                    "overflow-hidden rounded-r-xl border-r outline-none",
                    "lg:hidden",
                    className,
                )}
            >
                <SheetTitle className="sr-only">Sessions</SheetTitle>
                {/* The sheet leaves the page for a portal, where the shell's safe area
                    does not reach: it keeps its own sides, or the panel's first and last
                    rows would sit under the system bars. */}
                <SafeArea side="vertical" className="h-full">
                    {children}
                </SafeArea>
            </SheetContent>
        </Sheet>
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
