import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useActorRef } from "@xstate/react";
import { longPressMachine } from "@/machines/long-press.machine";

export interface LongPressHandlers {
    /** The row that owns the gesture. */
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    /** Keeps a touch's native context menu from covering the one pie opened. */
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    /** Whether the click that follows a long press must not pick the row. */
    consumeClick: () => boolean;
}

/**
 * Opens a menu from a long touch without letting the release pick the row.
 *
 * A tap still belongs to the row. A touch that stays within a finger's slop for
 * half a second becomes a long press while the finger is still down. The browser's
 * compatibility press after a touch would otherwise be read by the menu trigger as
 * a second press and close the menu, so that one press is swallowed.
 */
export function useLongPress(onLongPress: () => void): LongPressHandlers {
    const callback = useRef(onLongPress);
    const fired = useRef(false);
    const pressed = useRef<HTMLElement | null>(null);
    const stopSuppression = useRef<(() => void) | null>(null);

    useEffect(() => {
        callback.current = onLongPress;
    }, [onLongPress]);

    useEffect(() => {
        return () => {
            stopSuppression.current?.();
            stopSuppression.current = null;
        };
    }, []);

    /**
     * The compatibility press that follows a touch would toggle the freshly opened menu
     * closed. Cancelling the touch's end keeps the browser from making that press at all;
     * the row's click guard is the fallback if one still arrives.
     */
    function swallowRelease(target: HTMLElement) {
        stopSuppression.current?.();
        stopSuppression.current = null;

        const onTouchEnd = (event: TouchEvent) => {
            event.preventDefault();
            cleanup();
        };
        const cleanup = () => {
            target.removeEventListener("touchend", onTouchEnd, true);
            stopSuppression.current = null;
        };
        stopSuppression.current = cleanup;
        target.addEventListener("touchend", onTouchEnd, { capture: true, once: true, passive: false });
    }

    const actor = useActorRef(longPressMachine, {
        input: {
            onLongPress: () => {
                fired.current = true;
                const target = pressed.current;
                if (target !== null) swallowRelease(target);
                callback.current();
            },
        },
    });

    const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        fired.current = false;
        stopSuppression.current?.();
        stopSuppression.current = null;
        if (event.pointerType !== "touch") return;
        pressed.current = event.currentTarget;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        actor.send({ type: "PRESS", x: event.clientX, y: event.clientY, touch: true });
    };
    const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch") return;
        actor.send({ type: "MOVE", x: event.clientX, y: event.clientY });
    };
    const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch") return;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
        actor.send({ type: "RELEASE" });
        pressed.current = null;
    };
    const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch") return;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
        actor.send({ type: "CANCEL" });
        stopSuppression.current?.();
        stopSuppression.current = null;
        pressed.current = null;
    };
    const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
        if (fired.current) event.preventDefault();
    };
    const consumeClick = () => {
        const consumed = fired.current;
        fired.current = false;
        stopSuppression.current?.();
        stopSuppression.current = null;
        return consumed;
    };

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu, consumeClick };
}
