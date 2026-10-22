/**
 * The pictures staged for the next message: one card apiece, with the name the picker gave
 * it and the size it carries.
 *
 * The strip scrolls sideways rather than wrapping, so a message with several pictures keeps
 * the words and the controls in the same place. When it overruns, a gradient and a chevron
 * say which way there is more; the pointer still scrolls the strip itself.
 */

import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui";
import { Icon, ScrollPane, TruncatedText } from "@/components";
import { useMotion } from "@/hooks";
import type { StagedAttachment } from "@/machines/attachments.machine";
import { EASE, MOTION } from "@/lib/motion";

export interface AttachmentsProps {
    items: readonly StagedAttachment[];
    onRemove: (id: string) => void;
    /** Merged into the strip last, for a caller that places it. */
    className?: string;
}

export function Attachments({ items, onRemove, className }: AttachmentsProps) {
    const { still, slot } = useMotion();
    const strip = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ left: false, right: false });

    /** Reads how much of the strip lies beyond each edge, and lights the keys there. */
    const measure = useCallback(() => {
        const element = strip.current;
        if (element === null) return;
        const beyond = element.scrollWidth - element.clientWidth;
        setEdges({
            left: element.scrollLeft > 1,
            right: beyond > 1 && element.scrollLeft < beyond - 1,
        });
    }, []);

    useEffect(() => {
        measure();
        const element = strip.current;
        if (element === null) return;
        element.addEventListener("scroll", measure, { passive: true });
        if (typeof ResizeObserver === "undefined") {
            return () => element.removeEventListener("scroll", measure);
        }
        const watch = new ResizeObserver(measure);
        watch.observe(element);
        return () => {
            element.removeEventListener("scroll", measure);
            watch.disconnect();
        };
    }, [items, measure]);

    function nudge(direction: -1 | 1) {
        strip.current?.scrollBy({ left: direction * 250, behavior: still ? "auto" : "smooth" });
    }

    return (
        <div className={cn("relative", className)}>
            <ScrollPane bars="none" className="min-w-0" viewportRef={strip}>
                <ul id="composer-attachments" aria-label="Attachments" className="flex gap-2.5 px-3">
                    <AnimatePresence initial={false} onExitComplete={measure}>
                        {items.map((item) => (
                            <motion.li
                                key={item.id}
                                layout={still ? false : "position"}
                                transition={{
                                    layout: still
                                        ? { duration: 0 }
                                        : { type: "tween", duration: MOTION.slot.out, ease: EASE.settle },
                                }}
                                {...slot}
                                className="
                                    group relative flex h-16 w-60 shrink-0 items-center gap-2.5 overflow-hidden
                                    rounded-2xl border border-foreground/12 bg-card py-0 pr-9 pl-3
                                "
                            >
                                {item.type === "image" ? (
                                    <img
                                        alt=""
                                        src={`data:${item.image.mimeType};base64,${item.image.data}`}
                                        className="size-12 shrink-0 rounded-xl object-cover"
                                    />
                                ) : (
                                    <div
                                        className="
                                            flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted
                                            text-muted-foreground
                                        "
                                    >
                                        <Icon className="size-6">
                                            <FileText />
                                        </Icon>
                                    </div>
                                )}
                                <div className="flex h-12 min-w-0 flex-col justify-around">
                                    <TruncatedText
                                        content={item.name}
                                        className="text-(length:--text-label-lg) font-medium text-foreground"
                                        offset={{ top: 8, right: 12, bottom: 8, left: 12 }}
                                    >
                                        {item.name}
                                    </TruncatedText>
                                    <TruncatedText
                                        content={subtitleOf(item)}
                                        className="text-(length:--text-label-md) text-muted-foreground"
                                        offset={{ top: 8, right: 12, bottom: 8, left: 12 }}
                                    >
                                        {subtitleOf(item)}
                                    </TruncatedText>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label={`Remove ${item.name}`}
                                    onClick={() => onRemove(item.id)}
                                    className="
                                        absolute top-1.75 right-1.75 z-30 size-4.5 rounded-full bg-foreground p-0
                                        text-background opacity-0 transition-opacity
                                        group-focus-within:opacity-100
                                        group-hover:opacity-100
                                        hover:cursor-pointer hover:bg-foreground hover:text-background
                                        focus-visible:opacity-100
                                        dark:hover:bg-foreground dark:hover:text-background
                                        pointer-coarse:opacity-100
                                    "
                                >
                                    <Icon className="size-4.5 [&_svg]:size-3">
                                        <X />
                                    </Icon>
                                </Button>
                                <AnimatePresence>
                                    {item.type === "file" && item.uploading && (
                                        <motion.div
                                            key="upload-mask"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            exit={{ opacity: 0 }}
                                            transition={{ duration: MOTION.slot.out, ease: EASE.settle }}
                                            className="
                                                pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-2xl
                                            "
                                        >
                                            <div className="absolute inset-0 bg-background/50 backdrop-blur-[0.5px]" />
                                            <div
                                                className="
                                                    absolute inset-y-0 left-0 border-r border-primary/50 bg-primary/20
                                                    transition-all duration-150 ease-out
                                                "
                                                style={{
                                                    width: `${Math.min(100, Math.max(0, Math.round((item.progress ?? 0) * 100)))}%`,
                                                }}
                                            />
                                            <span
                                                className="
                                                    absolute right-2 bottom-1.5 font-mono text-[10px] font-medium
                                                    text-foreground/70
                                                "
                                            >
                                                {Math.round((item.progress ?? 0) * 100)}%
                                            </span>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.li>
                        ))}
                    </AnimatePresence>
                </ul>
            </ScrollPane>
            {edges.left && <Edge side="left" onPress={() => nudge(-1)} />}
            {edges.right && <Edge side="right" onPress={() => nudge(1)} />}
        </div>
    );
}

/** The gradient over the cards at one end of the strip, and the key that goes past it. */
function Edge({ side, onPress }: { side: "left" | "right"; onPress: () => void }) {
    return (
        <div
            className={cn(
                "pointer-events-none absolute inset-y-0 z-10 flex w-21.5 items-center",
                side === "left"
                    ? `
                        left-0 justify-start
                        bg-[linear-gradient(to_right,var(--card)_0%,var(--card)_40%,transparent_100%)] pl-1.5
                    `
                    : `
                        right-0 justify-end
                        bg-[linear-gradient(to_left,var(--card)_0%,var(--card)_40%,transparent_100%)] pr-1.5
                    `,
            )}
        >
            <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Scroll attachments ${side}`}
                onClick={onPress}
                className="
                    pointer-events-auto size-9 rounded-full text-muted-foreground
                    hover:bg-accent/50 hover:text-foreground
                    dark:hover:bg-accent/50
                "
            >
                <Icon className="size-4">{side === "left" ? <ChevronLeft /> : <ChevronRight />}</Icon>
            </Button>
        </div>
    );
}

/** Formats a byte count into a readable string. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kilobytes = bytes / 1024;
    if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
    const megabytes = kilobytes / 1024;
    return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

function subtitleOf(item: StagedAttachment): string {
    if (item.type === "file") {
        if (item.uploading) {
            return `Uploading · ${formatBytes(item.size)}`;
        }
        return `${kindOf(item.name, item.mimeType ?? "")} · ${formatBytes(item.size)}`;
    }
    return `${kindOf(item.name, item.image.mimeType)} · ${sizeOf(item.image.data)}`;
}

/** The extension the reader named, or the subtype of the type the picker reported. */
function kindOf(name: string, mimeType: string): string {
    const dot = name.lastIndexOf(".");
    const extension = dot === -1 ? "" : name.slice(dot + 1);
    return (extension || mimeType.split("/")[1] || "image").toUpperCase();
}

/** A base64 quartet carries three bytes; the padding carries none. */
function sizeOf(data: string): string {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding);
    return formatBytes(bytes);
}
