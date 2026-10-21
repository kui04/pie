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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import type { QueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useExtensionUi, useMotion, useSession, useVirtualKeyboardInset, useVisualViewport } from "@/hooks";
import * as bridge from "@/lib/bridge";
import { sessionKeys } from "@/lib/query";
import { sessionOf, subscribeSessions, type SessionRef } from "@/lib/session";
import { queuedRows, transcriptRows } from "@/lib/transcript";
import { activityRows, liveRows } from "@/lib/transcript";
import { mergedTranscript } from "@/lib/transcript";
import { Composer } from "@/routes/chat/composer/Composer";
import { ExtensionPrompt } from "@/routes/chat/transcript/ExtensionPrompt";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SessionTranscript } from "@/routes/chat/transcript/SessionTranscript";

export interface SessionMainProps {
    session: string;
    client: QueryClient;
}

/** The fields of the composer: a keyboard they raise moves the transcript with them. */
function isComposerField(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target.closest("[data-composer-field]") !== null;
}

/**
 * The slot of one session: it selects the chart of the registry and hands the body that actor.
 * The body is rendered only when the chart is there, so its hooks are unconditional.
 */
export function SessionMain({ session, client }: SessionMainProps) {
    const machine = useSyncExternalStore(
        subscribeSessions,
        () => sessionOf(session),
        () => null,
    );
    if (machine === null) {
        // The registry has the charts of the connection, and this session is one of them; this
        // is the frame or two before it arrived.
        return (
            <div className="relative flex min-h-0 flex-1">
                <SessionLoading />
            </div>
        );
    }
    return <SessionBody session={session} client={client} machine={machine} />;
}

function SessionBody({ machine, session, client }: SessionMainProps & { machine: SessionRef }) {
    const { phase, working, state, entries, stats, ready, error, reopen } = useSession(session, machine);
    const extension = useExtensionUi(session);
    const { stage: page, slot } = useMotion();
    const { height: viewportHeight } = useVisualViewport();
    const keyboardInset = useVirtualKeyboardInset().insetHeight;
    const [composerFocused, setComposerFocused] = useState(false);
    const body = useRef<HTMLDivElement>(null);
    const keyboardReach = useRef(0);

    // The keyboard reports a few intermediate heights while it opens. Keep the largest
    // one while it stays open: a later, smaller reading must not move the layout back.
    // The shell keeps the layout viewport; only a composer field's keyboard moves the
    // transcript and the composer, and it moves them together.
    useLayoutEffect(() => {
        keyboardReach.current = keyboardInset === 0 ? 0 : Math.max(keyboardReach.current, keyboardInset);
        const overlap = composerFocused ? keyboardReach.current : 0;
        if (body.current !== null) {
            body.current.style.top = overlap > 0 ? `calc(var(--safe-area-bottom, 0px) - ${overlap}px)` : "";
        }
    }, [composerFocused, keyboardInset]);

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

    // The words of a conversation are on screen when its base read answered. A chart that
    // outlived the cache of an earlier screen can be ready with no base in hand; the view
    // then waits for the answer instead of painting the overlay alone.
    const loaded = ready && base !== null;
    const composerOn = loaded && error === null;
    const empty = loaded && rows.length === 0;

    // Two kinds of failure reach this screen: the listeners never opened, which the chart
    // reports, and a read, which the query holds. They are read in that order.
    const failure = error ?? entries.error ?? state.error ?? stats.error;

    const retry = () => {
        reopen();
        void client.invalidateQueries({ queryKey: ["connection"] });
        void client.invalidateQueries({ queryKey: sessionKeys.whole(session) });
    };

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
    let content: ReactNode;
    if (failure !== null) {
        content = (
            <motion.div key="failure" {...page} className="flex min-h-0 flex-1">
                <div
                    id="chat-failure"
                    role="alert"
                    className="
                        m-auto flex max-w-prose flex-col items-center gap-3 px-6 text-center text-body-md
                        text-muted-foreground
                    "
                >
                    <p>{bridge.asPieError(failure).message}</p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={retry}>
                            Try again
                        </Button>
                        <Button variant="ghost" size="sm" render={<Link to="/" />} nativeButton={false}>
                            Connect
                        </Button>
                    </div>
                </div>
            </motion.div>
        );
    } else if (!loaded) {
        content = (
            <motion.div key="loading" {...page} className="relative flex min-h-0 flex-1">
                <SessionLoading />
            </motion.div>
        );
    } else if (rows.length === 0) {
        content = null;
    } else {
        content = (
            <motion.div key="words" {...page} className="flex min-h-0 flex-1">
                {transcript}
            </motion.div>
        );
    }

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
                    {content}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                    {composerOn && (
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
                    )}
                </AnimatePresence>
            </div>
        </>
    );
}
