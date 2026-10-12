import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { ModelPicker, type ModelPickerProps } from "@/routes/chat/composer/ModelPicker";
import { model } from "@/preview/fixtures";

type Call = (...args: unknown[]) => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    getAvailableModels: vi.fn<Call>(),
    setModel: vi.fn<Call>(),
    providerLogo: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/**
 * The key with a client above it. Whether the popup is open is the caller's state, so
 * this holds it the way the composer does; a click on the key opens the popup.
 */
function renderPicker(props: Partial<ModelPickerProps> = {}) {
    const client = new QueryClient(queryDefaults);
    function Harness() {
        const [open, setOpen] = useState(false);
        return <ModelPicker session="main:1" current={null} open={open} onOpenChange={setOpen} {...props} />;
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
    bridge.setModel.mockResolvedValue({});
    bridge.providerLogo.mockResolvedValue(null);
});

/** A host that offers `count` models of one provider. */
const catalogue = (count: number) =>
    Array.from({ length: count }, (_, index) =>
        model({ id: `model-${index}`, name: `Model ${index}`, provider: "opencode" }),
    );

describe("the model of the session", () => {
    it("shows the active model, and marks it in the list", async () => {
        const user = userEvent.setup();
        renderPicker({ current: model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }) });

        expect(screen.getByRole("button", { name: "Choose the model" })).toHaveTextContent("DeepSeek Flash");

        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // The list holds every model, and the one in use is the one the select marks as
        // chosen - the check the select draws beside it.
        expect(await screen.findByRole("option", { name: /DeepSeek Flash/ })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("option", { name: /Claude Sonnet 4.5/ })).toHaveAttribute("aria-selected", "false");
    });

    it("sets the model that was chosen, and reads the state again", async () => {
        const user = userEvent.setup();
        const { client } = renderPicker({ current: model() });
        // The state of the session is what reports the new model; a change marks it
        // stale so that the next render reads it.
        client.setQueryData(["session", "main:1", "state"], { sessionId: "0193" });

        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        await user.click(await screen.findByRole("option", { name: /DeepSeek Flash/ }));

        await waitFor(() => expect(bridge.setModel).toHaveBeenCalledWith("main:1", "deepseek", "deepseek-flash"));
        expect(client.getQueryState(["session", "main:1", "state"])?.isInvalidated).toBe(true);
    });

    it("draws the mark of a provider, and the key when it has none", async () => {
        const user = userEvent.setup();
        bridge.providerLogo.mockImplementation(async (provider) =>
            provider === "deepseek" ? "data:image/svg+xml;base64,PHN2Zy8+" : null,
        );

        const { container } = renderPicker({ current: model() });

        // The model in use is anthropic's, which has no mark here: the fallback key
        // stands where a mark would.
        await waitFor(() => expect(bridge.providerLogo).toHaveBeenCalledWith("anthropic"));
        expect(container.querySelector('[data-provider="anthropic"]')).toBeNull();
        expect(container.querySelector("svg.lucide-bot")).not.toBeNull();

        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // The row of deepseek carries its mark; the row of anthropic keeps the key.
        // The popup is a portal, so the rows are found in the document.
        await waitFor(() => expect(document.querySelector('[data-provider="deepseek"]')).not.toBeNull());
        expect(document.querySelector('[data-provider="anthropic"]')).toBeNull();
    });

    it("asks Rust once for the mark of a provider", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({
            models: [
                model({ id: "flash", name: "Flash", provider: "deepseek" }),
                model({ id: "chat", name: "Chat", provider: "deepseek" }),
            ],
        });
        bridge.providerLogo.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");

        renderPicker({ current: model({ id: "flash", name: "Flash", provider: "deepseek" }) });
        await waitFor(() => expect(bridge.providerLogo).toHaveBeenCalledWith("deepseek"));

        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // Two rows of the same provider: the mark is already held, and Rust is not
        // asked again within the day it is good for.
        expect(await screen.findByRole("option", { name: /Flash/ })).toBeInTheDocument();
        expect(await screen.findByRole("option", { name: /Chat/ })).toBeInTheDocument();
        expect(bridge.providerLogo).toHaveBeenCalledTimes(1);
    });

    it("draws forty rows of a catalog of hundreds, led by the model in use", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(600) });

        renderPicker({ current: model({ id: "model-500", name: "Model 500", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // Every model is offered, and forty of them are drawn: the row in use leads
        // them, because it may sit anywhere in the catalog.
        const options = await screen.findAllByRole("option");
        expect(options).toHaveLength(40);
        expect(options[0]).toHaveTextContent("Model 500");
        expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("finds a model that lies past the rows it draws", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(600) });

        renderPicker({ current: model({ id: "model-0", name: "Model 0", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        await screen.findAllByRole("option");

        // The search reads the whole catalog, not the forty rows drawn: a model the
        // cap leaves out is reached by typing its name.
        await user.type(screen.getByPlaceholderText("Search models"), "Model 555");

        const found = await screen.findByRole("option", { name: /Model 555/ });
        expect(found).toHaveAttribute("aria-selected", "true");

        // And Enter takes the row the keyboard is on, which is the first match.
        await user.keyboard("{Enter}");
        await waitFor(() => expect(bridge.setModel).toHaveBeenCalledWith("main:1", "opencode", "model-555"));
    });
});
