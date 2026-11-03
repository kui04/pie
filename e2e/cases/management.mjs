// MGMT: a new conversation and a deleted one.

export const managementCases = [
    {
        id: "MGMT-01",
        priority: "P1",
        name: "New session opens empty, then writes its first message",
        platforms: ["android", "linux"],
        behaviorIds: ["MGMT-01"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect();
            await app.sidebar.open();
            const before = context.host.sessionFiles().length;
            await app.sidebar.newSession("/home/pi/work/");
            if (context.host.sessionFiles().length !== before) {
                throw new Error("a conversation file was written before the first message");
            }

            await app.composer.send("hello");
            await app.session.expectText("Hello from the pie mock. This reply is deterministic.", {
                timeoutMs: 30_000,
            });
            await app.composer.waitForIdle();
            if (context.host.sessionFiles().length !== before + 1) {
                throw new Error(`the first message wrote ${context.host.sessionFiles().length - before} session files`);
            }
        },
    },
    {
        id: "MGMT-03",
        priority: "P1",
        name: "Delete removes the conversation from the host",
        platforms: ["android", "linux"],
        behaviorIds: ["MGMT-03"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect();
            context.host.run("cd /home/pi/work && pi -p ephemeral >/dev/null");
            const file = context.host.sessionFiles()[0];
            const fileCount = context.host.sessionFiles().length;
            await app.sidebar.deleteSession("ephemeral");
            const left = context.host.sessionFiles();
            if (left.length !== fileCount - 1) {
                throw new Error(`the host kept ${left.length} of ${fileCount} sessions`);
            }
            if (left.includes(file)) throw new Error("the file of the deleted session is still on the host");
        },
    },
];
