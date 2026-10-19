import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createActor } from "xstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { sessionMachine } from "@/machines/session.machine";
import { Composer } from "@/routes/chat/composer/Composer";
import { bashExecution, chain, messageEntry, slashCommand } from "@/preview/fixtures";

type Call = (...args: unknown[]) => Promise<unknown>;

const bridge = vi.hoisted(() => ({
    prompt: vi.fn<Call>(),
    abort: vi.fn<Call>(),
    clearQueue: vi.fn<Call>(),
    bash: vi.fn<Call>(),
    abortBash: vi.fn<Call>(),
    getCommands: vi.fn<Call>(),
    getAvailableModels: vi.fn<Call>(),
    getAvailableThinkingLevels: vi.fn<Call>(),
    setModel: vi.fn<Call>(),
    setThinkingLevel: vi.fn<Call>(),
    pickImages: vi.fn<Call>(),
    getState: vi.fn<Call>(),
    getSessionStats: vi.fn<Call>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/** A refused call, in the shape the boundary sends. */
function refusal(message: string) {
    return { type: "rpc", message, error: { kind: "command" } };
}

/**
 * The chart of the box's session: no listeners and no reads - the box reads its card from
 * the context, and a test sends the events a record would.
 */
function chart() {
    const actor = createActor(sessionMachine, {
        input: {
            listen: () => new Promise<never>(() => undefined),
            reRead: () => undefined,
            notice: () => undefined,
        },
    }).start();
    // The feed is live: the composer stands only where a session is open, and a record
    // draws only there.
    actor.send({ type: "FEED_OPEN", at: 10 });
    return actor;
}

/**
 * The composer with a client above it and the run phase the workspace hands it.
 * Nothing here starts pi: the bridge is what a test tells it to be.
 */
function renderComposer(phase: "idle" | "working" = "idle") {
    const client = new QueryClient(queryDefaults);
    const machine = chart();
    const view = render(
        <QueryClientProvider client={client}>
            <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
                <Composer session="main:1" working={phase !== "idle"} machine={machine} />
            </div>
        </QueryClientProvider>,
    );
    return { ...view, client, machine };
}

/** The box of the composer, which is where a person types. */
function box() {
    return screen.getByRole("textbox", { name: "Your message" });
}

function type(text: string) {
    fireEvent.change(box(), { target: { value: text } });
}

function press(key: string, options: { altKey?: boolean } = {}) {
    fireEvent.keyDown(box(), { key, ...options });
}

beforeEach(() => {
    vi.clearAllMocks();
    bridge.getState.mockResolvedValue({
        model: null,
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "all",
        sessionId: "0193",
        autoCompactionEnabled: false,
        messageCount: 0,
        pendingMessageCount: 0,
    });
    bridge.getSessionStats.mockResolvedValue({});
    bridge.getCommands.mockResolvedValue({ commands: [] });
    bridge.getAvailableModels.mockResolvedValue({ models: [] });
    bridge.getAvailableThinkingLevels.mockResolvedValue({ levels: [] });
    bridge.prompt.mockResolvedValue({ disposition: "started" });
    bridge.abort.mockResolvedValue(undefined);
    bridge.clearQueue.mockResolvedValue({ steering: [], followUp: [] });
    bridge.bash.mockResolvedValue({ output: "", cancelled: false, truncated: false });
    bridge.abortBash.mockResolvedValue(undefined);
    bridge.setModel.mockResolvedValue({});
    bridge.setThinkingLevel.mockResolvedValue(undefined);
    bridge.pickImages.mockResolvedValue(null);
});

describe("the composer sends what was typed", () => {
    it("starts a run with the message when nothing streams", () => {
        renderComposer();
        type("make the parser skip empty lines");

        press("Enter");

        expect(bridge.prompt).toHaveBeenCalledWith("main:1", "make the parser skip empty lines", undefined, undefined);
        expect(box()).toHaveValue("");
    });

    it("steers a run with Enter, and queues a follow-up with Alt+Enter", () => {
        renderComposer("working");

        type("do it the other way");
        press("Enter");
        type("and then run the tests");
        press("Enter", { altKey: true });

        expect(bridge.prompt).toHaveBeenNthCalledWith(1, "main:1", "do it the other way", "steer", undefined);
        expect(bridge.prompt).toHaveBeenNthCalledWith(2, "main:1", "and then run the tests", "followUp", undefined);
    });

    it("sends nothing for an empty box, and nothing for a blank line", () => {
        renderComposer();

        press("Enter");
        type("   ");
        press("Enter");

        expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it("keeps the message box two lines tall, whatever is typed", () => {
        renderComposer();

        const message = box();
        expect(message).toHaveAttribute("rows", "2");
        expect(message.classList.contains("max-h-15")).toBe(true);
        expect(message.classList.contains("min-h-15")).toBe(true);
    });

    it("keeps the words on screen when pi refuses them", async () => {
        // No model, a compaction in progress: pi refuses, and typing it all again
        // is the one thing the person should not have to do.
        bridge.prompt.mockRejectedValue(refusal("pi rejected `prompt`: no model selected"));
        renderComposer();
        type("hello");

        press("Enter");

        await waitFor(() => expect(box()).toHaveValue("hello"));
    });

    it("stops the run while one streams, and the shell command while one runs", async () => {
        renderComposer("working");

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        await waitFor(() => expect(bridge.abort).toHaveBeenCalledWith("main:1"));

        // The run is over (the chart said so) and a shell command of the reader runs:
        // the key stops that one now.
        cleanup();
        const second = renderComposer("idle");
        second.machine.send({ type: "BASH_START", run: { command: "ls", excludeFromContext: false } });
        fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

        await waitFor(() => expect(bridge.abortBash).toHaveBeenCalledWith("main:1"));
    });
});

describe("the composer runs a command of the reader's own shell", () => {
    it("runs `!` in the context of the model, and `!!` outside it", async () => {
        let ran: (value: unknown) => void = () => undefined;
        bridge.bash.mockReturnValue(
            new Promise((resolve) => {
                ran = resolve;
            }),
        );
        const { machine } = renderComposer();

        type("!ls -la");
        press("Enter");
        expect(bridge.bash).toHaveBeenNthCalledWith(1, "main:1", "ls -la", false);
        // The run stands above the card while pi has not recorded it.
        expect(machine.getSnapshot().context.bash).toMatchObject({
            command: "ls -la",
            excludeFromContext: false,
        });
        expect(await screen.findByText("ls -la")).toBeInTheDocument();

        ran({ output: "one\n", cancelled: false, truncated: false });
        // Pi may hold the record back while a turn streams (its own
        // `_pendingBashMessages`): the card stays until the record arrives.
        await waitFor(() => expect(machine.getSnapshot().context.bash).not.toBeNull());

        // The record of the run supersedes the card.
        const [entry] = chain(messageEntry(bashExecution("ls -la", "one\n")));
        machine.send({ type: "RECORD", at: 0, record: { type: "entry_appended", entry } });
        await waitFor(() => expect(machine.getSnapshot().context.bash).toBeNull());

        type("!!make test");
        press("Enter");
        expect(bridge.bash).toHaveBeenNthCalledWith(2, "main:1", "make test", true);
        expect(machine.getSnapshot().context.bash).toMatchObject({
            command: "make test",
            excludeFromContext: true,
        });
    });

    it("refuses a second command while one runs", () => {
        const { machine } = renderComposer();
        machine.send({ type: "BASH_START", run: { command: "sleep 60", excludeFromContext: false } });

        type("!ls");
        press("Enter");

        expect(bridge.bash).not.toHaveBeenCalled();
        expect(box()).toHaveValue("!ls");
    });

    it("keeps the command when pi refuses it", async () => {
        bridge.bash.mockRejectedValue(refusal("pi rejected `bash`: no shell"));
        const { machine } = renderComposer();

        type("!cat notes.txt");
        press("Enter");

        await waitFor(() => expect(box()).toHaveValue("!cat notes.txt"));
        expect(machine.getSnapshot().context.bash).toBeNull();
    });
});

describe("what the composer does with a slash line", () => {
    it("sends a command that pi registered, and never one of pi's terminal commands", async () => {
        bridge.getCommands.mockResolvedValue({ commands: [slashCommand("review", "Review the tree", "extension")] });
        renderComposer();

        // The list of pi is a read of its own; what it holds is what tells a command
        // of pi from a name nothing knows.
        type("/rev");
        await screen.findByText("/review");
        type("/review the diff");
        press("Enter");
        expect(bridge.prompt).toHaveBeenCalledWith("main:1", "/review the diff", undefined, undefined);

        type("/model");
        press("Enter");
        // Pi's terminal commands are its own UI's; over the protocol they would reach
        // the model as words.
        expect(bridge.prompt).toHaveBeenCalledTimes(1);
        expect(box()).toHaveValue("");
    });

    it("refuses a command nothing knows", () => {
        renderComposer();

        type("/make-me-a-sandwich");
        press("Enter");

        expect(bridge.prompt).not.toHaveBeenCalled();
        expect(box()).toHaveValue("");
    });
});

describe("the command menu", () => {
    it("completes a command of pi into the box", async () => {
        bridge.getCommands.mockResolvedValue({ commands: [slashCommand("review", "Review the tree", "extension")] });
        renderComposer();

        type("/rev");

        const item = await screen.findByText("/review");
        fireEvent.click(item);

        expect(box()).toHaveValue("/review ");
        // The menu is gone with the name: the arguments that follow are words.
        await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    });

    it("keeps the keyboard in the box and moves the highlight with the arrows", async () => {
        bridge.getCommands.mockResolvedValue({
            commands: [
                slashCommand("review", "Review the tree", "extension"),
                slashCommand("deploy", "Deploy the app", "skill"),
            ],
        });
        renderComposer();

        type("/");
        // The commands stand in the order pi gave them, so the first is under the
        // keyboard already; Enter takes it rather than sending the line.
        await screen.findByText("/review");
        press("Enter");
        expect(box()).toHaveValue("/review ");

        // The arrows move the highlight, and Enter takes the row it is on: down to
        // the second command, back up to the first.
        type("/");
        await screen.findByText("/deploy");
        press("ArrowDown");
        press("ArrowUp");
        press("Enter");
        expect(box()).toHaveValue("/review ");
        expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it("lights the row under the pointer, and gives it back to the keyboard when it leaves", async () => {
        bridge.getCommands.mockResolvedValue({
            commands: [
                slashCommand("review", "Review the tree", "extension"),
                slashCommand("deploy", "Deploy the app", "skill"),
                slashCommand("release", "Prepare a release", "prompt"),
            ],
        });
        renderComposer();

        type("/");
        const first = await screen.findByRole("option", { name: /review/ });
        const third = screen.getByRole("option", { name: /release/ });
        expect(first).toHaveAttribute("data-lit", "true");

        // The pointer lights the row it is over...
        fireEvent.mouseMove(third);
        expect(third).toHaveAttribute("data-lit", "true");
        expect(first).toHaveAttribute("data-lit", "false");

        // ...and leaving the list gives the light back to the row the keyboard is on.
        fireEvent.mouseLeave(screen.getByRole("listbox", { name: "Commands" }));
        expect(first).toHaveAttribute("data-lit", "true");
        expect(third).toHaveAttribute("data-lit", "false");

        // The keyboard takes the row the light is on, as the popup lists do.
        fireEvent.mouseMove(third);
        press("Enter");
        expect(box()).toHaveValue("/release ");
        expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it("starts the light over on the best match of what is typed now", async () => {
        bridge.getCommands.mockResolvedValue({
            commands: [
                slashCommand("review", "Review the tree", "extension"),
                slashCommand("deploy", "Deploy the app", "skill"),
                slashCommand("release", "Prepare a release", "prompt"),
            ],
        });
        renderComposer();

        type("/re");
        const release = await screen.findByRole("option", { name: /release/ });
        fireEvent.mouseMove(release);
        expect(release).toHaveAttribute("data-lit", "true");

        // New words: the light is the keyboard s again, and it stands on the best match.
        type("/r");
        expect(await screen.findByRole("option", { name: /review/ })).toHaveAttribute("data-lit", "true");
        expect(screen.getByRole("option", { name: /release/ })).toHaveAttribute("data-lit", "false");
    });

    it("takes the row under the keyboard with Tab", async () => {
        bridge.getCommands.mockResolvedValue({
            commands: [
                slashCommand("review", "Review the tree", "extension"),
                slashCommand("deploy", "Deploy the app", "skill"),
            ],
        });
        renderComposer();

        type("/");
        await screen.findByText("/review");

        // `de` is in the second name only, so the highlight is on it: Tab takes it into
        // the box, as it does in pi's own editor, and sends nothing.
        type("/de");
        await screen.findByText("/deploy");
        press("Tab");

        expect(box()).toHaveValue("/deploy ");
        expect(bridge.prompt).not.toHaveBeenCalled();
    });
});

describe("the pictures of a message", () => {
    const picture = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
    const staged = { name: "workspace.png", image: picture };

    it("stages what the picker answered, and sends it with the words", async () => {
        bridge.pickImages.mockResolvedValue([staged]);
        renderComposer();

        fireEvent.click(screen.getByRole("button", { name: "Attach images" }));
        expect(await screen.findByText("workspace.png")).toBeInTheDocument();

        type("look at this");
        press("Enter");

        expect(bridge.prompt).toHaveBeenCalledWith("main:1", "look at this", undefined, [picture]);
    });

    it("removes one of the staged pictures again", async () => {
        bridge.pickImages.mockResolvedValue([staged]);
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Attach images" }));
        await screen.findByText("workspace.png");

        fireEvent.click(screen.getByRole("button", { name: "Remove workspace.png" }));

        await waitFor(() => expect(screen.queryByText("workspace.png")).toBeNull());
    });

    it("stays on screen when pi refuses the message", async () => {
        bridge.pickImages.mockResolvedValue([staged]);
        bridge.prompt.mockRejectedValue(refusal("pi rejected `prompt`: image too large"));
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Attach images" }));
        await screen.findByText("workspace.png");
        type("look");

        press("Enter");

        await waitFor(() => expect(box()).toHaveValue("look"));
        expect(screen.getByText("workspace.png")).toBeInTheDocument();
    });
});
