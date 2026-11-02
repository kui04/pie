#!/usr/bin/env node
// Drives the debug APK on the Android device and checks the full flow against
// the test host. Every case starts from a cold app and a fresh connection, so a
// case never depends on the one before it.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, clear, launch } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const E2E = join(ROOT, "e2e");
const COMPOSE = join(E2E, "compose.yaml");
const SSH_KEY = join(E2E, ".testenv/ssh/id_ed25519");
const SSH_KEY_PASSPHRASE = join(E2E, ".testenv/ssh/id_ed25519_passphrase");
const KNOWN_HOSTS = join(E2E, ".testenv/ssh/known_hosts");
const FINGERPRINT = readFileSync(
  join(E2E, ".testenv/ssh/host_fingerprint"),
  "utf8",
).trim();
const SESSIONS = "/home/pi/.pi/agent/sessions/--home-pi-work--";

const options = parseArgs(process.argv.slice(2));
const SERIAL =
  options.serial ?? process.env.PIE_ANDROID_SERIAL ?? "192.168.240.112:5555";
const PROFILE = options.profile === "real" ? "real" : "mock";
const HOST_PORT = PROFILE === "real" ? "2223" : "2222";
const ADDRESS =
  options.address ??
  (PROFILE === "real" ? "pi@192.168.240.1:2223" : "pi@192.168.240.1:2222");
const PASSWORD = options.password ?? "pie-test";
const ARTIFACTS =
  options.artifacts ??
  join(E2E, ".artifacts", new Date().toISOString().replace(/[:.]/g, "-"));
const PORT = Number(options.port ?? 9333);

mkdirSync(join(ARTIFACTS, "screens"), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=");
    const next = argv[i + 1];
    parsed[name] =
      inline ?? (next === undefined || next.startsWith("--") ? true : next);
    if (inline === undefined && parsed[name] !== true) i += 1;
  }
  return parsed;
}

function host(script, timeout = 20000) {
  return execFileSync(
    "ssh",
    [
      "-p",
      HOST_PORT,
      "-i",
      SSH_KEY,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${KNOWN_HOSTS}`,
      "pi@127.0.0.1",
      script,
    ],
    { encoding: "utf8", timeout },
  );
}

function compose(...args) {
  return execFileSync("docker", ["compose", "-f", COMPOSE, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function sessionFiles() {
  const output = host(`ls -1t ${SESSIONS}/*.jsonl 2>/dev/null || true`).trim();
  return output === "" ? [] : output.split("\n");
}

function lineCount(path) {
  return Number(host(`wc -l < ${JSON.stringify(path)}`).trim());
}

function buttonByText(text) {
  return `Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === ${JSON.stringify(text)})`;
}

function optionByText(text) {
  return `Array.from(document.querySelectorAll('[role=listbox] [role=option]')).find((e) => e.innerText.trim() === ${JSON.stringify(text)})`;
}

function rowByText(text) {
  return `Array.from(document.querySelectorAll('[id^=session-sheet-drawer-row-]')).find((e) => e.innerText.includes(${JSON.stringify(text)}))`;
}

async function coldStart() {
  clear(SERIAL);
  launch(SERIAL);
  const cdp = await Cdp.find(SERIAL, PORT);
  await cdp.waitFor("document.body.innerText.includes('Connect to pi')", {
    what: "the connect screen",
    timeoutMs: 20000,
  });
  return cdp;
}

/** Fills the gate and opens the connection, and answers the host key question. */
async function connect(
  cdp,
  {
    password = PASSWORD,
    key,
    passphrase,
    trust = "accept",
    expectChat = true,
  } = {},
) {
  await cdp.click("document.querySelector('#connection-card-transport-ssh')");
  await cdp.fill("#connection-card-address", ADDRESS);
  if (key !== undefined) {
    await cdp.click("document.querySelector('#connection-card-auth-key')");
    await cdp.fill("#connection-card-key", key);
    if (passphrase !== undefined)
      await cdp.fill("#connection-card-passphrase", passphrase);
  } else {
    await cdp.click("document.querySelector('#connection-card-auth-password')");
    await cdp.fill("#connection-card-password", password);
  }
  await cdp.waitFor(
    "!document.querySelector('#connection-card-connect').disabled",
    { what: "an enabled Connect" },
  );
  await cdp.click("document.querySelector('#connection-card-connect')");
  const asked = await cdp
    .waitFor(
      "!!document.querySelector('#host-key-ask') || document.body.innerText.includes('Trust this host?') || !!document.querySelector('#sidebar_toggle')",
      {
        what: "the host key question or the chat",
        timeoutMs: 25000,
      },
    )
    .then(() =>
      cdp.eval("document.body.innerText.includes('Trust this host?')"),
    );
  if (!asked) {
    if (expectChat)
      await cdp.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat",
        timeoutMs: 25000,
      });
    return { asked: false };
  }
  const fingerprint = await cdp.eval(
    "document.body.innerText.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null",
  );
  if (trust === "reject") {
    await cdp.click(buttonByText("Cancel"));
    await cdp.waitFor(
      "document.body.innerText.includes('Connect to pi') && !document.body.innerText.includes('Trust this host?')",
      {
        what: "the gate after Cancel",
      },
    );
    return { asked: true, fingerprint };
  }
  await cdp.click(buttonByText("Trust"));
  if (expectChat) {
    await cdp.waitFor("!!document.querySelector('#sidebar_toggle')", {
      what: "the chat",
      timeoutMs: 25000,
    });
  } else {
    await sleep(2000);
  }
  return { asked: true, fingerprint };
}

async function openSidebar(cdp) {
  if (!(await cdp.eval("!!document.querySelector('#session-sheet-drawer')"))) {
    await cdp.click("document.querySelector('#sidebar_toggle')");
  }
  await cdp.waitFor(
    "!!document.querySelector('[id^=session-sheet-drawer-row-]')",
    { what: "the session rows" },
  );
}

async function openSession(cdp, text) {
  await openSidebar(cdp);
  const row = rowByText(text);
  if (!(await cdp.eval(`!!(${row})`)))
    throw new Error(`no session row for ${text}`);
  await cdp.eval(`(${row}).click()`);
  await cdp.waitFor("!!document.querySelector('#composer-input')", {
    what: `the ${text} transcript`,
  });
}

async function send(cdp, text) {
  await cdp.fill("#composer-input", text);
  await cdp.click("document.querySelector('#composer-submit')");
}

async function finished(cdp, timeoutMs = 30000) {
  await cdp.waitFor(
    "document.querySelector('#composer-submit')?.getAttribute('aria-label') === 'Send'",
    {
      what: "the run to finish",
      timeoutMs,
    },
  );
}

const cases = [
  {
    id: "CONN-01",
    priority: "P0",
    name: "a cold app opens the gate with local selected",
    async run(cdp) {
      const local = await cdp.eval(
        "document.querySelector('#connection-card-transport-local')?.getAttribute('aria-checked')",
      );
      const ssh = await cdp.eval(
        "document.querySelector('#connection-card-transport-ssh')?.getAttribute('aria-checked')",
      );
      if (local !== "true" || ssh !== "false")
        throw new Error(`the gate starts at local=${local}, ssh=${ssh}`);
      if (
        await cdp.eval("!!document.querySelector('#connection-card-address')")
      )
        throw new Error("the local gate shows an SSH field");
      if (
        await cdp.eval(
          "document.querySelector('#connection-card-connect')?.disabled",
        )
      )
        throw new Error("Connect is off before anything needs input");

      await cdp.click(
        "document.querySelector('#connection-card-transport-ssh')",
      );
      await cdp.waitFor(
        "!!document.querySelector('#connection-card-address')",
        { what: "the address field" },
      );
      if (
        !(await cdp.eval(
          "document.querySelector('#connection-card-connect').disabled",
        ))
      ) {
        throw new Error("Connect is on with an empty address");
      }
      await cdp.waitFor(
        "document.body.innerText.includes('Enter the address of the host.')",
        {
          what: "the gate naming the missing address",
        },
      );
    },
  },
  {
    id: "CONN-02",
    priority: "P0",
    name: "a rejected password says so and leaves the gate usable",
    async run(cdp) {
      await connect(cdp, { password: "wrong-password", expectChat: false });
      await cdp.waitFor(
        "document.body.innerText.includes('authentication rejected')",
        {
          what: "the rejected password message",
          timeoutMs: 20000,
        },
      );
      if (await cdp.eval("!!document.querySelector('#sidebar_toggle')"))
        throw new Error("a rejected password reached the chat");
      if (
        await cdp.eval(
          "document.querySelector('#connection-card-connect')?.disabled",
        )
      )
        throw new Error("the gate stayed locked");
      await cdp.waitFor(
        "!document.querySelector('#connection-card-connect').disabled",
        { what: "the gate after the rejected password" },
      );
      await cdp.fill("#connection-card-password", PASSWORD);
      await cdp.click("document.querySelector('#connection-card-connect')");
      await cdp.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat after a good password",
        timeoutMs: 25000,
      });
    },
  },
  {
    id: "CONN-03",
    priority: "P0",
    name: "an unknown host key is shown, refused, then trusted",
    async run(cdp) {
      const refused = await (async () => {
        await cdp.click(
          "document.querySelector('#connection-card-transport-ssh')",
        );
        await cdp.fill("#connection-card-address", ADDRESS);
        await cdp.fill("#connection-card-password", PASSWORD);
        await cdp.click("document.querySelector('#connection-card-connect')");
        await cdp.waitFor(
          "document.body.innerText.includes('Trust this host?')",
          { what: "the host key question" },
        );
        return cdp.eval(
          "document.body.innerText.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null",
        );
      })();
      if (refused !== FINGERPRINT)
        throw new Error(
          `the gate showed ${refused}, the host offers ${FINGERPRINT}`,
        );
      await cdp.click(buttonByText("Cancel"));
      await cdp.waitFor(
        "!document.body.innerText.includes('Trust this host?')",
        { what: "the question closing" },
      );
      if (await cdp.eval("!!document.querySelector('#sidebar_toggle')"))
        throw new Error("Cancel still connected");

      await cdp.waitFor(
        "!document.querySelector('#connection-card-connect').disabled",
        { what: "an enabled Connect after Cancel" },
      );
      await cdp.click("document.querySelector('#connection-card-connect')");
      await cdp.waitFor(
        "document.body.innerText.includes('Trust this host?')",
        { what: "the second host key question" },
      );
      await cdp.click(buttonByText("Trust"));
      await cdp.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat after Trust",
        timeoutMs: 25000,
      });
    },
  },
  {
    id: "CONN-04",
    priority: "P1",
    name: "a restart remembers the host but keeps no credential",
    async run(cdp) {
      await connect(cdp);
      // The gate writes the host in an effect after the chat mounts. A restart
      // before that write would test an app that never remembered it.
      await cdp.waitFor(
        `localStorage.getItem('pie.host')?.includes(${JSON.stringify(ADDRESS)}) === true`,
        { what: "the remembered host" },
      );
      // A force-stop is abrupt. Give the WebView a moment to flush the store.
      await sleep(2000);
      cdp.close();
      launch(SERIAL);
      const again = await Cdp.find(SERIAL, PORT);
      await again.waitFor("document.body.innerText.includes('Connect to pi')", {
        what: "the gate after a restart",
      });
      const state = await again.eval(`(() => ({
                address: document.querySelector('#connection-card-address')?.value ?? null,
                password: document.querySelector('#connection-card-password')?.value ?? null,
                ssh: document.querySelector('#connection-card-transport-ssh')?.getAttribute('aria-checked'),
                disabled: document.querySelector('#connection-card-connect')?.disabled,
            }))()`);
      if (state.address !== ADDRESS)
        throw new Error(
          `the remembered address is ${JSON.stringify(state.address)}`,
        );
      if (state.ssh !== "true")
        throw new Error("the remembered transport is not SSH");
      if (state.password !== "")
        throw new Error("a password survived the restart");
      if (state.disabled !== true)
        throw new Error("Connect is on without a credential");
    },
  },
  {
    id: "CONN-05",
    priority: "P1",
    name: "a private key opens the host",
    async run(cdp) {
      await connect(cdp, { key: readFileSync(SSH_KEY, "utf8") });
    },
  },
  {
    id: "CONN-06",
    priority: "P1",
    name: "an encrypted key refuses a wrong passphrase and accepts the right one",
    async run(cdp) {
      await connect(cdp, {
        key: readFileSync(SSH_KEY_PASSPHRASE, "utf8"),
        passphrase: "wrong-passphrase",
        expectChat: false,
      });
      await cdp.waitFor(
        "!document.querySelector('#connection-card-connect').disabled",
        {
          what: "the gate after a failed key",
          timeoutMs: 20000,
        },
      );
      if (await cdp.eval("!!document.querySelector('#sidebar_toggle')"))
        throw new Error("a wrong passphrase connected");
      if (
        !(await cdp.eval(
          "document.body.innerText.match(/connect|key|decrypt|passphrase/i) !== null",
        ))
      ) {
        throw new Error("the gate said nothing about the failed key");
      }
      await cdp.fill("#connection-card-passphrase", "pie-test-passphrase");
      await cdp.click("document.querySelector('#connection-card-connect')");
      await cdp.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat after the right passphrase",
        timeoutMs: 25000,
      });
    },
  },
  {
    id: "SESS-01",
    priority: "P0",
    name: "the list shows both fixtures, newest first, under the project",
    async run(cdp) {
      await connect(cdp);
      await openSidebar(cdp);
      const groups = await cdp.eval(
        "document.body.innerText.includes('~/work')",
      );
      if (!groups) throw new Error("the drawer does not name ~/work");
      const rows = await cdp.eval(
        `Array.from(document.querySelectorAll('[id^=session-sheet-drawer-row-]')).map((e) => e.innerText.replace(/\\n/g, '|'))`,
      );
      const tool = rows.findIndex((row) => row.startsWith("tool"));
      const hello = rows.findIndex((row) => row.startsWith("hello"));
      if (tool < 0 || hello < 0)
        throw new Error(`the fixtures are missing: ${JSON.stringify(rows)}`);
      // The mock host is reset before its run, so the seed order is known. A
      // real host keeps its messages, and an answer moves the hello row up.
      if (PROFILE !== "real" && tool > hello)
        throw new Error(
          `the list is not newest first: ${JSON.stringify(rows)}`,
        );
    },
  },
  {
    id: "SESS-02",
    priority: "P0",
    name: "a session opens as its file reads",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      const text = await cdp.text();
      for (const part of [
        "hello",
        "Thoughts",
        "Hello from the pie mock. This reply is deterministic.",
      ]) {
        if (!text.includes(part))
          throw new Error(`the transcript lost ${JSON.stringify(part)}`);
      }
      if (!text.includes("Mock Echo") || !text.includes("low"))
        throw new Error("the composer does not name the model and level");
    },
  },
  {
    id: "RUN-01",
    priority: "P0",
    name: "a message streams an answer and lands in the session file",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      const before = lineCount(helloFile());
      await send(cdp, "hello");
      await cdp.waitFor(
        "document.body.innerText.split('Hello from the pie mock. This reply is deterministic.').length - 1 >= 2",
        {
          what: "the streamed answer",
          timeoutMs: 25000,
        },
      );
      await finished(cdp);
      const after = lineCount(helloFile());
      if (after <= before)
        throw new Error(`the session file did not grow: ${before} -> ${after}`);
    },
  },
  {
    id: "RUN-02",
    priority: "P1",
    name: "the model picker lists the provider and records the change",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      await cdp.waitFor(
        "!!document.querySelector('#composer-model [data-provider]') || !!document.querySelector('#composer-model svg.lucide-bot')",
        { what: "the provider mark" },
      );
      const mask = await cdp.eval(
        `document.querySelector('#composer-model [data-provider]')?.style.maskImage ?? null`,
      );
      if (mask !== null && !mask.includes("data:image/svg+xml;base64,")) {
        throw new Error(`the provider mark is not a data url: ${mask}`);
      }
      await cdp.click("document.querySelector('#composer-model')");
      await cdp.waitFor("!!document.querySelector('[role=listbox]')", {
        what: "the model menu",
      });
      const options = await cdp.eval(
        `Array.from(document.querySelectorAll('[role=listbox] [role=option]')).map((e) => e.innerText.trim())`,
      );
      if (!options.includes("Mock Echo") || !options.includes("Mock Alt")) {
        throw new Error(`the menu is ${JSON.stringify(options)}`);
      }
      // models.dev answers every name with a generic mark, so the bot icon only
      // stands in when the fetch itself fails. Either mark is correct here.
      if (
        !(await cdp.eval(
          "document.querySelector('[data-provider=\"pie-e2e\"]') !== null || document.querySelector('svg.lucide-bot') !== null",
        ))
      ) {
        throw new Error("the picker drew no mark for the provider");
      }
      await cdp.eval(`(${optionByText("Mock Alt")}).click()`);
      await cdp.waitFor(
        "document.querySelector('#composer-model').innerText === 'Mock Alt'",
        { what: "the new model" },
      );
      const level = await cdp.eval(
        "document.querySelector('#composer-thinking').innerText",
      );
      if (level !== "off")
        throw new Error(`a model without reasoning kept level ${level}`);
      await sleep(800);
      const file = helloFile();
      if (
        !host(`grep -c '"modelId":"mock-alt"' ${JSON.stringify(file)} || true`)
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
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      if (
        (await cdp.eval(
          "document.querySelector('#composer-model').innerText",
        )) !== "Mock Echo"
      ) {
        await cdp.click("document.querySelector('#composer-model')");
        await cdp.waitFor(`!!(${optionByText("Mock Echo")})`, {
          what: "the Mock Echo option",
        });
        await cdp.eval(`(${optionByText("Mock Echo")}).click()`);
        await cdp.waitFor(
          "document.querySelector('#composer-model').innerText === 'Mock Echo'",
          {
            what: "Mock Echo",
          },
        );
      }
      await cdp.click("document.querySelector('#composer-thinking')");
      await cdp.waitFor("!!document.querySelector('[role=listbox]')", {
        what: "the level menu",
      });
      const levels = await cdp.eval(
        `Array.from(document.querySelectorAll('[role=listbox] [role=option]')).map((e) => e.innerText.trim())`,
      );
      for (const level of ["off", "minimal", "low", "medium", "high"]) {
        if (!levels.includes(level))
          throw new Error(`the level menu is ${JSON.stringify(levels)}`);
      }
      await cdp.eval(`(${optionByText("high")}).click()`);
      await cdp.waitFor(
        "document.querySelector('#composer-thinking').innerText === 'high'",
        { what: "the high level" },
      );
      await send(cdp, "hello");
      await finished(cdp);
      const file = helloFile();
      if (
        host(
          `grep -c '"thinkingLevel":"high"' ${JSON.stringify(file)} || true`,
        ).trim() === "0"
      ) {
        throw new Error("no record carries the high thinking level");
      }
    },
  },
  {
    id: "RUN-07",
    priority: "P1",
    name: "Stop ends the run and leaves no pi behind",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      await send(cdp, "slow");
      await cdp.waitFor("document.body.innerText.includes('chunk-1')", {
        what: "the slow answer",
        timeoutMs: 20000,
      });
      if (
        (await cdp.eval(
          "document.querySelector('#composer-submit').getAttribute('aria-label')",
        )) !== "Stop"
      ) {
        throw new Error("the composer does not offer Stop during a run");
      }
      await cdp.click("document.querySelector('#composer-submit')");
      await finished(cdp, 15000);
      const pids = host('ps -eo args | grep "[p]i --mode rpc" || true').trim();
      if (pids !== "") throw new Error(`pi is still running: ${pids}`);
    },
  },
  {
    id: "UI-01",
    priority: "P1",
    name: "the working ring turns while a run goes on",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      await send(cdp, "slow");
      await cdp.waitFor("document.body.innerText.includes('chunk-1')", {
        what: "the slow answer",
        timeoutMs: 20000,
      });
      await cdp.waitFor(
        "!!document.querySelector('[aria-label=\"Working\"]')",
        {
          what: "the working ring",
        },
      );
      const ring = `document.querySelector('[aria-label="Working"]')?.parentElement`;
      const transform = () =>
        cdp.eval(
          `(() => { const e = ${ring}; return e ? getComputedStyle(e).transform : null; })()`,
        );
      const first = await transform();
      await sleep(300);
      const second = await transform();
      if (first === null || second === null || first === second)
        throw new Error(
          `the ring did not turn: ${JSON.stringify([first, second])}`,
        );
      await cdp.click("document.querySelector('#composer-submit')");
      await finished(cdp, 15000);
    },
  },
  {
    id: "RUN-08",
    priority: "P1",
    name: "an ask_user prompt answers and the run continues",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      await send(cdp, "ask");
      await cdp.waitFor("!!document.querySelector('#extension-select-row-0')", {
        what: "the ask_user prompt",
        timeoutMs: 25000,
      });
      const dialog = await cdp.eval(
        `Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog]')).find((e) => e.innerText.includes('Which mode should the mock use?'))?.innerText ?? null`,
      );
      if (
        dialog === null ||
        !dialog.includes("Fast") ||
        !dialog.includes("Safe")
      ) {
        throw new Error(`the prompt is ${JSON.stringify(dialog)}`);
      }
      await cdp.eval(
        "document.querySelector('#extension-select-row-0').click()",
      );
      await cdp.eval(`(${buttonByText("Confirm")}).click()`);
      await cdp.waitFor("document.body.innerText.includes('The answer was')", {
        what: "the answer reaching the model",
        timeoutMs: 25000,
      });
      await finished(cdp);
    },
  },
  {
    id: "MGMT-01",
    priority: "P1",
    name: "New session opens empty, then writes its first message",
    async run(cdp) {
      await connect(cdp);
      await openSidebar(cdp);
      const before = sessionFiles().length;
      await cdp.click("document.querySelector('#session-sheet-drawer-new')");
      await cdp.waitFor(
        "!!document.querySelector('#directory-picker-scroll')",
        { what: "the folder picker" },
      );
      await cdp.fill("#directory-picker-field", "/home/pi/work/");
      await cdp.waitFor(
        "document.querySelector('#directory-picker-field')?.value === '/home/pi/work/'",
        { what: "the chosen folder" },
      );
      await cdp.waitFor(`!(${buttonByText("Open")}).disabled`, {
        what: "an enabled Open",
      });
      await cdp.eval(`(${buttonByText("Open")}).click()`);
      await cdp.waitFor("!document.querySelector('#directory-picker-scroll')", {
        what: "the picker closing",
      });
      await cdp.waitFor("!!document.querySelector('#composer-input')", {
        what: "the empty conversation",
      });
      if (sessionFiles().length !== before) {
        throw new Error(
          "a conversation file was written before the first message",
        );
      }

      await send(cdp, "hello");
      await cdp.waitFor(
        "document.body.innerText.includes('Hello from the pie mock. This reply is deterministic.')",
        { what: "the first answer", timeoutMs: 30000 },
      );
      await finished(cdp);
      if (sessionFiles().length !== before + 1) {
        throw new Error(
          `the first message wrote ${sessionFiles().length - before} session files`,
        );
      }
    },
  },
  {
    id: "MGMT-03",
    priority: "P1",
    name: "Delete removes the conversation from the host",
    async run(cdp) {
      await connect(cdp);
      host("cd /home/pi/work && pi -p ephemeral >/dev/null");
      const file = sessionFiles()[0];
      const fileCount = sessionFiles().length;
      await openSidebar(cdp);
      if (
        await cdp.eval(
          "!!document.querySelector('#session-sheet-drawer-refresh')",
        )
      ) {
        await cdp.click(
          "document.querySelector('#session-sheet-drawer-refresh')",
        );
      }
      await cdp.waitFor(`!!(${rowByText("ephemeral")})`, {
        what: "the ephemeral row",
        timeoutMs: 15000,
      });
      const row = await cdp.eval(`(${rowByText("ephemeral")}).id`);
      const menu = `document.querySelector('#${row.replace(/^session-sheet-drawer-row-/, "session-sheet-drawer-menu-")}')`;
      await cdp.click(menu);
      await cdp.click("document.querySelector('[id$=-delete]')");
      await cdp.waitFor(
        "document.body.innerText.includes('Delete this conversation?')",
        { what: "the delete question" },
      );
      const confirm = `Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog]')).filter((e) => e.innerText.includes('Delete this conversation')).flatMap((e) => Array.from(e.querySelectorAll('button'))).find((b) => b.innerText.trim() === 'Delete')`;
      await cdp.eval(`(${confirm}).click()`);
      await cdp.waitFor(`!(${rowByText("ephemeral")})`, {
        what: "the row leaving",
      });
      const left = sessionFiles();
      if (left.length !== fileCount - 1)
        throw new Error(
          `the host kept ${left.length} of ${fileCount} sessions`,
        );
      if (left.includes(file))
        throw new Error("the file of the deleted session is still on the host");
    },
  },
  {
    id: "ERR-03",
    priority: "P1",
    name: "a stopped host is named, and Reconnect brings the link back",
    async run(cdp) {
      await connect(cdp);
      compose("stop", "host");
      await cdp.waitFor(
        "Array.from(document.querySelectorAll('[role=alertdialog]')).some((e) => e.innerText.includes('The connection to'))",
        {
          what: "the connection lost overlay",
          timeoutMs: 15000,
        },
      );
      const overlay = await cdp.eval(
        `Array.from(document.querySelectorAll('[role=alertdialog]')).find((e) => e.innerText.includes('The connection to')).innerText`,
      );
      if (!overlay.includes(ADDRESS))
        throw new Error(`the overlay is ${JSON.stringify(overlay)}`);

      compose("start", "host");
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          host("true", 3000);
          break;
        } catch {
          await sleep(500);
        }
      }
      await cdp.eval(
        `Array.from(document.querySelectorAll('[role=alertdialog] button')).find((b) => b.innerText.trim() === 'Reconnect').click()`,
      );
      await cdp.waitFor(
        "!Array.from(document.querySelectorAll('[role=alertdialog]')).some((e) => e.innerText.includes('The connection to'))",
        {
          what: "the overlay leaving",
          timeoutMs: 25000,
        },
      );
      if (!(await cdp.eval("!!document.querySelector('#sidebar_toggle')")))
        throw new Error("the chat did not come back");
    },
  },
  {
    id: "SEC-01",
    priority: "P1",
    name: "no credential reaches the log",
    async run(cdp) {
      const secret = "pie-secret-7f3a";
      await connect(cdp, { password: secret, expectChat: false });
      const log = execFileSync(
        "adb",
        ["-s", SERIAL, "logcat", "-d", "-t", "4000"],
        { encoding: "utf8" },
      );
      if (log.includes(secret))
        throw new Error("the rejected password reached logcat");

      await cdp.waitFor(
        "!document.querySelector('#connection-card-connect').disabled",
        {
          what: "the gate after the rejected password",
        },
      );
      await cdp.fill("#connection-card-password", PASSWORD);
      await cdp.click("document.querySelector('#connection-card-connect')");
      await cdp.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat",
        timeoutMs: 25000,
      });
      const logAgain = execFileSync(
        "adb",
        ["-s", SERIAL, "logcat", "-d", "-t", "4000"],
        { encoding: "utf8" },
      );
      if (logAgain.includes(PASSWORD))
        throw new Error("the password reached logcat");

      let data;
      try {
        data = execFileSync(
          "adb",
          [
            "-s",
            SERIAL,
            "shell",
            "run-as",
            "me.kui04.pie",
            "grep",
            "-rl",
            PASSWORD,
            "/data/data/me.kui04.pie",
          ],
          { encoding: "utf8" },
        );
      } catch (error) {
        data = String(error.stdout ?? "");
      }
      if (data.includes(PASSWORD))
        throw new Error(`the password is on disk: ${data}`);
    },
  },
  {
    id: "SEC-02",
    priority: "P1",
    name: "a trusted host key is kept across a restart",
    async run(cdp) {
      await connect(cdp);
      await cdp.waitFor(
        `localStorage.getItem('pie.host')?.includes(${JSON.stringify(ADDRESS)}) === true`,
        { what: "the remembered host" },
      );
      await sleep(2000);
      cdp.close();
      launch(SERIAL);
      const again = await Cdp.find(SERIAL, PORT);
      await again.waitFor("document.body.innerText.includes('Connect to pi')", {
        what: "the gate after a restart",
      });
      await again.waitFor(
        "!!document.querySelector('#connection-card-password')",
        {
          what: "the remembered SSH form",
        },
      );
      await again.fill("#connection-card-password", PASSWORD);
      await again.click("document.querySelector('#connection-card-connect')");
      await again.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat",
        timeoutMs: 25000,
      });
      if (
        await again.eval("document.body.innerText.includes('Trust this host?')")
      ) {
        throw new Error("the gate asked for the known host again");
      }
    },
  },
];

function helloFile() {
  // The file is found by what it holds, not by its time: opening a session can
  // touch it, and the fixtures change order across a run.
  for (const file of sessionFiles()) {
    if (
      host(
        `grep -q '"text":"hello"' ${JSON.stringify(file)} && echo yes || echo no`,
      ).includes("yes")
    ) {
      return file;
    }
  }
  throw new Error("no session carries the hello fixture");
}

/**
 * Acceptance cases for a real provider. The model's words are not an oracle:
 * each case checks the shape of the run and of the conversation file.
 */
const realCases = [
  cases.find((item) => item.id === "CONN-01"),
  cases.find((item) => item.id === "SESS-01"),
  {
    id: "REAL-ICON",
    priority: "P1",
    name: "the real provider mark is drawn",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      await cdp.waitFor(
        "!!document.querySelector('#composer-model [data-provider]')",
        {
          what: "the provider mark",
        },
      );
      const mask = await cdp.eval(
        `document.querySelector('#composer-model [data-provider]').style.maskImage`,
      );
      if (!mask.includes("data:image/svg+xml;base64,"))
        throw new Error(`the provider mark is not a data url: ${mask}`);
    },
  },
  {
    id: "REAL-OPEN",
    priority: "P0",
    name: "a seeded conversation opens as it reads",
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      const body = await cdp.text();
      if (!body.includes("hello"))
        throw new Error("the transcript lost its first prompt");
      if (
        !host(
          `grep -q '"role":"assistant"' ${JSON.stringify(helloFile())} && echo yes || echo no`,
        ).includes("yes")
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
    async run(cdp) {
      await connect(cdp);
      await openSession(cdp, "hello");
      const file = helloFile();
      const before = lineCount(file);
      const answers = () =>
        Number(
          host(
            `grep -c '"role":"assistant"' ${JSON.stringify(file)} || true`,
          ).trim() || "0",
        );
      const answersBefore = answers();
      await send(cdp, "Reply with one short sentence about the word pie.");
      await finished(cdp, 160_000);
      // The window can hear the end of a run before pi has flushed the file.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (answers() > answersBefore) break;
        await sleep(250);
      }
      if (lineCount(file) <= before)
        throw new Error("the conversation file did not grow");
      if (answers() <= answersBefore)
        throw new Error("the answer was not recorded");
    },
  },
];

function selectCases(list, filter) {
  if (filter === undefined || filter === "all") return list;
  const wanted = filter.split(",").map((value) => value.trim().toUpperCase());
  return list.filter(
    (item) => wanted.includes(item.priority) || wanted.includes(item.id),
  );
}

async function main() {
  if (PROFILE !== "real" && options["no-reset"] === undefined) {
    execFileSync("bash", [join(E2E, "reset-host.sh")], {
      cwd: ROOT,
      encoding: "utf8",
    });
  }

  const selected = selectCases(
    PROFILE === "real" ? realCases : cases,
    options.cases,
  );
  const report = {
    startedAt: new Date().toISOString(),
    serial: SERIAL,
    address: ADDRESS,
    cases: [],
  };
  let current;
  let failed = 0;
  let known = 0;

  for (const item of selected) {
    const started = Date.now();
    const limit = item.timeoutMs ?? 90_000;
    let status = "pass";
    let error;
    try {
      current?.close();
      current = await coldStart();
      await Promise.race([
        item.run(current),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(`the case did not finish within ${limit / 1000}s`),
              ),
            limit,
          );
          timer.unref();
        }),
      ]);
    } catch (problem) {
      error = String(problem.message ?? problem);
      status = item.knownBug === undefined ? "fail" : "known";
      if (status === "fail") failed += 1;
      else known += 1;
      try {
        await current?.screenshot(
          join(ARTIFACTS, "screens", `${item.id}-failed.png`),
        );
      } catch {
        // A dead WebView leaves no screenshot; the report still names the case.
      }
    }
    const record = {
      id: item.id,
      priority: item.priority,
      name: item.name,
      status,
      error,
      ms: Date.now() - started,
    };
    if (item.knownBug !== undefined) record.bug = item.knownBug;
    report.cases.push(record);
    const line = `${record.status.toUpperCase().padEnd(5)} ${record.id} ${record.name}`;
    console.log(error === undefined ? line : `${line}\n      ${error}`);
  }

  report.finishedAt = new Date().toISOString();
  report.summary = {
    total: report.cases.length,
    passed: report.cases.filter((c) => c.status === "pass").length,
    failed,
    known,
  };
  writeFileSync(
    join(ARTIFACTS, "report.json"),
    `${JSON.stringify(report, null, 4)}\n`,
  );
  try {
    writeFileSync(
      join(ARTIFACTS, "logcat.txt"),
      execFileSync("adb", ["-s", SERIAL, "logcat", "-d", "-t", "4000"], {
        encoding: "utf8",
      }),
    );
  } catch {
    // A device that left mid-run still keeps the report.
  }
  console.log(
    `\n${report.summary.passed}/${report.summary.total} passed, ${failed} failed, ${known} known (${ARTIFACTS})`,
  );
  current?.close();
  process.exit(failed === 0 ? 0 : 1);
}

await main();
