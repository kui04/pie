import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one command call the logger makes. Hoisted so that the mock, the module
 * under test and the assertions all hold the same function: `vi.resetModules`
 * re-runs a mock factory, and a factory that builds its own `vi.fn` would leave
 * the test watching a call nobody makes.
 */
const commands = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: commands.invoke }));

/** The levels of the lines this run sent, in order. */
function levels(): string[] {
    return commands.invoke.mock.calls
        .filter(([command]) => command === "log")
        .map(([, args]) => (args as { line: { level: string } }).line.level);
}

/** The lines this run sent, in order. */
function lines(): { level: string; message: string; fields: Record<string, unknown> }[] {
    return commands.invoke.mock.calls
        .filter(([command]) => command === "log")
        .map(
            ([, args]) => (args as { line: { level: string; message: string; fields: Record<string, unknown> } }).line,
        );
}

/** What Rust answers to `log_levels`. */
function keeps(levels: Partial<Record<"error" | "warn" | "info" | "debug" | "trace", boolean>>): void {
    commands.invoke.mockImplementation(async (command: string) => {
        if (command === "log_levels")
            return { error: true, warn: true, info: true, debug: false, trace: false, ...levels };
        return undefined;
    });
}

/** The module holds Rust's answer, so every case starts from a fresh one. */
async function freshLog() {
    vi.resetModules();
    return (await import("@/lib/bridge/log")).log;
}

beforeEach(() => {
    commands.invoke.mockReset();
});

describe("the log of the frontend", () => {
    it("keeps quiet about a level Rust has off, and sends the rest", async () => {
        keeps({});
        const log = await freshLog();

        log.debug("a record arrived", { type: "agent_start" });

        // Nothing is dropped on the way in - until Rust answers, every line goes -
        // and a line the answer turned off is not sent at all. Which of the two a
        // caller is looking at is what this waits for.
        await vi.waitFor(() => {
            const before = levels().length;
            log.debug("has Rust answered?");
            expect(levels().length).toBe(before);
        });

        log.debug("a record arrived", { type: "agent_end" });
        log.info("the window is at a stage", { stage: "loaded" });

        const sent = lines().filter((line) => line.message !== "has Rust answered?");
        expect(sent.map((line) => line.level)).toEqual(["debug", "info"]);
        expect(sent[1]).toEqual({ level: "info", message: "the window is at a stage", fields: { stage: "loaded" } });
    });

    it("sends a line of every level the filter keeps", async () => {
        keeps({ error: true, warn: true, info: true, debug: true, trace: true });
        const log = await freshLog();

        log.error("a read failed");
        log.warn("a call did not reach a command");
        log.info("a conversation was picked");
        log.debug("a record arrived");
        log.trace("a delta arrived");

        expect(levels()).toEqual(["error", "warn", "info", "debug", "trace"]);
    });

    it("asks for the levels once while the bridge cannot answer, not once per line", async () => {
        commands.invoke.mockRejectedValue("the window is not in the app");
        const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
        const log = await freshLog();

        log.error("one");
        await vi.waitFor(() =>
            expect(commands.invoke.mock.calls.filter(([command]) => command === "log_levels")).toHaveLength(1),
        );
        log.error("two");

        expect(commands.invoke.mock.calls.filter(([command]) => command === "log_levels")).toHaveLength(1);
        debug.mockRestore();
    });

    it("drops a line that Rust cannot take, and says so once", async () => {
        commands.invoke.mockRejectedValue("the window is not in the app");
        const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

        const log = await freshLog();
        log.error("a read failed");
        log.error("another read failed");
        await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));

        expect(debug.mock.calls[0][0]).toContain("go nowhere");
        debug.mockRestore();
    });
});
