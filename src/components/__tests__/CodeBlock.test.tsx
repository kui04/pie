import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "@/components/CodeBlock";
import { loadHighlighter } from "@/lib/code-highlight";

const CODE = "const a: number = 1;";

/** Waits for the highlighter's own chunk, the way the browser waits for it. */
const chunkLands = () => act(async () => void (await loadHighlighter()));

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("CodeBlock", () => {
    it("writes the language of the fence and copies the code", () => {
        const view = render(<CodeBlock code={CODE} language="ts" id="block" />);

        expect(view.container.textContent).toContain("ts");
        expect(view.container.textContent).toContain(CODE);
        expect(view.getByRole("button", { name: "Copy code" }).id).toBe("block-copy");
    });

    it("colours a block that is standing still", async () => {
        const view = render(<CodeBlock code={CODE} language="ts" />);
        // Nothing to colour it with until the chunk has landed, and the words are drawn
        // either way.
        await chunkLands();

        const token = view.container.querySelector("code span");
        expect(token).not.toBeNull();
        expect(view.container.querySelector("code")?.textContent).toBe(CODE);
    });

    it("waits for a block whose words are still arriving", async () => {
        const view = render(<CodeBlock code={CODE} language="ts" />);
        await chunkLands();

        // A run redraws a growing block on every frame, and colouring a long one costs a
        // frame of its own: the new words are drawn at once, without colours.
        view.rerender(<CodeBlock code={`${CODE}\nconst b: string = "x";`} language="ts" />);
        expect(view.container.querySelector("code span")).toBeNull();
        expect(view.container.querySelector("code")?.textContent).toContain("const b");

        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        expect(view.container.querySelector("code span")).not.toBeNull();
        expect(view.container.querySelector("code")?.textContent).toContain("const b");
    });

    it("draws the final newline as the end of the last line", async () => {
        const view = render(<CodeBlock code={`${CODE}\n`} language="ts" />);
        await chunkLands();

        expect(view.container.querySelectorAll(String.raw`[data-slot="code-block-line"]`)).toHaveLength(1);
    });

    it("keeps its side scroll in the app's pane", () => {
        const view = render(<CodeBlock code={CODE} language="ts" />);
        const pane = view.container.querySelector(String.raw`[data-slot="scroll-area"]`);
        const content = view.container.querySelector(String.raw`[data-slot="code-block-content"]`);

        expect(pane).not.toBeNull();
        expect(pane?.querySelector(String.raw`[data-slot="scroll-area-viewport"]`)).not.toBeNull();
        expect(content?.className).toContain("overflow-visible");
    });

    it("scrolls long lines until the reader asks for wrap", () => {
        const view = render(<CodeBlock code={CODE} language="ts" id="block" />);
        const content = view.container.querySelector(String.raw`[data-slot="code-block-content"]`);

        expect(content?.hasAttribute("data-wrap")).toBe(false);

        fireEvent.click(view.getByRole("button", { name: "Wrap lines" }));

        expect(view.getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed")).toBe("true");
        expect(content?.hasAttribute("data-wrap")).toBe(true);
    });

    it("draws a block of a language it does not know as the words it is", async () => {
        const view = render(<CodeBlock code="SELECT 1;" language="cobol" />);
        await chunkLands();

        expect(view.container.querySelector("code span")).toBeNull();
        expect(view.container.querySelector("code")?.textContent).toBe("SELECT 1;");
    });
});
