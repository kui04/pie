// ERR: the failures the app names and recovers from.

export const errorsCases = [
    {
        id: "ERR-03",
        priority: "P1",
        name: "a stopped host is named, and Reconnect brings the link back",
        platforms: ["android", "linux"],
        behaviorIds: ["ERR-03"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect();
            context.host.compose("stop", "host");
            await app.session.expectConnectionLost(context.address);
            context.host.compose("start", "host");
            for (let attempt = 0; attempt < 40; attempt += 1) {
                try {
                    context.host.run("true", 3000);
                    break;
                } catch {
                    await context.sleep(500);
                }
            }
            await app.session.reconnect();
            await app.gate.expectChat();
        },
    },
];
