import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPACTION_MEMORY_SCHEMA, MEMORY_KEYS, CompactionMemoryError,
  parseCompactionMemory, mergeMemory,
} from "../src/compaction-memory.js";

const notes = patch => Object.fromEntries(MEMORY_KEYS.map(key => [key, patch[key] ?? []]));
const parse = patch => parseCompactionMemory(JSON.stringify(notes(patch)));

test("strict structured notes require useful content and exactly seven bounded categories", () => {
  const value = parse({ goals: ["[message 1] Deploy the existing 27B model."], constraints: ["[message 1] Use batch 256; no quantization change."] });
  assert.equal(value.constraints[0], "[message 1] Use batch 256; no quantization change.");
  assert.deepEqual(COMPACTION_MEMORY_SCHEMA.required, MEMORY_KEYS);
  assert.equal(COMPACTION_MEMORY_SCHEMA.additionalProperties, false);
});

test("two compactions retain legacy text, exact values, source references and chronological corrections", () => {
  const legacy = "Legacy facts: project code ORBIT_913; do not publish the database.\r\nKeep this whitespace.  ";
  const path = String.raw`[message 12] Edit C:\Users\ExampleUser\qwen-relay\worker\src\kaggle-server.py.`;
  const first = mergeMemory(legacy, parse({
    artifacts: [path], facts: ["[message 13] Context 98,304; batch 256; code ALPHA_409."],
    decisions: ["[message 14] Delivery deadline is 29 October at 18:00 MYT."],
  }), "messages 11–16");
  const second = mergeMemory(first, parse({
    artifacts: [path], corrections: ["[message 21] The deadline is now 30 October at 09:00 MYT, replacing the previous 29 October deadline."],
    next_steps: ["[message 22] Verify vision before deployment; this is still unfinished."],
  }), "messages 17–24");
  assert(second.startsWith(first + "\n\n"));
  assert(first.startsWith(legacy + "\n\n"));
  for (const exact of ["ORBIT_913", "98,304", "batch 256", "ALPHA_409", "messages 11–16", "messages 17–24"]) assert(second.includes(exact));
  assert(second.includes(JSON.stringify(path)));
  assert.equal(second.split(JSON.stringify(path)).length - 1, 1, "Repeated artifacts are not rewritten or duplicated");
  assert(second.indexOf("29 October at 18:00") < second.indexOf("30 October at 09:00"));
  assert(second.includes("still unfinished"));
});

test("duplicate-only updates are idempotent and leave existing sources untouched", () => {
  const facts = parse({ facts: ["[message 2] Exact code BETA_771.", "[message 2] Exact code BETA_771."] });
  const first = mergeMemory("", facts, "messages 1–4");
  assert.equal(mergeMemory(first, facts, "messages 5–8"), first);
  assert.equal(first.split("BETA_771").length - 1, 1);
});

test("an explicitly allowed filler-only extraction stays empty instead of inventing facts", () => {
  const empty = notes({});
  assert.throws(() => parseCompactionMemory(JSON.stringify(empty)), CompactionMemoryError);
  assert.deepEqual(parseCompactionMemory(JSON.stringify(empty), { allowEmpty: true }), empty);
  assert.throws(() => mergeMemory("Previous exact fact ALPHA_991.", empty, "filler-only source"), CompactionMemoryError);
  assert.throws(() => parseCompactionMemory(JSON.stringify(notes({ facts: ["No new facts."] })), { allowEmpty: true }), CompactionMemoryError);
});

test("invalid, empty, placeholder, reasoning and truncated output never becomes memory", () => {
  const invalid = [
    "{", '```json\n{}\n```', "[]", "null", JSON.stringify(notes({})),
    JSON.stringify({ ...notes({ facts: ["actual fact"] }), extra: [] }),
    JSON.stringify({ ...notes({ facts: ["actual fact"] }), goals: undefined }),
    JSON.stringify(notes({ facts: [null] })), JSON.stringify(notes({ facts: ["x".repeat(1201)] })),
    JSON.stringify(notes({ facts: Array(21).fill("actual fact") })),
    ...["continued answer.", "No new facts.", "N/A", "Let me think carefully about this", "<think>private reasoning", "Analysis: I should summarize", "[message 4] continued answer.", "[message 4] ", "[message 4] Unexpected <think> trace"].map(item => JSON.stringify(notes({ facts: [item] }))),
  ];
  for (const output of invalid) assert.throws(() => parseCompactionMemory(output), CompactionMemoryError, output.slice(0, 100));
});

test("memory capacity failure preserves old text and input notes without mutation", () => {
  const previous = "Original exact constraint: never change model precision.\n";
  const incoming = parse({ facts: ["[message 9] Required identifier GAMMA_550."], constraints: ["[message 9] Keep all source files."] });
  const snapshot = JSON.stringify(incoming);
  assert.throws(() => mergeMemory(previous, incoming, "message 9", previous.length + 10), error => error.code === "memory_limit");
  assert.equal(previous, "Original exact constraint: never change model precision.\n");
  assert.equal(JSON.stringify(incoming), snapshot);
  assert.throws(() => mergeMemory(previous, incoming, "untrusted\nlabel"), TypeError);
});

test("literal newlines and backslashes are preserved unambiguously in rendered notes", () => {
  const fact = "[message 6] Literal path C:\\tmp\\report.txt and code:\nreturn value + 1;";
  const merged = mergeMemory("", parse({ artifacts: [fact] }), "message 6");
  assert(merged.includes(JSON.stringify(fact)));
  assert(!merged.includes("\nreturn value"), "A note cannot manufacture another ledger line");
});
