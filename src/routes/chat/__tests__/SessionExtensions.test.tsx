import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { ExtensionSnapshot } from "@/lib/bridge";
import { queryDefaults, sessionKeys } from "@/lib/query";
import { SessionExtensions } from "@/routes/chat/topbar/SessionExtensions";

const SESSION = "main:1";

function snapshot(statuses: { key: string; text: string }[]): ExtensionSnapshot {
    return { requests: [], statuses, title: null, editorText: null };
}

function show(statuses: { key: string; text: string }[]) {
    const client = new QueryClient(queryDefaults);
    client.setQueryData(sessionKeys.extension(SESSION), snapshot(statuses));
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return render(<SessionExtensions session={SESSION} />, { wrapper });
}

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
