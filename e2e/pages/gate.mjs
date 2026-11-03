// The gate: transport, credentials, the host key question, and the errors it
// shows. The surface is the only way this page touches the app.

import { buttonByText, textIncludes, textMatches } from "./selectors.mjs";

const GATE = textIncludes("Connect to pi");
const CHAT = "!!document.querySelector('#sidebar_toggle')";
const HOST_KEY = textIncludes("Trust this host?");
const ADDRESS_FIELD = "document.querySelector('#connection-card-address')";
const CONNECT = "document.querySelector('#connection-card-connect')";

function errorCondition(pattern) {
    return typeof pattern === "string" ? textIncludes(pattern) : textMatches(pattern);
}

export function createGate(surface, { address, password } = {}) {
    async function waitForGate() {
        await surface.waitFor(GATE, { what: "the connect screen", timeoutMs: 20_000 });
    }

    async function isChatOpen() {
        return surface.execute(CHAT);
    }

    async function isHostKeyQuestion() {
        return surface.execute(HOST_KEY);
    }

    return {
        waitForGate,
        isChatOpen,
        isHostKeyQuestion,

        async expectColdLocalGate() {
            await waitForGate();
            const state = await surface.execute(`(() => ({
                local: document.querySelector('#connection-card-transport-local')?.getAttribute('aria-checked'),
                ssh: document.querySelector('#connection-card-transport-ssh')?.getAttribute('aria-checked'),
                address: !!document.querySelector('#connection-card-address'),
                disabled: document.querySelector('#connection-card-connect')?.disabled,
            }))()`);
            if (state.local !== "true" || state.ssh !== "false") {
                throw new Error(`the gate starts at local=${state.local}, ssh=${state.ssh}`);
            }
            if (state.address) throw new Error("the local gate shows an SSH field");
            if (state.disabled) throw new Error("Connect is off before anything needs input");
        },

        async selectSsh() {
            await surface.click("document.querySelector('#connection-card-transport-ssh')");
        },

        async expectSshWithoutAddress() {
            await surface.waitFor(`!!${ADDRESS_FIELD}`, { what: "the address field" });
            if (!(await surface.execute(`(${CONNECT}).disabled`))) {
                throw new Error("Connect is on with an empty address");
            }
            await surface.waitFor(textIncludes("Enter the address of the host."), {
                what: "the gate naming the missing address",
            });
        },

        async fillAddress(value = address) {
            if (value === undefined) throw new Error("the gate has no default address");
            await surface.fill("#connection-card-address", value);
        },

        async selectPasswordAuth() {
            await surface.click("document.querySelector('#connection-card-auth-password')");
        },

        async fillPassword(value = password) {
            if (value === undefined) throw new Error("the gate has no default password");
            await surface.fill("#connection-card-password", value);
        },

        async selectKeyAuth() {
            await surface.click("document.querySelector('#connection-card-auth-key')");
        },

        async fillKey(value) {
            await surface.fill("#connection-card-key", value);
        },

        async fillPassphrase(value) {
            await surface.fill("#connection-card-passphrase", value);
        },

        async expectConnectEnabled() {
            await surface.waitFor(`!${CONNECT}.disabled`, { what: "an enabled Connect" });
        },

        async expectConnectDisabled() {
            await surface.waitFor(`${CONNECT}.disabled`, { what: "a disabled Connect" });
        },

        async submit() {
            await surface.click(CONNECT);
        },

        async expectPasswordForm() {
            await surface.waitFor("!!document.querySelector('#connection-card-password')", {
                what: "the remembered SSH form",
            });
        },

        async expectChat() {
            await surface.waitFor(CHAT, { what: "the chat", timeoutMs: 30_000 });
        },

        async expectNoChat() {
            if (await isChatOpen()) throw new Error("the gate reached the chat");
        },

        async expectHostKeyQuestion() {
            await surface.waitFor(HOST_KEY, { what: "the host key question" });
        },

        async expectNoHostKeyQuestion() {
            await surface.waitFor(`!${HOST_KEY}`, { what: "the host key question to stay away" });
        },

        async fingerprint() {
            return surface.execute("document.body.innerText.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null");
        },

        async trustHost() {
            await surface.click(buttonByText("Trust"));
        },

        async cancelHostKey() {
            await surface.click(buttonByText("Cancel"));
            await surface.waitFor(`(${GATE}) && !(${HOST_KEY})`, { what: "the gate after Cancel" });
        },

        async expectError(pattern, { timeoutMs = 20_000 } = {}) {
            await surface.waitFor(errorCondition(pattern), {
                what: `the error ${String(pattern)}`,
                timeoutMs,
            });
        },

        async expectUsable() {
            await this.expectConnectEnabled();
            await this.expectNoChat();
        },

        async formState() {
            return surface.execute(`(() => ({
                address: document.querySelector('#connection-card-address')?.value ?? null,
                password: document.querySelector('#connection-card-password')?.value ?? null,
                ssh: document.querySelector('#connection-card-transport-ssh')?.getAttribute('aria-checked'),
                disabled: document.querySelector('#connection-card-connect')?.disabled,
            }))()`);
        },

        async expectRememberedHost(expected = address) {
            if (expected === undefined) throw new Error("the gate has no default address");
            await surface.waitFor(`localStorage.getItem('pie.host')?.includes(${JSON.stringify(expected)}) === true`, {
                what: "the remembered host",
            });
        },

        /** Fills the gate, submits it, and answers the host key question. */
        async connect({
            password: givenPassword = password,
            key,
            passphrase,
            trust = "accept",
            expectChat = true,
            error,
        } = {}) {
            await waitForGate();
            await this.selectSsh();
            await this.fillAddress(address);
            if (key !== undefined) {
                await this.selectKeyAuth();
                await this.fillKey(key);
                if (passphrase !== undefined) await this.fillPassphrase(passphrase);
            } else {
                await this.selectPasswordAuth();
                await this.fillPassword(givenPassword);
            }
            await this.expectConnectEnabled();
            await this.submit();
            const outcome = [HOST_KEY, CHAT, error === undefined ? null : errorCondition(error)]
                .filter((condition) => condition !== null)
                .join(" || ");
            await surface.waitFor(outcome, {
                what: "the host key question, the chat, or the error",
                timeoutMs: 25_000,
            });
            const asked = await isHostKeyQuestion();
            if (!asked) {
                if (expectChat) await this.expectChat();
                return { asked: false };
            }
            const fingerprint = await this.fingerprint();
            if (trust === "reject") {
                await this.cancelHostKey();
                return { asked: true, fingerprint };
            }
            await this.trustHost();
            if (expectChat) await this.expectChat();
            return { asked: true, fingerprint };
        },
    };
}
