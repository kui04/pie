import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type * as ReactMarkdown from "react-markdown";
import { Markdown } from "@/components/Markdown";

vi.mock("react-markdown", async (importOriginal) => ({
    ...(await importOriginal<typeof ReactMarkdown>()),
    default: vi.fn((await importOriginal<typeof ReactMarkdown>()).default),
}));

const parser = vi.mocked((await import("react-markdown")).default);

// Every test here uses its own id: the cache is the component's own and lives as
// long as the module does.
describe("Markdown", () => {
    it("keeps the element of a paragraph while its words change", () => {
        // The words of an answer change on every frame of a run. React identifies a
        // component by its function, so a renderer built again for each frame would
        // unmount every paragraph of the message and mount it anew - the flicker the
        // reader sees, and the reason a moving card never finishes an animation.
        const view = render(<Markdown id="writing">A **bold** paragraph, half.</Markdown>);
        const paragraph = view.container.querySelector("p");

        view.rerender(<Markdown id="writing">A **bold** paragraph, half a sentence.</Markdown>);

        expect(view.container.querySelector("p")).toBe(paragraph);
        expect(paragraph?.textContent).toBe("A bold paragraph, half a sentence.");
    });

    it("draws a row again without parsing it again", () => {
        const first = render(<Markdown id="redraw">A **paragraph**.</Markdown>);
        expect(parser).toHaveBeenCalledTimes(1);
        first.unmount();

        render(<Markdown id="redraw">A **paragraph**.</Markdown>);

        // A row drawn again is not parsed again: that is what the cache is for.
        expect(parser).toHaveBeenCalledTimes(1);
    });

    it("parses the row again when its words change", () => {
        const view = render(<Markdown id="growing">Half</Markdown>);
        view.rerender(<Markdown id="growing">Half a sentence</Markdown>);

        expect(parser).toHaveBeenCalledTimes(2);
    });

    it("sets a formula as a formula", () => {
        const view = render(
            <Markdown id="math">
                {"The energy is $E = mc^2$ exactly.\n\n$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$"}
            </Markdown>,
        );

        // KaTeX's own markup, not the TeX source: `rehype-katex` drew it. The TeX itself
        // stays in the MathML annotation a screen reader reads, which is why the drawn part
        // is what is asked about.
        expect(view.container.querySelectorAll(".katex").length).toBe(2);
        expect(view.container.querySelector(".katex-html")?.textContent).not.toContain("\\frac");
    });

    it("ends the line a model ended", () => {
        // A model writes one newline where it means a line break; rendering it as a space
        // would run two lines together. pi's own renderer answers the same way.
        const view = render(<Markdown id="lines">{"one\ntwo"}</Markdown>);

        expect(view.container.querySelector("br")).not.toBeNull();
        expect(view.container.textContent).toContain("one");
        expect(view.container.textContent).toContain("two");
    });

    it("keeps nothing of a row it cannot name", () => {
        // Without an id there is nothing to key the parse by, so nothing is kept.
        const first = render(<Markdown>Anonymous</Markdown>);
        first.unmount();
        render(<Markdown>Anonymous</Markdown>);

        expect(parser).toHaveBeenCalledTimes(2);
    });
});
