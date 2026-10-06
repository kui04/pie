import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { useConnection } from "@/hooks/use-connection";
import { queryDefaults } from "@/lib/query";

/**
 * The one connection, read back from Rust, with a bridge that answers what a test
 * tells it to. Nothing here starts pi: the hook is under test, and the bridge is
 * only its path to the outside.
 */

const fake = vi.hoisted(() => ({
    getConnection: vi.fn<() => Promise<Bridge.ConnectionInfo | null>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...fake,
}));

const INFO: Bridge.ConnectionInfo = {
    id: "main",
    endpoint: "local",
    sessions: [{ id: "main:0", cwd: "/home/pie" }],
};

describe("the connection of the workspace", () => {
    let client: QueryClient;

    beforeEach(() => {
        fake.getConnection.mockReset();
        client = new QueryClient(queryDefaults);
    });

    function render() {
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        return renderHook(() => useConnection(), { wrapper });
    }

    it("reads the one connection from Rust, and the session to subscribe to", async () => {
        fake.getConnection.mockResolvedValue(INFO);

        const { result } = render();

        await waitFor(() => expect(result.current.data).toEqual(INFO));
        expect(result.current.data?.sessions[0]?.id).toBe("main:0");
        expect(fake.getConnection).toHaveBeenCalledTimes(1);
    });

    it("reads no connection as null, not as a failure", async () => {
        fake.getConnection.mockResolvedValue(null);

        const { result } = render();

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it("does not ask a second time when the read fails", async () => {
        fake.getConnection.mockRejectedValue({
            type: "commands",
            message: "pie could not reach its own backend",
        });

        const { result } = render();

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(fake.getConnection).toHaveBeenCalledTimes(1);
        expect(result.current.error?.message).toBe("pie could not reach its own backend");
    });
});
