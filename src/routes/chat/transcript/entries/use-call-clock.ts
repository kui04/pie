import { useEffect, useRef, useState } from "react";
import type { ToolStatus } from "@/routes/chat/transcript/presentation";

/**
 * The clock of one call: pi's own number when the result carries it, so the time is the tool's
 * and not this window's; a call still running gets pie's own reading, which the replacement
 * freezes when the result lands.
 */
export function useCallClock(id: string, status: ToolStatus, measured: number | null): string | null {
    const [duration, setDuration] = useState<string | null>(null);
    const seen = useRef<{ id: string; startedAt: number | null; endedAt: number | null; running: boolean }>({
        id,
        startedAt: null,
        endedAt: null,
        running: false,
    });

    useEffect(() => {
        const restarted = id !== seen.current.id;
        if (restarted) seen.current = { id, startedAt: null, endedAt: null, running: false };
        const tick = () => {
            const clock = seen.current;
            const now = Date.now();
            if (status === "running") {
                clock.running = true;
                clock.startedAt ??= now;
                clock.endedAt = null;
                setDuration(formatDuration(now - clock.startedAt));
                return;
            }
            if (!clock.running || clock.startedAt === null) return;
            clock.endedAt ??= now;
            setDuration(formatDuration(clock.endedAt - clock.startedAt));
        };
        const first = setTimeout(() => {
            // A row reused for another call must not show the clock of the call before.
            if (restarted) setDuration(null);
            tick();
        }, 0);
        if (status !== "running") return () => clearTimeout(first);
        const timer = setInterval(tick, 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [status, id]);

    if (measured !== null && status !== "running") return formatDuration(measured);
    return duration;
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${total % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
