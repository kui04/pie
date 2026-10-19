import { render, screen } from "@testing-library/react";
import { Check } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Icon } from "../Icon";

describe("Icon", () => {
    it("puts a 16px glyph in a centred 24px box", () => {
        render(
            <Icon data-testid="icon">
                <Check />
            </Icon>,
        );

        const icon = screen.getByTestId("icon");
        expect(icon).toHaveAttribute("data-slot", "icon");
        expect(icon).toHaveClass("size-6", "items-center", "justify-center", "[&_svg]:size-4");
        expect(icon.querySelector("svg")).not.toBeNull();
    });

    it("lets cn override the alignment", () => {
        render(
            <Icon data-testid="icon" className="justify-start text-destructive">
                <Check />
            </Icon>,
        );

        const icon = screen.getByTestId("icon");
        expect(icon).toHaveClass("justify-start", "text-destructive");
        expect(icon).not.toHaveClass("justify-center");
    });
});
