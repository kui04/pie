#!/usr/bin/env node
// Records a `pi --mode rpc` session verbatim and reacts to what pi sends, so a
// recording can reach situations a static pipeline cannot: forking by an entry id
// that only exists at runtime, steering mid-run, aborting a run, answering the
// dialogs pi opens.
//
//   node src-tauri/tests/scripts/record.mjs <scenario> <out.jsonl>
//
// Scenarios: reasoning (compaction + fork + a prompt on the new branch), session
// (file-backed session commands, no model calls), tour (streaming bash, steering,
// abort), failures (a refused model switch and a compaction that cannot run).

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const [scenario, outFile] = process.argv.slice(2);
if (!scenario || !outFile) {
  console.error(
    "usage: record.mjs <reasoning|session|tour|failures> <out.jsonl>",
  );
  process.exit(2);
}

const args = ["--mode", "rpc"];
if (scenario === "tour" || scenario === "session")
  args.push("--session-dir", "/tmp/pie-recording-sessions");
else args.push("--no-session");

const out = createWriteStream(outFile, { flags: "w" });
const pi = spawn("pi", args, { stdio: ["pipe", "pipe", "inherit"] });

let counter = 0;
let buffer = "";
let switched = false;
const send = (command) => {
  if (pi.stdin.writable)
    pi.stdin.write(`${JSON.stringify({ id: `c${++counter}`, ...command })}\n`);
};
const stop = () => pi.stdin.end();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const onResponse = {};
const onEvent = {};

pi.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const raw = buffer.slice(0, index);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    buffer = buffer.slice(index + 1);
    out.write(`${line}\n`);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "response") onResponse[record.command]?.(record);
    else if (record.type === "extension_ui_request") {
      // Answer every dialog so a run can never stall on one.
      if (["confirm", "select", "input", "editor"].includes(record.method)) {
        const answer =
          record.method === "confirm"
            ? { confirmed: true }
            : { cancelled: true };
        pi.stdin.write(
          `${JSON.stringify({ type: "extension_ui_response", id: record.id, ...answer })}\n`,
        );
      }
    } else onEvent[record.type]?.(record);
  }
});

pi.on("exit", (code) => {
  out.end(() => console.log(`${scenario}: pi exited ${code} -> ${outFile}`));
});

async function reasoning() {
  let phase = "turn-1";
  send({ type: "set_thinking_level", level: "max" });
  send({
    type: "prompt",
    message: "Read package.json and reply with only its version.",
  });

  // Runs are driven by `agent_end` (a turn settled) and by responses (a command
  // finished); mixing the two is what raced the first attempt.
  onEvent.agent_end = () => {
    if (phase === "turn-1") {
      phase = "turn-2";
      send({ type: "prompt", message: "Reply with only: second turn" });
    } else if (phase === "turn-2") {
      phase = "compacting";
      setTimeout(() => send({ type: "compact" }), 1500);
    }
  };
  onResponse.compact = () => {
    if (phase !== "compacting") return;
    phase = "forking";
    // The compaction entry is appended right after `compaction_end`, so asking
    // now shows it.
    send({ type: "get_entries" });
    send({ type: "get_fork_messages" });
  };
  onResponse.get_fork_messages = (record) => {
    if (phase !== "forking") return;
    phase = "waiting-for-fork";
    // `fork` only accepts the ids this command reports.
    send({ type: "fork", entryId: record.data.messages[0].entryId });
  };
  onResponse.fork = () => {
    if (phase !== "waiting-for-fork") return;
    phase = "branching";
    send({ type: "prompt", message: "Reply with only: branch ok" });
  };
  onEvent.agent_settled = () => {
    if (phase !== "branching") return;
    phase = "reporting";
    send({ type: "get_entries" });
    send({ type: "get_tree" });
    send({ type: "get_messages" });
    send({ type: "get_session_stats" });
    send({ type: "export_html", outputPath: "/tmp/pie-export.html" });
    setTimeout(stop, 6000);
  };
  await sleep(300000);
  stop();
}

/// Session commands that need no model at all: file-backed sessions, switching,
/// exporting, and the queue/policy setters.
async function session() {
  send({ type: "set_session_name", name: "pie recording session" });
  send({ type: "bash", command: "echo hello from the session tour" });
  await sleep(4000);
  await new Promise((resolve) => {
    onResponse.get_state = (record) => {
      const file = record.data.sessionFile;
      if (file && !switched) {
        switched = true;
        send({ type: "switch_session", sessionPath: file });
      }
      resolve();
    };
    send({ type: "get_state" });
  });
  await sleep(4000);
  send({ type: "get_entries" });
  send({ type: "get_session_stats" });
  send({ type: "get_tree" });
  send({ type: "get_last_assistant_text" });
  send({ type: "export_html", outputPath: "/tmp/pie-session.html" });
  send({ type: "clear_queue" });
  send({ type: "cycle_model" });
  send({ type: "set_auto_compaction", enabled: true });
  send({ type: "set_auto_retry", enabled: false });
  send({ type: "abort_retry" });
  send({ type: "clone" });
  await sleep(5000);
  send({ type: "new_session" });
  await sleep(4000);
  send({ type: "get_state" });
  await sleep(3000);
  stop();
}

async function tour() {
  send({ type: "set_session_name", name: "pie recording tour" });

  // Streaming shell output, then a long one that gets aborted.
  send({
    type: "bash",
    command: "for i in 1 2 3; do echo tick $i; sleep 1; done",
  });
  await sleep(6000);
  send({ type: "bash", command: "sleep 60" });
  await sleep(4000);
  send({ type: "abort_bash" });

  // A run that gets steered, then aborted.
  let steered = false;
  onEvent.agent_start = () => {
    if (steered) return;
    steered = true;
    setTimeout(
      () => send({ type: "steer", message: "Actually, just reply with: done" }),
      2500,
    );
    setTimeout(
      () => send({ type: "follow_up", message: "And say nothing else." }),
      4000,
    );
  };
  send({
    type: "prompt",
    message: "Count from 1 to 100, one number per line.",
  });
  await sleep(15000);
  send({ type: "abort" });
  await sleep(4000);

  send({ type: "get_state" });
  send({ type: "get_messages" });
  send({ type: "get_entries" });
  send({ type: "get_session_stats" });

  // Session commands that need no model.
  send({ type: "clear_queue" });
  send({ type: "get_tree" });
  send({ type: "get_last_assistant_text" });
  send({ type: "get_fork_messages" });
  send({ type: "cycle_model" });
  send({ type: "cycle_thinking_level" });
  send({ type: "set_auto_compaction", enabled: false });
  send({ type: "set_auto_retry", enabled: true });
  send({ type: "abort_retry" });
  send({ type: "clone" });
  send({ type: "export_html", outputPath: "/tmp/pie-tour.html" });
  await sleep(5000);
  send({ type: "new_session" });
  await sleep(4000);
  send({ type: "get_state" });
  await sleep(3000);
  stop();
}

async function failures() {
  send({ type: "set_auto_retry", enabled: true });
  send({ type: "set_auto_compaction", enabled: true });
  send({
    type: "set_model",
    provider: "openrouter",
    modelId: "stealth/pie-recording-does-not-exist",
  });
  await sleep(2000);
  send({ type: "prompt", message: "Say hi." });
  await sleep(45000);
  send({ type: "get_messages" });
  send({ type: "get_session_stats" });
  await sleep(3000);
  // A compaction whose summarizer cannot run.
  send({ type: "compact" });
  await sleep(60000);
  send({ type: "get_entries" });
  send({ type: "get_state" });
  await sleep(5000);
  stop();
}

const scenarios = { reasoning, session, tour, failures };
const run = scenarios[scenario];
if (!run) {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(2);
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
