import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { ModePickers, type ComposerPanel, type ModePickersProps } from "@/routes/chat/components/composer/ModePickers";
import { model } from "@/preview/fixtures";

type Call = (...args: unknown[]) => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    getAvailableModels: vi.fn<Call>(),
    getAvailableThinkingLevels: vi.fn<Call>(),
    setModel: vi.fn<Call>(),
    setThinkingLevel: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/**
 * The two keys with a client above them. Which panel is open is the caller's state,
 * so this holds it the way the composer does; a click on a key opens the panel that
 * belongs to it.
 */
function renderPickers(props: Partial<ModePickersProps> = {}) {
    const client = new QueryClient(queryDefaults);
    function Harness() {
        const [panel, setPanel] = useState<ComposerPanel>(null);
        return (
            <ModePickers
                session="main:1"
                model={null}
                thinking={null}
                panel={panel}
                onOpenChange={setPanel}
                {...props}
            />
        );
    }
    const view = render(
        <QueryClientProvider client={client}>
            <Harness />
        </QueryClientProvider>,
    );
    return { ...view, client };
}

beforeEach(() => {
    vi.clearAllMocks();
    bridge.getAvailableModels.mockResolvedValue({
        models: [model(), model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" })],
    });
    bridge.getAvailableThinkingLevels.mockResolvedValue({ levels: ["off", "low", "high"] });
    bridge.setModel.mockResolvedValue({});
    bridge.setThinkingLevel.mockResolvedValue(undefined);
});

describe("the model of the session", () => {
    it("shows the active model, and marks it in the list", async () => {
        const user = userEvent.setup();
        renderPickers({ model: model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }) });

        expect(screen.getByRole("button", { name: "Choose the model" })).toHaveTextContent("DeepSeek Flash");

        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // The list holds every model, and the one in use is the one the select marks as
        // chosen - the check the select draws beside it.
        expect(await screen.findByRole("option", { name: /DeepSeek Flash/ })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("option", { name: /Claude Sonnet 4.5/ })).toHaveAttribute("aria-selected", "false");
    });

    it("sets the model that was chosen, and reads the state again", async () => {
        const user = userEvent.setup();
        const { client } = renderPickers({ model: model() });
        // The state of the session is what reports the new model; a change marks it
        // stale so that the next render reads it.
        client.setQueryData(["session", "main:1", "state"], { sessionId: "0193" });

        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        await user.click(await screen.findByRole("option", { name: /DeepSeek Flash/ }));

        await waitFor(() => expect(bridge.setModel).toHaveBeenCalledWith("main:1", "deepseek", "deepseek-flash"));
        expect(client.getQueryState(["session", "main:1", "state"])?.isInvalidated).toBe(true);
    });
});

describe("the thinking level of the session", () => {
    it("sets the level that was chosen", async () => {
        const user = userEvent.setup();
        const { client } = renderPickers({ thinking: "off" });
        client.setQueryData(["session", "main:1", "state"], { sessionId: "0193" });

        expect(screen.getByRole("button", { name: "Choose the thinking level" })).toHaveTextContent("off");
        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));
        await user.click(await screen.findByRole("option", { name: "high" }));

        await waitFor(() => expect(bridge.setThinkingLevel).toHaveBeenCalledWith("main:1", "high"));
        expect(client.getQueryState(["session", "main:1", "state"])?.isInvalidated).toBe(true);
    });

    it("does not call for the level that is already in use", async () => {
        const user = userEvent.setup();
        renderPickers({ thinking: "low" });

        await user.click(screen.getByRole("button", { name: "Choose the thinking level" }));
        // The row in use carries its check, which is part of its name.
        await user.click(await screen.findByRole("option", { name: /low/ }));

        expect(bridge.setThinkingLevel).not.toHaveBeenCalled();
    });
});
