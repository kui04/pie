import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useExtensionStore } from "@/lib/extension";
import { idOf } from "@/lib/session";
import { conversation } from "@/preview/fixtures";
import { SessionExtensions } from "@/routes/chat/topbar/SessionExtensions";

const CONVERSATION = conversation({ session: "main:1" });

function show(statuses: { key: string; text: string }[]) {
    useExtensionStore.setState({ statuses: { [idOf(CONVERSATION)]: statuses }, dialogs: {}, editors: {} });
    return render(<SessionExtensions conversation={CONVERSATION} />);
}

beforeEach(() => {
    useExtensionStore.setState({ statuses: {}, dialogs: {}, editors: {} });
});

describe("SessionExtensions", () => {
    it("opens the status popover and marks a reported status", async () => {
        show([{ key: "permissions", text: "Waiting for approval" }]);

        const key = screen.getByRole("button", { name: "Extensions" });
        expect(document.querySelector("#session-extensions-status")).not.toBeNull();
        fireEvent.click(key);

        expect(await screen.findByText("permissions")).toBeInTheDocument();
        expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    });

    it("draws no dot when no extension reported a status", () => {
        show([]);
        expect(document.querySelector("#session-extensions-status")).toBeNull();
    });
});
