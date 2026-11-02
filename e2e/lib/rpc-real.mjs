// Checks the real test host: the configured provider, model, and level are
// live, and the key resolves through the Docker secret.

import { spawn } from "node:child_process";

const [
  ,
  ,
  host = "127.0.0.1",
  port = "2223",
  key,
  knownHosts,
  provider,
  model,
  level,
  cwd = "/home/pi/work",
] = process.argv;

if (provider === undefined || model === undefined || level === undefined) {
  console.error(
    "usage: rpc-real.mjs <host> <port> <key> <known_hosts> <provider> <model> <level> [cwd]",
  );
  process.exit(2);
}

const ssh = spawn(
  "ssh",
  [
    "-p",
    port,
    "-i",
    key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    `pi@${host}`,
    `cd ${cwd} && exec pi --mode rpc`,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);

const pending = new Map();
let buffer = "";
let stderr = "";

ssh.stdout.setEncoding("utf8");
ssh.stdout.on("data", (text) => {
  buffer += text;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        console.error(`REAL-01 FAIL the RPC stream is not JSON: ${line}`);
        process.exit(1);
      }
      const wait = pending.get(record.command);
      if (wait !== undefined) {
        pending.delete(record.command);
        wait(record);
      }
    }
    index = buffer.indexOf("\n");
  }
});
ssh.stderr.setEncoding("utf8");
ssh.stderr.on("data", (text) => {
  stderr += text;
});

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

async function call(command, payload, timeoutMs = 20000) {
  const answered = new Promise((resolve) => pending.set(command, resolve));
  ssh.stdin.write(`${JSON.stringify(payload)}\n`);
  const timer = setTimeout(() => {
    pending.delete(command);
    throw new Error(`no response to ${command} within ${timeoutMs}ms`);
  }, timeoutMs);
  try {
    return await answered;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const state = await call("get_state", { type: "get_state" });
  expect(state.success === true, "get_state did not succeed");
  expect(
    state.data?.model?.provider === provider,
    `the provider is ${JSON.stringify(state.data?.model?.provider)}, expected ${provider}`,
  );
  expect(
    state.data?.model?.id === model,
    `the model is ${JSON.stringify(state.data?.model?.id)}, expected ${model}`,
  );
  expect(
    state.data?.thinkingLevel === level,
    `the level is ${JSON.stringify(state.data?.thinkingLevel)}, expected ${level}`,
  );

  const models = await call("get_available_models", {
    type: "get_available_models",
  });
  expect(
    (models.data?.models ?? []).some(
      (item) => item.provider === provider && item.id === model,
    ),
    `${provider}/${model} is missing from the model list`,
  );

  const levels = await call("get_available_thinking_levels", {
    type: "get_available_thinking_levels",
  });
  expect(
    (levels.data?.levels ?? []).includes(level),
    `the level ${level} is not available: ${JSON.stringify(levels.data?.levels)}`,
  );
} catch (error) {
  failures.push(String(error.message ?? error));
} finally {
  ssh.stdin.end();
  ssh.kill("SIGTERM");
}

if (stderr.trim() !== "" && failures.length > 0) {
  console.error(`REAL-01 stderr: ${stderr.trim()}`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`REAL-01 FAIL ${failure}`);
  process.exit(1);
}
console.log(`REAL-01 PASS ${provider}/${model} at ${level} over pi --mode rpc`);
