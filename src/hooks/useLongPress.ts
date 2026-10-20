import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useMachine } from "@xstate/react";
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
 * half a second belongs to the menu, and the click it ends with is swallowed.
 */
export function useLongPress(onLongPress: () => void): LongPressHandlers {
    const callback = useRef(onLongPress);
    const fired = useRef(false);
    const opening = useRef<number | null>(null);

    useEffect(() => {
        callback.current = onLongPress;
    }, [onLongPress]);

    useEffect(() => {
        return () => {
            if (opening.current !== null) window.clearTimeout(opening.current);
        };
    }, []);

    const [, send] = useMachine(longPressMachine, {
        input: {
            onLongPress: () => {
                fired.current = true;
                // The release click must meet a closed menu; it opens after the click.
                opening.current = window.setTimeout(() => {
                    opening.current = null;
                    callback.current();
                }, 0);
            },
        },
    });

    const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        fired.current = false;
        if (event.pointerType !== "touch") return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        send({ type: "PRESS", x: event.clientX, y: event.clientY, touch: true });
    };
    const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch") return;
        send({ type: "MOVE", x: event.clientX, y: event.clientY });
    };
    const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch") return;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
        send({ type: "RELEASE" });
    };
    const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== "touch") return;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
        send({ type: "CANCEL" });
    };
    const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
        if (fired.current) event.preventDefault();
    };
    const consumeClick = () => {
        const consumed = fired.current;
        fired.current = false;
        return consumed;
    };

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu, consumeClick };
}
