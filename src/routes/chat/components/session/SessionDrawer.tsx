/**
 * The sessions of the host, for the column that is beside the transcript, or for
 * the sheet that covers it.
 *
 * The rows are files, not protocol: `listSessions` reads the sessions directory of
 * the host. What a row says is the work of `session.ts` beside this file.
 *
 * A pick returns the path of a row, and nothing here decides what that does: the
 * workspace knows which session pi holds.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Folder, RefreshCw, Search } from "lucide-react";
import { motion, useAnimationFrame, useReducedMotion } from "motion/react";
import { cn } from "cn";
import { SafeArea } from "@/components/SafeArea";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import * as bridge from "@/lib/bridge";
import { reasonFor } from "@/lib/failure-text";
import { REFRESH_TURN } from "@/lib/motion";
import { sessionsQueries } from "@/lib/query";
import { breatheAt, groupSessions, matchesSearch, pathKey, relativeTime, sessionTitle } from "./session";
import { FAILURE_REASON } from "@/routes/chat/failure-reason";

/**
 * The space an icon of a group head takes. A row holds the same space with nothing
 * in it, so a session's name starts where the directory above it starts.
 */
const ICON_SLOT = "size-4 shrink-0";

export interface SessionDrawerProps {
    /** The id of the panel, and the prefix of the ids of its rows. */
    id: string;
    /** The host whose sessions these are (`local`, or `user@host:port`). */
    endpoint: string;
    /** The id of the conversation this window shows, as pi names it. */
    currentSessionId: string | null;
    /** Whether that conversation is working now. */
    working: boolean;
    /**
     * A switch is on its way, or that conversation is working: a row that is chosen
     * now would be a second switch on top of the first.
     */
    busy: boolean;
    /** Continue the conversation of the row that was chosen. */
    onPick: (path: string) => void;
    className?: string;
}

export function SessionDrawer({
    id,
    endpoint,
    currentSessionId,
    working,
    busy,
    onPick,
    className,
}: SessionDrawerProps) {
    const client = useQueryClient();
    const sessions = useQuery(sessionsQueries.list(endpoint));
    const [search, setSearch] = useState("");
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    // The turn of the key, counted rather than held: every press is one turn of its
    // own, and two presses in a row play two (the `key` of the icon is this number).
    const [turns, setTurns] = useState(0);
    const still = useReducedMotion();
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
        <SafeArea id={id} side="vertical" className={cn("bg-surface-dim flex min-h-0 flex-col", className)}>
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
                        className="text-body-md!"
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
                    // The read is not stale on its own (a session file changes
                    // without an event), so this key is the only thing that asks
                    // for the list again.
                    disabled={sessions.isFetching}
                    onClick={() => {
                        setTurns((before) => before + 1);
                        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
                    }}
                >
                    <motion.span
                        // A key of its own per press: a turn is played from its start
                        // every time. The first draw has no turn in it - a list that
                        // was just opened was asked for nothing.
                        key={turns}
                        className="flex"
                        initial={turns === 0 || still ? false : { rotate: 0 }}
                        animate={{ rotate: 360 }}
                        transition={still ? { duration: 0 } : REFRESH_TURN}
                    >
                        <RefreshCw className="size-4" />
                    </motion.span>
                </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {sessions.isError ? (
                    <p id={`${id}-failure`} role="alert" className="text-body-md text-muted-foreground px-1 py-2">
                        {reasonFor(bridge.asPieError(sessions.error), FAILURE_REASON)}
                    </p>
                ) : sessions.isPending ? (
                    // The host may be a machine across a network: an empty list is
                    // not yet a fact while the first read is on its way.
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
                                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left"
                            >
                                <Folder className={ICON_SLOT} aria-hidden />
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
                                        current={session.id === currentSessionId}
                                        working={working}
                                        busy={busy}
                                        onPick={onPick}
                                    />
                                ))}
                        </section>
                    ))
                )}
            </div>
        </SafeArea>
    );
}

/**
 * One session of the list.
 *
 * A row says its name, or the words that opened it, or the time it was last
 * written when it has neither. The light of a row is a fact of a process: the
 * session this window shows has one behind it, and `working` says that process is
 * in a run now — the light covers the same slot and changes colour. Either way it
 * breathes: a light that is there is a light that is alive.
 */
function SessionRow({
    id,
    session,
    now,
    current,
    working,
    busy,
    onPick,
}: {
    id: string;
    session: bridge.SessionSummary;
    now: number;
    current: boolean;
    working: boolean;
    busy: boolean;
    onPick: (path: string) => void;
}) {
    const title = sessionTitle(session);
    const when = relativeTime(session.modified, now);
    const mark = current ? (working ? "working" : "attached") : null;

    return (
        <button
            type="button"
            // The key of the file names the row: a path is not a selector, and a copy
            // of a session file carries the same id in its header (see `pathKey`).
            id={`${id}-row-${pathKey(session.path)}`}
            data-path={session.path}
            aria-current={current ? "true" : undefined}
            disabled={busy}
            onClick={() => onPick(session.path)}
            className={cn(
                "hover:bg-accent flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left disabled:pointer-events-none disabled:opacity-60",
                current && "bg-accent",
            )}
        >
            <span className={ICON_SLOT} aria-hidden />
            <span className="text-body-md min-w-0 flex-1 truncate">{title ?? when}</span>
            {mark !== null && (
                <>
                    <Light
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
 * when a row goes away mid-breath (see `BREATHE_CYCLE`). Under `prefers-reduced-motion`
 * the dot is simply lit.
 */
function Light({ className }: { className?: string }) {
    const dot = useRef<HTMLSpanElement>(null);
    const still = useReducedMotion();
    useAnimationFrame((ms) => {
        if (still || dot.current === null) return;
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
