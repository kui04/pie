import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ThoughtRow } from "@/routes/chat/transcript/entries/ThoughtRow";

describe("ThoughtRow", () => {
    it("keeps its body in the app's scroll pane", () => {
        const view = render(<ThoughtRow id="t1" thinking="look first" stillThinking />);
        const pane = view.container.querySelector(String.raw`[data-slot="scroll-area"]`);

        expect(pane).not.toBeNull();
        expect(pane?.querySelector(String.raw`[data-slot="scroll-area-viewport"]`)).not.toBeNull();
        expect(pane?.querySelector(".live-window")).not.toBeNull();
    });
});
