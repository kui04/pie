// The real-provider acceptance profile. The model's words are not an oracle.

import { connectionCases } from "./connection.mjs";
import { sessionsCases } from "./sessions.mjs";

export const realCases = [
    connectionCases.find((item) => item.id === "CONN-01"),
    sessionsCases.find((item) => item.id === "SESS-01"),
    {
        id: "REAL-ICON",
        priority: "P1",
        name: "the real provider mark is drawn",
        platforms: ["android"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            await app.composer.expectProviderMark({ requireDataUrl: true });
        },
    },
    {
        id: "REAL-OPEN",
        priority: "P0",
        name: "a seeded conversation opens as it reads",
        platforms: ["android"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            const body = await app.session.text();
            if (!body.includes("hello")) throw new Error("the transcript lost its first prompt");
            const file = context.host.helloFile();
            if (
                !context.host
                    .run(`grep -q '"role":"assistant"' ${JSON.stringify(file)} && echo yes || echo no`)
                    .includes("yes")
            ) {
                throw new Error("the conversation file holds no answer");
            }
        },
    },
    {
        id: "REAL-SEND",
        priority: "P0",
        timeoutMs: 180_000,
        name: "a real model answers and the conversation file grows",
        platforms: ["android"],
        fixtures: ["hello"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            const file = context.host.helloFile();
            const before = context.host.lineCount(file);
            const answers = () =>
                Number(context.host.run(`grep -c '"role":"assistant"' ${JSON.stringify(file)} || true`).trim() || "0");
            const answersBefore = answers();
            await app.composer.send("Reply with one short sentence about the word pie.");
            await app.composer.waitForIdle(160_000);
            // The window can hear the end of a run before pi has flushed the file.
            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (answers() > answersBefore) break;
                await context.sleep(250);
            }
            if (context.host.lineCount(file) <= before) throw new Error("the conversation file did not grow");
            if (answers() <= answersBefore) throw new Error("the answer was not recorded");
        },
    },
];
