import { assign, setup } from "xstate";

/** How long a touch has to stay still before it counts as a long press. */
export const LONG_PRESS_MS = 500;
/** How far a touch may drift before the press belongs to a scroll. */
export const LONG_PRESS_SLOP = 10;

interface LongPressContext {
    x: number;
    y: number;
    /** Called once when the press becomes long. The hook supplies it as input. */
    onLongPress: () => void;
}

type LongPressEvent =
    | { type: "PRESS"; x: number; y: number; touch: boolean }
    | { type: "MOVE"; x: number; y: number }
    | { type: "RELEASE" }
    | { type: "CANCEL" };

export const longPressMachine = setup({
    types: {
        context: {} as LongPressContext,
        events: {} as LongPressEvent,
        input: {} as Pick<LongPressContext, "onLongPress">,
    },
    actions: {
        remember: assign({
            x: ({ event }) => (event.type === "PRESS" ? event.x : 0),
            y: ({ event }) => (event.type === "PRESS" ? event.y : 0),
        }),
        fire: ({ context }) => context.onLongPress(),
    },
    guards: {
        touch: ({ event }) => event.type === "PRESS" && event.touch,
        moved: ({ context, event }) => {
            if (event.type !== "MOVE") return false;
            return Math.abs(event.x - context.x) > LONG_PRESS_SLOP || Math.abs(event.y - context.y) > LONG_PRESS_SLOP;
        },
    },
}).createMachine({
    context: ({ input }) => ({ x: 0, y: 0, onLongPress: input.onLongPress }),
    initial: "idle",
    states: {
        idle: {
            on: {
                PRESS: { guard: "touch", target: "pressing", actions: "remember" },
            },
        },
        pressing: {
            // The press becomes long at the threshold, while the finger is still down.
            after: { [LONG_PRESS_MS]: { target: "fired", actions: "fire" } },
            on: {
                MOVE: { guard: "moved", target: "idle" },
                RELEASE: "idle",
                CANCEL: "idle",
            },
        },
        fired: {
            // Moving after the threshold does not undo the press: the menu is already open.
            on: {
                RELEASE: "idle",
                CANCEL: "idle",
            },
        },
    },
});
