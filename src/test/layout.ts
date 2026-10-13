/*
 * happy-dom lays nothing out and its own ResizeObserver never fires, so a measuring
 * list has no viewport to fill and draws no rows. Every observed element is reported
 * as a pane tall enough for one; rows keep the library's estimate, because happy-dom
 * leaves `offsetParent` undefined.
 */

/** Tall enough for a screenful at the library's smallest estimate. */
const VIEWPORT = 800;

class Reported implements ResizeObserver {
    private readonly seen = new Set<Element>();
    private live = true;

    constructor(private readonly report: ResizeObserverCallback) {}

    observe(target: Element): void {
        if (this.seen.has(target)) return;
        this.seen.add(target);
        const entry = { target, contentRect: { width: VIEWPORT, height: VIEWPORT } } as ResizeObserverEntry;
        // Reported after the frame's layout, not inside the call that asked for it:
        // hearing it while React still mounts its rows would set state in a render.
        queueMicrotask(() => {
            if (this.live) this.report([entry], this);
        });
    }

    unobserve(target: Element): void {
        this.seen.delete(target);
    }

    disconnect(): void {
        this.seen.clear();
        this.live = false;
    }
}

/** Let the tests' DOM answer a measuring component. */
export function pretendLayout(): void {
    window.ResizeObserver = Reported;
}
