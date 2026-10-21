/**
 * The region of a session: the transcript, the line under it, and the composer.
 *
 * The chart of the session lives in the registry (`lib/session/registry.ts`), which follows the
 * sessions of the connection: this region selects it and never creates it. The transcript is
 * the fold of the base read and the records that arrived after it (`lib/transcript/merge.ts`).
 *
 * The bar, the list and the window's frame belong to the workspace (`ChatScreen`); this is the
 * page under the bar, and the only thing a pick or a switch replaces.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useSelector } from "@xstate/react";
import { toast } from "sonner";
import { useExtensionUi, useMotion, useVisualViewport, type SessionView } from "@/hooks";
import * as bridge from "@/lib/bridge";
import type { SessionRef } from "@/lib/session";
import { queuedRows, transcriptRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/transcript";
import { mergedTranscript } from "@/lib/transcript";
import { Composer } from "@/routes/chat/composer/Composer";
import { ExtensionPrompt } from "@/routes/chat/transcript/ExtensionPrompt";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

export interface SessionMainProps {
    session: string;
    machine: SessionRef;
    view: SessionView;
}

/** The fields of the composer: a keyboard they raise moves the transcript with them. */
function isComposerField(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target.closest("[data-composer-field]") !== null;
}

/**
 * The main page of one session: the transcript, the line under it, and the composer. The
 * screen only mounts it once the session is loaded; loading is a page of its own.
 */
export function SessionMain({ session, machine, view }: SessionMainProps) {
    const { phase, working, entries } = view;
    const extension = useExtensionUi(session);
    const { stage: page, slot } = useMotion();
    const { height: viewportHeight } = useVisualViewport();
    const [composerFocused, setComposerFocused] = useState(false);
    const body = useRef<HTMLDivElement>(null);
    const keyboardReach = useRef(0);

    // The keyboard reports a few intermediate heights while it opens. Read the visual
    // viewport in the event itself, not one render later, so the content moves with the
    // keyboard rather than after it. Keep the largest inset while it stays open: a later,
    // smaller reading must not move the layout back. The shell keeps the layout viewport;
    // only a composer field's keyboard moves the transcript and the composer together.
    useEffect(() => {
        const update = () => {
            const viewport = window.visualViewport;
            const gap =
                viewport === null || viewport === undefined ? 0 : Math.max(0, window.innerHeight - viewport.height);
            const raw = viewport !== null && viewport !== undefined && viewport.scale === 1 && gap >= 100 ? gap : 0;
            keyboardReach.current = raw === 0 ? 0 : Math.max(keyboardReach.current, raw);
            const overlap = composerFocused ? keyboardReach.current : 0;
            if (body.current !== null) {
                body.current.style.top = overlap > 0 ? `calc(var(--safe-area-bottom, 0px) - ${overlap}px)` : "";
            }
        };
        update();
        const viewport = window.visualViewport;
        viewport?.addEventListener("resize", update);
        viewport?.addEventListener("scroll", update);
        window.addEventListener("resize", update);
        return () => {
            viewport?.removeEventListener("resize", update);
            viewport?.removeEventListener("scroll", update);
            window.removeEventListener("resize", update);
        };
    }, [composerFocused]);

    useEffect(() => {
        const onFocus = (event: FocusEvent) => {
            if (isComposerField(event.target)) setComposerFocused(true);
        };
        const onBlur = (event: FocusEvent) => {
            if (isComposerField(event.target) && !isComposerField(event.relatedTarget)) setComposerFocused(false);
        };
        const onPointerDown = (event: PointerEvent) => {
            if (isComposerField(event.target)) setComposerFocused(true);
        };
        document.addEventListener("focusin", onFocus);
        document.addEventListener("focusout", onBlur);
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => {
            document.removeEventListener("focusin", onFocus);
            document.removeEventListener("focusout", onBlur);
            document.removeEventListener("pointerdown", onPointerDown, true);
        };
    }, []);
    const overlay = useSelector(machine, (snapshot) => snapshot.context.overlay);
    const live = useSelector(machine, (snapshot) => snapshot.context.live);
    const queued = useSelector(machine, (snapshot) => snapshot.context.queued);
    const rowIds = useSelector(machine, (snapshot) => snapshot.context.rowIds);

    // The transcript is the base read and the records folded together, then the rows the
    // run writes now, the line under it, and the queue. The settled half is recomputed
    // only when the base or the overlay changes, not on every delta.
    const base = entries.data ?? null;
    const merged = useMemo(() => mergedTranscript(base, overlay), [base, overlay]);
    const settled = useMemo(() => transcriptRows(merged, merged.leaf, rowIds), [merged, rowIds]);
    const moving = useMemo(
        () => [...liveRows(live), ...activityRows(phase), ...queuedRows(queued)],
        [live, phase, queued],
    );
    const rows = useMemo(() => [...settled, ...moving], [settled, moving]);
    const empty = rows.length === 0;

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

    const transcript = (
        <SessionTranscript
            rows={rows}
            working={working}
            onRetractQueued={retractQueue}
            viewportHeight={composerFocused ? viewportHeight : undefined}
        />
    );

    return (
        <>
            <ExtensionPrompt
                request={extension.request}
                onAnswer={(answer) => {
                    if (extension.request !== null) extension.answer(extension.request.id, answer);
                }}
            />
            <div ref={body} id="session-body" className="relative flex min-h-0 flex-1 flex-col">
                <AnimatePresence mode="wait" initial={false}>
                    {empty ? null : (
                        <motion.div key="words" {...page} className="flex min-h-0 flex-1">
                            {transcript}
                        </motion.div>
                    )}
                </AnimatePresence>
                <motion.div
                    id="composer-band"
                    {...slot}
                    className="relative z-20 mt-auto mb-4 flex shrink-0 items-center justify-center"
                >
                    <div
                        id="composer-fade"
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-full h-8"
                    >
                        <div className="mx-auto size-full max-w-5xl">
                            <div className="h-full bg-linear-to-t from-surface to-surface/0" />
                        </div>
                    </div>
                    <div className="mx-auto w-full max-w-5xl px-4">
                        {empty && (
                            <p className="pb-3 text-center text-body-md text-muted-foreground">
                                Nothing has been said yet.
                            </p>
                        )}
                        <Composer
                            session={session}
                            working={working}
                            machine={machine}
                            editorText={extension.state?.editorText ?? null}
                        />
                    </div>
                </motion.div>
            </div>
        </>
    );
}
