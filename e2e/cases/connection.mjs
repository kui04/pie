// CONN: the gate, its transport, its credentials, and the host key question.

export const connectionCases = [
    {
        id: "CONN-01",
        priority: "P0",
        name: "a cold app opens the gate with local selected",
        platforms: ["android", "linux"],
        behaviorIds: ["CONN-01"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app) {
            await app.gate.expectColdLocalGate();
            await app.gate.selectSsh();
            await app.gate.expectSshWithoutAddress();
        },
    },
    {
        id: "CONN-02",
        priority: "P0",
        name: "a rejected password says so and leaves the gate usable",
        platforms: ["android", "linux"],
        behaviorIds: ["CONN-02"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app) {
            await app.gate.connect({ password: "wrong-password", expectChat: false });
            await app.gate.expectError("authentication rejected");
            await app.gate.expectUsable();
            await app.gate.fillPassword();
            await app.gate.submit();
            await app.gate.expectChat();
        },
    },
    {
        id: "CONN-03",
        priority: "P0",
        name: "an unknown host key is shown, refused, then trusted",
        platforms: ["android", "linux"],
        behaviorIds: ["CONN-03"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.selectSsh();
            await app.gate.fillAddress();
            await app.gate.fillPassword();
            await app.gate.submit();
            await app.gate.expectHostKeyQuestion();
            const fingerprint = await app.gate.fingerprint();
            if (fingerprint !== context.fingerprint) {
                throw new Error(`the gate showed ${fingerprint}, the host offers ${context.fingerprint}`);
            }
            await app.gate.cancelHostKey();
            await app.gate.expectNoChat();
            await app.gate.expectConnectEnabled();
            await app.gate.submit();
            await app.gate.expectHostKeyQuestion();
            await app.gate.trustHost();
            await app.gate.expectChat();
        },
    },
    {
        id: "CONN-04",
        priority: "P1",
        name: "a restart remembers the host but keeps no credential",
        platforms: ["android", "linux"],
        behaviorIds: ["CONN-04"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect();
            // The gate writes the host in an effect after the chat mounts. A restart
            // before that write would test an app that never remembered it.
            await app.gate.expectRememberedHost(context.address);
            // A force-stop is abrupt. Give the WebView a moment to flush the store.
            await context.sleep(2000);
            await app.restart();
            await app.gate.waitForGate();
            const state = await app.gate.formState();
            if (state.address !== context.address) {
                throw new Error(`the remembered address is ${JSON.stringify(state.address)}`);
            }
            if (state.ssh !== "true") throw new Error("the remembered transport is not SSH");
            if (state.password !== "") throw new Error("a password survived the restart");
            if (state.disabled !== true) throw new Error("Connect is on without a credential");
        },
    },
    {
        id: "CONN-05",
        priority: "P1",
        name: "a private key opens the host",
        platforms: ["android", "linux"],
        behaviorIds: ["CONN-05"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect({ key: context.keys.privateKey });
        },
    },
    {
        id: "CONN-06",
        priority: "P1",
        name: "an encrypted key refuses a wrong passphrase and accepts the right one",
        platforms: ["android", "linux"],
        behaviorIds: ["CONN-06"],
        tags: ["auth"],
        timeoutMs: 90_000,
        fixtures: [],
        async run(app, context) {
            await app.gate.connect({
                key: context.keys.passphraseKey,
                passphrase: "wrong-passphrase",
                expectChat: false,
            });
            await app.gate.expectUsable();
            await app.gate.expectError(/connect|key|decrypt|passphrase/i);
            await app.gate.fillPassphrase(context.keys.passphrase);
            await app.gate.submit();
            await app.gate.expectChat();
        },
    },
];
