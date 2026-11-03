// RUN and UI: one answer, the model and thinking pickers, Stop, the working
// ring, and an extension prompt.

export const runCases = [
    {
        id: "RUN-01",
        priority: "P0",
        name: "a message streams an answer and lands in the session file",
        platforms: ["android", "linux"],
        tags: ["run"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            const file = context.host.helloFile();
            const before = context.host.lineCount(file);
            await app.composer.send("hello");
            await app.session.expectTextCount("Hello from the pie mock. This reply is deterministic.", 2, {
                timeoutMs: 25_000,
            });
            await app.composer.waitForIdle();
            const after = context.host.lineCount(file);
            if (after <= before) throw new Error(`the session file did not grow: ${before} -> ${after}`);
        },
    },
    {
        id: "RUN-02",
        priority: "P1",
        name: "the model picker lists the provider and records the change",
        platforms: ["android", "linux"],
        tags: ["run"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            await app.composer.expectProviderMark();
            await app.composer.openModelPicker();
            const options = await app.composer.modelOptions();
            if (!options.includes("Mock Echo") || !options.includes("Mock Alt")) {
                throw new Error(`the menu is ${JSON.stringify(options)}`);
            }
            // models.dev answers every name with a generic mark, so the bot icon only
            // stands in when the fetch itself fails. Either mark is correct here.
            await app.composer.chooseModel("Mock Alt");
            await app.composer.expectThinking("off");
            await context.sleep(800);
            const file = context.host.helloFile();
            if (
                !context.host
                    .run(`grep -c '"modelId":"mock-alt"' ${JSON.stringify(file)} || true`)
                    .trim()
                    .match(/^[1-9]/)
            ) {
                throw new Error("the session file records no model change");
            }
        },
    },
    {
        id: "RUN-03",
        priority: "P1",
        name: "the thinking level changes and the answer records it",
        platforms: ["android", "linux"],
        tags: ["run"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            await app.composer.openThinkingPicker();
            const levels = await app.composer.thinkingOptions();
            for (const level of ["off", "minimal", "low", "medium", "high"]) {
                if (!levels.includes(level)) throw new Error(`the level menu is ${JSON.stringify(levels)}`);
            }
            await app.composer.chooseThinking("high");
            await app.composer.expectThinking("high");
            await app.composer.send("hello");
            await app.composer.waitForIdle();
            const file = context.host.helloFile();
            if (context.host.run(`grep -c '"thinkingLevel":"high"' ${JSON.stringify(file)} || true`).trim() === "0") {
                throw new Error("no record carries the high thinking level");
            }
        },
    },
    {
        id: "RUN-07",
        priority: "P1",
        name: "Stop ends the run and leaves no pi behind",
        platforms: ["android", "linux"],
        tags: ["run"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            await app.composer.send("slow");
            await app.session.expectText("chunk-1", { timeoutMs: 20_000 });
            if ((await app.composer.submitLabel()) !== "Stop") {
                throw new Error("the composer does not offer Stop during a run");
            }
            await app.composer.stop();
            await app.composer.waitForIdle(15_000);
            const pids = context.host.run('ps -eo args | grep "[p]i --mode rpc" || true').trim();
            if (pids !== "") throw new Error(`pi is still running: ${pids}`);
        },
    },
    {
        id: "UI-01",
        priority: "P1",
        name: "the working ring turns while a run goes on",
        platforms: ["android", "linux"],
        tags: ["run"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            await app.composer.send("slow");
            await app.session.expectText("chunk-1", { timeoutMs: 20_000 });
            await app.session.expectWorkingRing();
            const first = await app.session.workingRingTransform();
            await context.sleep(300);
            const second = await app.session.workingRingTransform();
            if (first === null || second === null || first === second) {
                throw new Error(`the ring did not turn: ${JSON.stringify([first, second])}`);
            }
            await app.composer.stop();
            await app.composer.waitForIdle(15_000);
        },
    },
    {
        id: "RUN-08",
        priority: "P1",
        name: "an ask_user prompt answers and the run continues",
        platforms: ["android", "linux"],
        tags: ["run"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            await app.composer.send("ask");
            await app.session.expectExtensionPrompt();
            const dialog = await app.session.extensionDialogText("Which mode should the mock use?");
            if (dialog === null || !dialog.includes("Fast") || !dialog.includes("Safe")) {
                throw new Error(`the prompt is ${JSON.stringify(dialog)}`);
            }
            await app.session.chooseExtensionRow(0);
            await app.session.confirmExtension();
            await app.session.expectText("The answer was", { timeoutMs: 25_000 });
            await app.composer.waitForIdle();
        },
    },
];
