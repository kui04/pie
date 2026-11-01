import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { useExtensionStore } from "@/lib/extension/store";
import { idOf } from "@/lib/session";
import { conversation } from "@/preview/fixtures";
import { useExtensionUi } from "@/hooks/useExtensionUi";

const fake = vi.hoisted(() => ({
    answer: vi.fn<(id: number, answer: Bridge.Answer) => Promise<boolean>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...fake,
}));

const CONVERSATION = conversation({ session: "main:1" });

function asked(id: number, title: string): void {
    useExtensionStore.getState().asked(CONVERSATION, id, { method: "input", title });
}

beforeEach(() => {
    vi.clearAllMocks();
    useExtensionStore.setState({ dialogs: {}, statuses: {}, editors: {} });
    fake.answer.mockResolvedValue(true);
});

describe("useExtensionUi", () => {
    it("draws the dialog at the head of the queue", () => {
        asked(1, "Name");
        asked(2, "Second");

        const rendered = renderHook(() => useExtensionUi(CONVERSATION));

        expect(rendered.result.current.request?.id).toBe(1);
    });

    it("answers a dialog under the id it arrived with, and forgets it", async () => {
        asked(1, "Name");
        const rendered = renderHook(() => useExtensionUi(CONVERSATION));

        act(() => rendered.result.current.answer(1, { type: "value", value: "pie" }));

        await waitFor(() =>
            expect(fake.answer).toHaveBeenCalledWith(1, {
                status: "resolved",
                data: { type: "value", value: "pie" },
            }),
        );
        await waitFor(() => expect(rendered.result.current.request).toBeNull());
    });

    it("takes its statuses and its editor text from the same store", () => {
        useExtensionStore.getState().reported(CONVERSATION, { key: "permissions", text: "waiting" });
        useExtensionStore.getState().edited(CONVERSATION, "a draft");

        const rendered = renderHook(() => useExtensionUi(CONVERSATION));

        expect(rendered.result.current.statuses).toEqual([{ key: "permissions", text: "waiting" }]);
        expect(rendered.result.current.editorText).toBe("a draft");
    });

    it("holds nothing for a conversation that was never asked", () => {
        const rendered = renderHook(() => useExtensionUi(conversation({ session: "/other.jsonl" })));

        expect(rendered.result.current.request).toBeNull();
        expect(rendered.result.current.statuses).toEqual([]);
        expect(rendered.result.current.editorText).toBeNull();
    });

    it("keys the store by the connection and the file together", () => {
        asked(1, "Name");
        const elsewhere = renderHook(() => useExtensionUi({ ...CONVERSATION, host: "other" }));

        expect(elsewhere.result.current.request).toBeNull();
        expect(idOf(CONVERSATION)).toContain(CONVERSATION.session);
    });
});
