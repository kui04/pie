import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@/components/Markdown";

/** What one source becomes: blocks, inline formulas, errors, and text that stayed text. */
const draw = (id: string, source: string) => {
    const view = render(<Markdown id={id}>{source}</Markdown>);
    const inline = [...view.container.querySelectorAll(".katex")].filter(
        (element) => element.closest(".katex-display") === null,
    ).length;
    return {
        blocks: view.container.querySelectorAll(".katex-display").length,
        inline,
        error: view.container.querySelectorAll(".katex-error").length,
        text: (view.container.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
};

describe("the dollars in a model's prose", () => {
    it("sets a pair of dollars as a block", () => {
        // A model writes display math on one line; micromark only reads a block from the
        // two-line form.
        const alone = draw("alone", "$$x^2$$");
        expect(alone.blocks).toBe(1);
        expect(alone.inline).toBe(0);

        const twoLines = draw("two-lines", "所以漂移是\n$$\nt s - s^2/(2n)\n$$\n到此为止。");
        expect(twoLines.blocks).toBe(1);
    });

    it("draws the shape a real answer has", () => {
        // A line of words, then a line of math, over and over - and half of those math lines
        // carry a sentence after the formula.
        const dense = draw(
            "dense",
            "第一段。\n$$P(T\\ge k)\\le e^{-\\theta k}.$$ 累积常数 $=1$。\n第二段。\n$$1-\\rho=e^{-c\\rho}.$$\n第三段。",
        );

        expect(dense.blocks).toBe(2);
        expect(dense.inline).toBe(1);
        expect(dense.text).toContain("累积常数");
        expect(dense.error).toBe(0);
    });

    it("leaves a single pair of dollars inline", () => {
        const view = draw("inline", "记作 $x^2$ 就完了。");

        expect(view.blocks).toBe(0);
        expect(view.inline).toBe(1);
    });

    it("tells a price and a variable from a formula", () => {
        // pi's own renderer asks these questions; a pair that fails them is text.
        const money = draw("money", "it costs $5 and then $10 more.");
        expect(money.text).toContain("it costs $5 and then $10 more");
        expect(money.inline).toBe(0);

        expect(draw("variable", "The file under $HOME/config is read on start.").inline).toBe(0);
        // And a formula is not a price.
        expect(draw("real", "The energy is $E = mc^2$ exactly.").inline).toBe(1);
    });

    it("puts back the dollars of a pair that swallowed a sentence", () => {
        // The shape that made a wall of raw LaTeX in a real answer: an opening pair of dollars
        // pairing with a much later one, so the paragraph between them read as one formula.
        // KaTeX cannot read a dollar in math mode - it says so and hands back the source - so
        // such a pair was never a formula. The reader gets the paragraph, dollars and all.
        const view = draw(
            "drift",
            "所以\n$$X\\approx\\frac{n}{\\sqrt{2\\pi}}\\cdot\\frac23 k^{-3/2}.$$ 令累积数 $=1$：\n$$Y$$\n到这里。",
        );

        expect(view.error).toBe(0);
        expect(view.text).toContain("令累积数");
        expect(view.text).toContain("到这里");
    });

    it("shows a formula it cannot read without losing the words around it", () => {
        // A broken command is KaTeX's problem: it draws it in the app's error colour, and the
        // rest of the message is still the message.
        const view = draw("broken", "Before. $\\frac{1}{$ After. $\\notacommand{x}$ End.");

        expect(view.text).toContain("Before.");
        expect(view.text).toContain("End.");
        expect(view.error).toBeGreaterThan(0);
    });
});
