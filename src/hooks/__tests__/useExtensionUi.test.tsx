import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { ExtensionUIRequest } from "@/lib/rpc-protocol";
import { queryDefaults } from "@/lib/query";
import { useExtensionUi } from "@/hooks/useExtensionUi";

const fake = vi.hoisted(() => ({
    getExtensionState: vi.fn<(session: string) => Promise<Bridge.ExtensionSnapshot>>(),
    onExtensionEvent:
        vi.fn<(session: string, onEvent: (event: Bridge.ExtensionEvent) => void) => Promise<() => void>>(),
    answerExtension: vi.fn<(session: string, id: string, answer: Bridge.ExtensionAnswer) => Promise<boolean>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...fake,
}));

const SESSION = "main:1";

function request(): ExtensionUIRequest {
    return {
        type: "extension_ui_request",
        id: "q-1",
        method: "input",
        title: "Name",
    };
}

function empty(): Bridge.ExtensionSnapshot {
    return { requests: [], statuses: [], title: null, editorText: null };
}

function withRequest(): Bridge.ExtensionSnapshot {
    return { ...empty(), requests: [request()] };
}

let client: QueryClient;

function mount() {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(() => useExtensionUi(SESSION), { wrapper });
}

beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient(queryDefaults);
    fake.getExtensionState.mockResolvedValue(empty());
    fake.onExtensionEvent.mockResolvedValue(() => undefined);
    fake.answerExtension.mockResolvedValue(true);
});

afterEach(() => {
    client.clear();
});

describe("useExtensionUi", () => {
    it("reads the snapshot after it subscribes, for a request that arrived first", async () => {
        fake.getExtensionState.mockResolvedValue(withRequest());
        const rendered = mount();

        await waitFor(() => expect(rendered.result.current.request?.id).toBe("q-1"));
        expect(rendered.result.current.state).not.toBeNull();
        expect(fake.onExtensionEvent).toHaveBeenCalledTimes(1);
        expect(fake.getExtensionState).toHaveBeenCalledTimes(1);
    });

    it("answers a dialog and reads the queue again", async () => {
        fake.getExtensionState.mockResolvedValue(withRequest());
        const rendered = mount();
        await waitFor(() => expect(rendered.result.current.request).not.toBeNull());

        rendered.result.current.answer("q-1", { type: "value", value: "pie" });
        await waitFor(() =>
            expect(fake.answerExtension).toHaveBeenCalledWith(SESSION, "q-1", { type: "value", value: "pie" }),
        );
    });

    it("closes its listener when the session body leaves", async () => {
        const stop = vi.fn();
        fake.onExtensionEvent.mockResolvedValue(stop);
        const rendered = mount();
        await waitFor(() => expect(fake.onExtensionEvent).toHaveBeenCalledTimes(1));

        rendered.unmount();
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
