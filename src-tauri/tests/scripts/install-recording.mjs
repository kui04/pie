#!/usr/bin/env node
// Installs a recorded `pi --mode rpc` session as a fixture: sanitizes opaque
// values, trims bulk that is not protocol shape, writes it into
// src-tauri/tests/fixtures, and reports what is in it.
//
//   node src-tauri/tests/scripts/install-recording.mjs <input.jsonl> <fixture-name.jsonl>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STRING_CAP = 120;
const PROMPT_SECTIONS = 2;
const PROMPT_TOOLS = 2;

const [input, name] = process.argv.slice(2);
if (!input || !name) {
  console.error(
    "usage: install-recording.mjs <input.jsonl> <fixture-name.jsonl>",
  );
  process.exit(2);
}

// Trims the harness prompt, which is what makes a recording big: it repeats the
// whole system prompt and every tool schema in each message. Protocol shape -
// records, entries, messages, content parts - is left alone, or the fixture would
// stop covering what it exists for.
const trim = (value, key) => {
  if (typeof value === "string")
    return value.length > STRING_CAP
      ? `${value.slice(0, STRING_CAP)}\u2026`
      : value;
  if (Array.isArray(value)) {
    const mapped = value.map((item) => trim(item));
    return key === "toolsAdded" || key === "toolsRemoved"
      ? mapped.slice(0, PROMPT_TOOLS)
      : mapped;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      trim(entryValue, entryKey),
    ]);
    const trimmed = Object.fromEntries(
      key === "sections" && entries.length > PROMPT_SECTIONS
        ? entries.slice(0, PROMPT_SECTIONS)
        : entries,
    );
    return trimmed;
  }
  return value;
};

const sanitize = (line) =>
  line
    .replaceAll("/home/kui04", "/home/user")
    .replace(
      /"sessionId":"[0-9a-f-]{36}"/g,
      '"sessionId":"00000000-0000-4000-8000-000000000000"',
    );

const lines = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.stringify(trim(JSON.parse(sanitize(line)))));
const fixture = join("src-tauri", "tests", "fixtures", name);
writeFileSync(fixture, `${lines.join("\n")}\n`);

const records = lines.map((line) => JSON.parse(line));
const kinds = {};
for (const record of records) {
  const kind = `${record.type}${record.method ? `:${record.method}` : ""}${record.command ? `:${record.command}` : ""}${
    record.assistantMessageEvent ? `:${record.assistantMessageEvent.type}` : ""
  }`;
  kinds[kind] = (kinds[kind] ?? 0) + 1;
}

const entryTypes = new Set();
for (const record of records) {
  if (record.command === "get_entries")
    for (const entry of record.data.entries) entryTypes.add(entry.type);
}

console.log(
  `${fixture}: ${lines.length} records, ${readFileSync(fixture).length} bytes`,
);
console.log(
  "record kinds:",
  Object.entries(kinds)
    .map(([kind, count]) => `${kind}×${count}`)
    .join(", "),
);
console.log("entry types:", [...entryTypes].join(", "));
