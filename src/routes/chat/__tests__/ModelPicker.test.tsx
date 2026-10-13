import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualizerHandle } from "virtua";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import type { Model } from "@/lib/rpc-protocol";
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
 * What the picker asks of the list of the rows, and what it says to it. virtua draws a window
 * of the list, which happy-dom cannot lay out, so the list is drawn whole here - the picker's
 * own reading of the rows is what these tests are about.
 */
const asked = vi.hoisted(() => ({
    bufferSize: 0,
    itemSize: 0,
    scrolls: [] as { index: number; align?: string }[],
}));

vi.mock("virtua", () => ({
    Virtualizer: ({
        children,
        data,
        itemSize,
        bufferSize,
        ref,
    }: {
        children: (row: Model, index: number) => ReactNode;
        data: readonly Model[];
        itemSize?: number;
        bufferSize?: number;
        ref?: RefObject<VirtualizerHandle | null>;
    }) => {
        asked.bufferSize = bufferSize ?? 0;
        asked.itemSize = itemSize ?? 0;
        useLayoutEffect(() => {
            if (ref) {
                ref.current = {
                    scrollToIndex: (index: number, opts?: { align?: string }) => {
                        asked.scrolls.push({ index, align: opts?.align });
                    },
                } as unknown as VirtualizerHandle;
            }
        }, [ref]);
        return <>{data.map((row, index) => children(row, index))}</>;
    },
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
    asked.scrolls.length = 0;
    asked.bufferSize = 0;
    asked.itemSize = 0;
    bridge.getAvailableModels.mockResolvedValue({
        models: [model(), model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" })],
    });
    bridge.setModel.mockResolvedValue({});
    bridge.providerLogo.mockResolvedValue(null);
});

/** A host that offers `count` models of one provider, named after it. */
const catalogue = (count: number, provider: string, label: string) =>
    Array.from({ length: count }, (_, index) => model({ id: `model-${index}`, name: `${label} ${index}`, provider }));

describe("the model of the session", () => {
    it("shows the active model, and marks it in the list", async () => {
        const user = userEvent.setup();
        renderPicker({ current: model({ id: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek" }) });

        expect(screen.getByRole("button", { name: "Choose the model" })).toHaveTextContent("DeepSeek Flash");

        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // Nothing is lit until the pointer or a key moves the light: the list leads with the
        // model in use, and it wears the check that says so - and no light of its own.
        const inUse = await screen.findByRole("option", { name: /DeepSeek Flash/ });
        expect(inUse).toContainElement(screen.getByLabelText("In use"));
        expect(inUse).toHaveAttribute("aria-selected", "false");
        expect(screen.getByRole("option", { name: /Claude Sonnet 4.5/ })).toHaveAttribute("aria-selected", "false");
    });

    it("puts aria-selected on the row the light is on, not on the model in use", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(6, "opencode", "Model") });

        renderPicker({ current: model({ id: "model-0", name: "Model 0", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        const options = await screen.findAllByRole("option");
        expect(options[0]).toHaveAttribute("aria-selected", "false");

        // The pointer moves the light - and the selection with it, because the light is the
        // row Enter would take - while the check stays on the model in use.
        fireEvent.mouseMove(options[4]!);
        expect(options[4]).toHaveAttribute("aria-selected", "true");
        expect(options[0]).toHaveAttribute("aria-selected", "false");
        expect(options[0]).toContainElement(screen.getByLabelText("In use"));
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

    it("holds the shape of the list while the models are on their way", async () => {
        const user = userEvent.setup();
        // A read that never answers: the popup is opened before the catalog is here.
        bridge.getAvailableModels.mockReturnValue(new Promise(() => undefined));

        renderPicker({ current: model() });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(10);
        expect(screen.getByRole("status", { name: "Loading the models" })).toBeInTheDocument();
        expect(screen.queryAllByRole("option")).toEqual([]);
    });

    it("says what happened when the models cannot be read", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockRejectedValue(new Error("the session is gone"));

        renderPicker({ current: model() });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // A read that failed is not a search that found nothing.
        expect(await screen.findByText("Could not read the models.")).toBeInTheDocument();
        expect(screen.queryByText("No match.")).toBeNull();
        expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
    });

    it("draws every model of a catalog of hundreds, led by the model in use", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({
            models: [...catalogue(300, "anthropic", "Claude"), ...catalogue(300, "deepseek", "DeepSeek")],
        });

        renderPicker({ current: model({ id: "model-150", name: "DeepSeek 150", provider: "deepseek" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));

        // Every model of the host is offered, not the first of them alone: the row in
        // use leads, and the rest follow one provider after another, as pi lists them.
        const options = await screen.findAllByRole("option");
        expect(options).toHaveLength(600);
        expect(options[0]).toHaveTextContent("DeepSeek 150");
        expect(options[0]).toHaveAttribute("aria-selected", "false");
        expect(options[1]).toHaveTextContent("Claude 0");
        expect(options[300]).toHaveTextContent("Claude 299");
        expect(options[301]).toHaveTextContent("DeepSeek 0");
        expect(options[599]).toHaveTextContent("DeepSeek 299");
        // The row in use is in the list once, where it leads it.
        expect(screen.getAllByRole("option", { name: /DeepSeek 150/ })).toHaveLength(1);
    });

    it("finds a model by any way it is named", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(600, "opencode", "Model") });

        renderPicker({ current: model({ id: "model-0", name: "Model 0", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        await screen.findAllByRole("option");

        // The search reads the whole catalog and ranks it by pi's own matching: the words
        // of the query may come in any order, and the rows follow the ranking.
        await user.type(screen.getByPlaceholderText("Search models"), "555 model");

        const options = await screen.findAllByRole("option");
        expect(options[0]).toHaveTextContent("Model 555");
        // The cursor is on the best match, which is the row the keyboard is on - the
        // mark of the model in use is a different thing and stays on that row.
        expect(screen.getByRole("combobox", { name: "Search models" })).toHaveAttribute(
            "aria-activedescendant",
            options[0]?.id,
        );

        // And Enter takes the row the keyboard is on, which is the first match.
        await user.keyboard("{Enter}");
        await waitFor(() => expect(bridge.setModel).toHaveBeenCalledWith("main:1", "opencode", "model-555"));
    });

    it("ranks a provider's own model over a proxy that spells the same model out", async () => {
        const user = userEvent.setup();
        // One host that reaches the same model twice: its own provider, and a proxy whose id
        // spells the provider's name out. This is the pair pi's search text is built for.
        bridge.getAvailableModels.mockResolvedValue({
            models: [
                model({ provider: "openrouter", id: "openai/gpt-5", name: "GPT-5 (proxy)" }),
                model({ provider: "openai", id: "gpt-5", name: "GPT-5" }),
                model({ provider: "openai", id: "gpt-5-codex", name: "GPT-5 Codex" }),
                model({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }),
            ],
        });
        const names = () => screen.queryAllByRole("option").map((row) => row.textContent);

        renderPicker({ current: model({ provider: "openai", id: "gpt-5", name: "GPT-5" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        const search = screen.getByRole("combobox", { name: "Search models" });

        // `provider/id` leads with the provider's own model, and a slash splits the query
        // like a space does.
        await user.type(search, "openai/gpt-5");
        expect(names()).toEqual(["GPT-5", "GPT-5 Codex", "GPT-5 (proxy)"]);

        // The words of a query may come in any order, and either case.
        await user.clear(search);
        await user.type(search, "CODEX openai");
        expect(names()).toEqual(["GPT-5 Codex"]);

        // A word of the name of a model finds it too.
        await user.clear(search);
        await user.type(search, "sonnet");
        expect(names()).toEqual(["Claude Sonnet 4.5"]);

        // A word that no model holds empties the list rather than halving it.
        await user.clear(search);
        await user.type(search, "openai llama");
        expect(names()).toEqual([]);
        expect(screen.getByText("No match.")).toBeInTheDocument();
    });

    it("lights the row under the pointer, and gives the light back when the pointer leaves", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(20, "opencode", "Model") });

        renderPicker({ current: model({ id: "model-0", name: "Model 0", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        const options = await screen.findAllByRole("option");
        const search = screen.getByRole("combobox", { name: "Search models" });
        expect(search).not.toHaveAttribute("aria-activedescendant");

        // The pointer lights the row it is over.
        const fourth = options[3];
        fireEvent.mouseMove(fourth!);
        expect(search).toHaveAttribute("aria-activedescendant", fourth?.id);
        expect(fourth).toHaveAttribute("data-lit", "true");
        expect(options[0]).toHaveAttribute("data-lit", "false");

        // Leaving the list takes the light with it, and the keyboard has not moved it.
        fireEvent.mouseLeave(screen.getByRole("listbox", { name: "Models" }));
        expect(search).not.toHaveAttribute("aria-activedescendant");
        expect(options[0]).toHaveAttribute("data-lit", "false");
        expect(fourth).toHaveAttribute("data-lit", "false");
    });

    it("reads every row in the same ink, and marks the model in use with its check alone", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(4, "opencode", "Model") });

        renderPicker({ current: model({ id: "model-2", name: "Model 2", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        const options = await screen.findAllByRole("option");

        // One shape and one ink for all of them: what tells the row in use apart is its
        // check, and what tells the light apart is the light.
        expect(new Set(options.map((row) => row.className)).size).toBe(1);
        expect(options[0]).toContainElement(screen.getByLabelText("In use"));
        expect(screen.getAllByLabelText("In use")).toHaveLength(1);
    });

    it("draws the rows past the popup ahead of a scroll, and keeps the cursor in view", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(600, "opencode", "Model") });

        renderPicker({ current: model({ id: "model-0", name: "Model 0", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        await screen.findAllByRole("option");

        // Six hundred rows are never drawn at once: the list is a window, and the rows either
        // side of it are drawn ahead so a fast scroll does not arrive before them.
        expect(asked.bufferSize).toBe(800);
        expect(asked.itemSize).toBe(40);

        // The row the keyboard stands on is a position in the list, not an element to find:
        // the list is what brings it into view. The first key down stands on the first row.
        await user.keyboard("{ArrowDown}");
        expect(asked.scrolls[asked.scrolls.length - 1]).toEqual({ index: 0, align: "nearest" });
        await user.keyboard("{ArrowDown}");
        expect(asked.scrolls[asked.scrolls.length - 1]).toEqual({ index: 1, align: "nearest" });
    });

    it("moves the cursor over the whole list with the arrows", async () => {
        const user = userEvent.setup();
        bridge.getAvailableModels.mockResolvedValue({ models: catalogue(600, "opencode", "Model") });

        renderPicker({ current: model({ id: "model-0", name: "Model 0", provider: "opencode" }) });
        await user.click(screen.getByRole("button", { name: "Choose the model" }));
        const options = await screen.findAllByRole("option");
        const cursor = screen.getByRole("combobox", { name: "Search models" });
        expect(cursor).not.toHaveAttribute("aria-activedescendant");

        // Nothing is lit until a key moves the light, and the first one down stands on the
        // first row: the list is one cursor deep, whatever its length.
        await user.keyboard("{ArrowDown}");
        expect(cursor).toHaveAttribute("aria-activedescendant", options[0]?.id);
        await user.keyboard("{ArrowDown}");
        expect(cursor).toHaveAttribute("aria-activedescendant", options[1]?.id);
        await user.keyboard("{Enter}");

        await waitFor(() => expect(bridge.setModel).toHaveBeenCalledWith("main:1", "opencode", "model-1"));
    });
});
