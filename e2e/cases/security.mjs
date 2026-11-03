// SEC: credentials, logs, and the remembered host key.

export const securityCases = [
    {
        id: "SEC-01",
        priority: "P1",
        name: "no credential reaches the log",
        platforms: ["android", "linux"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            const secret = "pie-secret-7f3a";
            await app.gate.connect({ password: secret, expectChat: false });
            if (app.diagnostics.log().includes(secret)) throw new Error("the rejected password reached the log");

            await app.gate.expectUsable();
            await app.gate.fillPassword(context.password);
            await app.gate.submit();
            await app.gate.expectChat();
            if (app.diagnostics.log().includes(context.password)) throw new Error("the password reached the log");
            if (app.diagnostics.appDataContains(context.password)) {
                throw new Error("the password is on disk");
            }
        },
    },
    {
        id: "SEC-02",
        priority: "P1",
        name: "a trusted host key is kept across a restart",
        platforms: ["android", "linux"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect();
            await app.gate.expectRememberedHost(context.address);
            await context.sleep(2000);
            await app.restart();
            await app.gate.waitForGate();
            await app.gate.expectPasswordForm();
            await app.gate.fillPassword(context.password);
            await app.gate.submit();
            await app.gate.expectChat();
            await app.gate.expectNoHostKeyQuestion();
        },
    },
];
