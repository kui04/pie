/*
 * When the bar shows itself, and when it goes away.
 *
 * How it looks is `src/index.css`'s business; this only says when. `scroll` does
 * not bubble, so the capture phase is the one listener that hears every region -
 * including the ones that do not exist yet. The class only ever means "something
 * is moving": nothing here reads or writes where a region is scrolled to, and the
 * bar's lane keeps its width, so the reader's words never move under it.
 */

const REVEALED = "is-scrolling";

// Long enough to be seen after a flick, short enough not to sit on the words.
const HOLD_MS = 700;

/** Let the bar follow every region's scrolling for the rest of the window's life. */
export function watchScrollbars(): void {
    let hold: ReturnType<typeof setTimeout> | undefined;

    document.addEventListener(
        "scroll",
        () => {
            document.documentElement.classList.add(REVEALED);
            clearTimeout(hold);
            hold = setTimeout(() => document.documentElement.classList.remove(REVEALED), HOLD_MS);
        },
        { capture: true, passive: true },
    );
}
