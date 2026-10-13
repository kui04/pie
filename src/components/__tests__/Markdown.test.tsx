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

    it("keeps nothing of a row it cannot name", () => {
        // Without an id there is nothing to key the parse by, so nothing is kept.
        const first = render(<Markdown>Anonymous</Markdown>);
        first.unmount();
        render(<Markdown>Anonymous</Markdown>);

        expect(parser).toHaveBeenCalledTimes(2);
    });
});
