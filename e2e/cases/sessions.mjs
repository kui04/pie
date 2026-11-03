// SESS: the session drawer and one conversation.

export const sessionsCases = [
    {
        id: "SESS-01",
        priority: "P0",
        name: "the list shows both fixtures, newest first, under the project",
        platforms: ["android", "linux"],
        behaviorIds: ["SESS-01"],
        timeoutMs: 90_000,
        fixtures: ["hello", "tool"],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.open();
            await app.sidebar.expectProject("~/work");
            const rows = await app.sidebar.rows();
            const tool = rows.findIndex((row) => row.startsWith("tool"));
            const hello = rows.findIndex((row) => row.startsWith("hello"));
            if (tool < 0 || hello < 0) throw new Error(`the fixtures are missing: ${JSON.stringify(rows)}`);
            // The mock host is reset before its run, so the seed order is known. A
            // real host keeps its messages, and an answer moves the hello row up.
            if (context.profile !== "real" && tool > hello) {
                throw new Error(`the list is not newest first: ${JSON.stringify(rows)}`);
            }
        },
    },
    {
        id: "SESS-02",
        priority: "P0",
        name: "a session opens as its file reads",
        platforms: ["android", "linux"],
        behaviorIds: ["SESS-02"],
        timeoutMs: 90_000,
        fixtures: ["hello"],
        async run(app) {
            await app.gate.connect();
            await app.sidebar.openSession("hello");
            const text = await app.session.text();
            for (const part of ["hello", "Thoughts", "Hello from the pie mock. This reply is deterministic."]) {
                if (!text.includes(part)) throw new Error(`the transcript lost ${JSON.stringify(part)}`);
            }
            await app.composer.expectModel("Mock Echo");
            await app.composer.expectThinking("low");
        },
    },
];
