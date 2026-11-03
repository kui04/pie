#!/usr/bin/env node
// Drives the Linux desktop debug build through tauri-driver and WebKitWebDriver.
// Each case starts from fresh app data and the mock host reset to its fixtures.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppSession, startDriver, stopDriver } from "./webdriver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const E2E = join(ROOT, "e2e");
const BIN = join(ROOT, "src-tauri/target/debug/pie");
const ADDRESS = process.env.PIE_E2E_LINUX_ADDRESS ?? "pi@127.0.0.1:2222";
const PASSWORD = process.env.PIE_E2E_LINUX_PASSWORD ?? "pie-test";
const SSH_KEY = join(E2E, ".testenv/ssh/id_ed25519");
const KNOWN_HOSTS = join(E2E, ".testenv/ssh/known_hosts");
const FINGERPRINT = readFileSync(
  join(E2E, ".testenv/ssh/host_fingerprint"),
  "utf8",
).trim();
const SESSIONS = "/home/pi/.pi/agent/sessions/--home-pi-work--";

const options = parseArgs(process.argv.slice(2));
const ARTIFACTS =
  options.artifacts ??
  join(E2E, ".artifacts", new Date().toISOString().replace(/[:.]/g, "-"));
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
      "2222",
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

function rowByText(text) {
  return `Array.from(document.querySelectorAll('[id^=session-sheet-drawer-row-]')).find((e) => e.innerText.includes(${JSON.stringify(text)}))`;
}

async function connect(app, { password = PASSWORD, expectChat = true } = {}) {
  await app.waitFor("document.body.innerText.includes('Connect to pi')", {
    what: "the connect screen",
    timeoutMs: 20_000,
  });
  await app.click("document.querySelector('#connection-card-transport-ssh')");
  await app.fill("#connection-card-address", ADDRESS);
  await app.fill("#connection-card-password", password);
  await app.waitFor(
    "!document.querySelector('#connection-card-connect').disabled",
    { what: "an enabled Connect" },
  );
  await app.click("document.querySelector('#connection-card-connect')");
  const asked = await app
    .waitFor(
      "!!document.querySelector('#host-key-ask') || document.body.innerText.includes('Trust this host?') || !!document.querySelector('#sidebar_toggle')",
      {
        what: "the host key question or the chat",
        timeoutMs: 30_000,
      },
    )
    .then(() =>
      app.execute("document.body.innerText.includes('Trust this host?')"),
    );
  if (!asked) {
    if (expectChat) {
      await app.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat",
        timeoutMs: 30_000,
      });
    }
    return { asked: false };
  }
  const fingerprint = await app.execute(
    "document.body.innerText.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null",
  );
  if (fingerprint !== FINGERPRINT) {
    throw new Error(
      `the gate showed ${fingerprint}, the host offers ${FINGERPRINT}`,
    );
  }
  await app.click(buttonByText("Trust"));
  if (expectChat) {
    await app.waitFor("!!document.querySelector('#sidebar_toggle')", {
      what: "the chat after Trust",
      timeoutMs: 30_000,
    });
  }
  return { asked: true, fingerprint };
}

async function openSidebar(app) {
  if (
    !(await app.execute("!!document.querySelector('#session-sheet-drawer')"))
  ) {
    await app.click("document.querySelector('#sidebar_toggle')");
  }
  await app.waitFor(
    "!!document.querySelector('[id^=session-sheet-drawer-row-]')",
    { what: "the session rows", timeoutMs: 30_000 },
  );
}

async function openSession(app, text) {
  await openSidebar(app);
  const row = rowByText(text);
  if (!(await app.execute(`!!(${row})`))) {
    throw new Error(`no session row for ${text}`);
  }
  await app.execute(`(${row}).click()`);
  await app.waitFor("!!document.querySelector('#composer-input')", {
    what: `the ${text} transcript`,
  });
}

async function send(app, text) {
  await app.fill("#composer-input", text);
  await app.click("document.querySelector('#composer-submit')");
}

async function finished(app, timeoutMs = 30_000) {
  await app.waitFor(
    "document.querySelector('#composer-submit')?.getAttribute('aria-label') === 'Send'",
    {
      what: "the run to finish",
      timeoutMs,
    },
  );
}

function helloFile() {
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

const cases = [
  {
    id: "L-01",
    priority: "P0",
    name: "a cold desktop app connects and lists both fixtures",
    async run(app) {
      await connect(app);
      await openSidebar(app);
      if (!(await app.execute("document.body.innerText.includes('~/work')"))) {
        throw new Error("the drawer does not name ~/work");
      }
      const rows = await app.execute(
        `Array.from(document.querySelectorAll('[id^=session-sheet-drawer-row-]')).map((e) => e.innerText.trim().replace(/\\n/g, '|'))`,
      );
      const tool = rows.findIndex((row) => row.startsWith("tool"));
      const hello = rows.findIndex((row) => row.startsWith("hello"));
      if (tool < 0 || hello < 0) {
        throw new Error(`the fixtures are missing: ${JSON.stringify(rows)}`);
      }
      if (tool > hello) {
        throw new Error(
          `the list is not newest first: ${JSON.stringify(rows)}`,
        );
      }
    },
  },
  {
    id: "L-02",
    priority: "P0",
    name: "a message streams an answer and lands in the session file",
    timeoutMs: 60_000,
    async run(app) {
      await connect(app);
      await openSession(app, "hello");
      const text = await app.text();
      for (const part of [
        "hello",
        "Thoughts",
        "Hello from the pie mock. This reply is deterministic.",
      ]) {
        if (!text.includes(part)) {
          throw new Error(`the transcript lost ${JSON.stringify(part)}`);
        }
      }
      if (!text.includes("Mock Echo") || !text.includes("low")) {
        throw new Error("the composer does not name the model and level");
      }
      const file = helloFile();
      const before = lineCount(file);
      await send(app, "hello");
      await app.waitFor(
        "document.body.innerText.split('Hello from the pie mock. This reply is deterministic.').length - 1 >= 2",
        {
          what: "the streamed answer",
          timeoutMs: 25_000,
        },
      );
      await finished(app);
      const after = lineCount(file);
      if (after <= before) {
        throw new Error(`the session file did not grow: ${before} -> ${after}`);
      }
    },
  },
  {
    id: "L-03",
    priority: "P1",
    name: "a restart remembers the host but keeps no credential",
    async run(app) {
      await connect(app);
      await app.waitFor(
        `localStorage.getItem('pie.host')?.includes(${JSON.stringify(ADDRESS)}) === true`,
        { what: "the remembered host" },
      );
      // A quit closes the window abruptly; let the WebView flush localStorage.
      await sleep(2000);
      await app.quit();

      const again = await AppSession.open(BIN);
      try {
        await again.waitFor(
          "document.body.innerText.includes('Connect to pi')",
          {
            what: "the gate after a restart",
          },
        );
        const state = await again.execute(`(() => ({
          address: document.querySelector('#connection-card-address')?.value ?? null,
          password: document.querySelector('#connection-card-password')?.value ?? null,
          ssh: document.querySelector('#connection-card-transport-ssh')?.getAttribute('aria-checked'),
          disabled: document.querySelector('#connection-card-connect')?.disabled,
        }))()`);
        if (state.address !== ADDRESS) {
          throw new Error(
            `the remembered address is ${JSON.stringify(state.address)}`,
          );
        }
        if (state.ssh !== "true") {
          throw new Error("the remembered transport is not SSH");
        }
        if (state.password !== "") {
          throw new Error("a password survived the restart");
        }
        if (state.disabled !== true) {
          throw new Error("Connect is on without a credential");
        }
      } finally {
        await again.quit();
      }
    },
  },
  {
    id: "L-04",
    priority: "P0",
    name: "a rejected password leaves the gate usable",
    async run(app) {
      await app.waitFor("document.body.innerText.includes('Connect to pi')", {
        what: "the connect screen",
      });
      await app.click(
        "document.querySelector('#connection-card-transport-ssh')",
      );
      await app.fill("#connection-card-address", ADDRESS);
      await app.fill("#connection-card-password", "wrong-password");
      await app.click("document.querySelector('#connection-card-connect')");
      await app.waitFor(
        "document.body.innerText.includes('Trust this host?') || document.body.innerText.includes('authentication rejected')",
        {
          what: "the host key question or the rejected password",
          timeoutMs: 25_000,
        },
      );
      if (
        await app.execute(
          "document.body.innerText.includes('Trust this host?')",
        )
      ) {
        const fingerprint = await app.execute(
          "document.body.innerText.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null",
        );
        if (fingerprint !== FINGERPRINT) {
          throw new Error(
            `the gate showed ${fingerprint}, the host offers ${FINGERPRINT}`,
          );
        }
        await app.click(buttonByText("Trust"));
      }
      await app.waitFor(
        "document.body.innerText.includes('authentication rejected')",
        {
          what: "the rejected password message",
          timeoutMs: 25_000,
        },
      );
      if (await app.execute("!!document.querySelector('#sidebar_toggle')")) {
        throw new Error("a rejected password reached the chat");
      }
      if (
        await app.execute(
          "document.querySelector('#connection-card-connect')?.disabled",
        )
      ) {
        throw new Error("the gate stayed locked");
      }
      await app.fill("#connection-card-password", PASSWORD);
      await app.click("document.querySelector('#connection-card-connect')");
      await app.waitFor(
        "document.body.innerText.includes('Trust this host?') || !!document.querySelector('#sidebar_toggle')",
        { what: "the host key question or the chat", timeoutMs: 30_000 },
      );
      if (
        await app.execute(
          "document.body.innerText.includes('Trust this host?')",
        )
      ) {
        await app.click(buttonByText("Trust"));
      }
      await app.waitFor("!!document.querySelector('#sidebar_toggle')", {
        what: "the chat after a good password",
        timeoutMs: 30_000,
      });
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

async function startXvfb() {
  for (let number = 90; number < 100; number += 1) {
    const display = `:${number}`;
    if (existsSync(`/tmp/.X${number}-lock`)) continue;
    const child = spawn(
      "Xvfb",
      [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
      { stdio: "ignore" },
    );
    await sleep(300);
    if (child.exitCode === null) return { child, display };
  }
  throw new Error("could not start Xvfb");
}

function checkTool(tool) {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
  } catch {
    throw new Error(
      `missing ${tool}; see e2e/README.md for the Linux prerequisites`,
    );
  }
}

async function main() {
  if (!existsSync(BIN)) {
    throw new Error(
      "the debug binary is missing; run `pnpm tauri build --debug --no-bundle`",
    );
  }
  checkTool("tauri-driver");
  checkTool("WebKitWebDriver");
  checkTool("Xvfb");

  if (options["no-reset"] === undefined) {
    execFileSync("bash", [join(E2E, "reset-host.sh")], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  const sandbox = mkdtempSync(join(tmpdir(), "pie-linux-e2e-"));
  const env = {
    ...process.env,
    HOME: join(sandbox, "home"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
  };
  const dirs = [
    env.HOME,
    env.XDG_DATA_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
  ];
  const resetAppData = () => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
  };
  resetAppData();

  const xvfb = await startXvfb();
  env.DISPLAY = xvfb.display;
  let driver;
  try {
    driver = await startDriver(env);
    const selected = selectCases(cases, options.cases);
    const report = {
      startedAt: new Date().toISOString(),
      address: ADDRESS,
      display: xvfb.display,
      cases: [],
    };
    let failed = 0;

    for (const item of selected) {
      resetAppData();
      const started = Date.now();
      const limit = item.timeoutMs ?? 90_000;
      let app;
      let status = "pass";
      let error;
      try {
        app = await AppSession.open(BIN);
        let timer;
        try {
          await Promise.race([
            item.run(app),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `the case did not finish within ${limit / 1000}s`,
                    ),
                  ),
                limit,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (problem) {
        error = String(problem.message ?? problem);
        status = "fail";
        failed += 1;
        try {
          await app?.screenshot(
            join(ARTIFACTS, "screens", `${item.id}-failed.png`),
          );
        } catch {
          // A closed window has no screenshot; the report still names the case.
        }
      } finally {
        await app?.quit();
      }
      const record = {
        id: item.id,
        priority: item.priority,
        name: item.name,
        status,
        error,
        ms: Date.now() - started,
      };
      report.cases.push(record);
      const line = `${record.status.toUpperCase().padEnd(5)} ${record.id} ${record.name}`;
      console.log(error === undefined ? line : `${line}\n      ${error}`);
    }

    report.finishedAt = new Date().toISOString();
    report.summary = {
      total: report.cases.length,
      passed: report.cases.filter((item) => item.status === "pass").length,
      failed,
    };
    writeFileSync(
      join(ARTIFACTS, "report.json"),
      `${JSON.stringify(report, null, 4)}\n`,
    );
    console.log(
      `\n${report.summary.passed}/${report.summary.total} passed, ${failed} failed (${ARTIFACTS})`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    stopDriver(driver);
    xvfb.child.kill("SIGKILL");
  }
}

await main();
