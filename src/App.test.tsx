import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
    it("increments the counter on click", async () => {
        const user = userEvent.setup();
        render(<App />);

        const button = screen.getByRole("button", { name: /count is 0/i });
        await user.click(button);

        expect(screen.getByRole("button", { name: /count is 1/i })).toBeInTheDocument();
    });
});
