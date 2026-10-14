import {
    Button,
    Popover,
    PopoverContent,
    PopoverDescription,
    PopoverHeader,
    PopoverTitle,
    PopoverTrigger,
    Separator,
} from "@/components/ui";
import type { SessionStats } from "@/lib/rpc-protocol";
import { costText, formatTokens, percentText, tokenBreakdown, usageTone } from "@/routes/chat/topbar/usage";

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The colour of a reading, the way pi's footer colours the same number. */
const TONE = {
    normal: { text: "", stroke: "stroke-primary-text" },
    warning: { text: "text-warning", stroke: "stroke-warning" },
    error: { text: "text-destructive", stroke: "stroke-destructive" },
} as const;

/**
 * The usage of the context window: the ring in the bar, and everything the
 * session reports behind it.
 *
 * The bar carries the ring alone; the number is read here. A percent of `null`
 * is a reading pi does not have yet - right after a compaction - so the ring
 * shows its track alone rather than a zero.
 */
export function UsagePopover({
    id,
    stats,
    auto,
}: {
    id: string;
    stats: SessionStats | null;
    /** Whether pi compacts the context on its own. */
    auto: boolean;
}) {
    const usage = stats?.contextUsage ?? null;
    const percent = usage?.percent ?? null;
    const tone = TONE[usageTone(percent)];
    const breakdown = stats === null ? "" : tokenBreakdown(stats.tokens);
    // The reading is not on screen, so the button says it out loud.
    const label = percent === null ? "Context usage" : `Context usage ${percentText(percent)}`;
    return (
        <Popover>
            <PopoverTrigger
                render={
                    <Button id={id} variant="ghost" size="icon-xs" aria-label={label}>
                        <Ring percent={percent} stroke={tone.stroke} />
                    </Button>
                }
            />
            <PopoverContent align="end" className="w-60 gap-2">
                <PopoverHeader>
                    <PopoverTitle className="text-label-md">Context usage</PopoverTitle>
                </PopoverHeader>
                <p className={`text-title-md font-medium tabular-nums ${tone.text}`}>{percentText(percent)}</p>
                {usage !== null && (
                    <p className="text-body-sm text-muted-foreground tabular-nums">
                        {usage.tokens === null ? "--" : formatTokens(usage.tokens)} /{" "}
                        {formatTokens(usage.contextWindow)} tokens
                        {auto && " (auto)"}
                    </p>
                )}
                {stats !== null && (
                    <>
                        <Separator className="bg-divider" />
                        {breakdown !== "" && (
                            <p className="text-body-sm text-muted-foreground tabular-nums">{breakdown}</p>
                        )}
                        {stats.cost > 0 && (
                            <PopoverDescription className="text-body-sm text-muted-foreground tabular-nums">
                                Session cost {costText(stats.cost)}
                            </PopoverDescription>
                        )}
                        <Separator className="bg-divider" />
                        <dl className="text-body-sm text-muted-foreground grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
                            <dt>Messages</dt>
                            <dd>{stats.totalMessages}</dd>
                            <dt>User messages</dt>
                            <dd>{stats.userMessages}</dd>
                            <dt>Assistant messages</dt>
                            <dd>{stats.assistantMessages}</dd>
                            <dt>Tool calls</dt>
                            <dd>{stats.toolCalls}</dd>
                            <dt>Tool results</dt>
                            <dd>{stats.toolResults}</dd>
                        </dl>
                    </>
                )}
            </PopoverContent>
        </Popover>
    );
}

function Ring({ percent, stroke }: { percent: number | null; stroke: string }) {
    // A context can run past its window; the ring fills and the number beside it
    // keeps the truth.
    const fraction = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100));
    return (
        <svg viewBox="0 0 20 20" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
            <circle cx="10" cy="10" r={RING_RADIUS} fill="none" strokeWidth="2.5" className="stroke-border" />
            {percent !== null && (
                <circle
                    cx="10"
                    cy="10"
                    r={RING_RADIUS}
                    fill="none"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
                    className={stroke}
                />
            )}
        </svg>
    );
}
