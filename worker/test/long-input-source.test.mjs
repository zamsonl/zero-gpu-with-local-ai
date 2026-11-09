import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLongInput, longInputRanges, longInputChunk, splitLongInputRange, sourceHash } from "../src/long-input-source.js";

test("long inputs require explicit consent, retain literal document text and enforce the storage envelope", () => {
  assert.throws(() => parseLongInput({ content: "Read this" }), /Confirm/);
  const source = parseLongInput({ consent: true, client_id: "fixture_1", content: "Keep CODE_129.", think: false, attachments: [{ name: "C:\\folder\\config.txt", text: "port=8123\n预算17.5" }] });
  assert.equal(source.think, false);
  assert.equal(source.documents[0].name, "config.txt");
  assert(source.sourceText.includes("port=8123\n预算17.5"));
  assert.throws(() => parseLongInput({ consent: true, content: "x".repeat(1_000_001) }), /1,000,000/);
  assert.throws(() => parseLongInput({ consent: true, attachments: [{ name: "a.png", data: "abc" }] }), /not pictures/);
  assert.throws(() => parseLongInput({ consent: true, content: "x", think: "anything" }), /think/);
  assert.throws(() => parseLongInput({ consent: true, content: "x", client_id: "bad/path" }), /identity/);
});

test("reading ranges and smaller retries retain every source character and source attribution", async () => {
  const text = "😀中文 exact C:\\Demo\\engine.toml\n".repeat(2500);
  const ranges = longInputRanges(text);
  assert(ranges.length > 1);
  const smaller = ranges.flatMap(range => splitLongInputRange(text, range));
  assert.equal(smaller.map(range => text.slice(range.start, range.end)).join(""), text);
  for (const range of smaller) {
    const fragment = JSON.parse(longInputChunk(text, range, 77)).fragments[0];
    assert.equal(fragment.message_id, 77);
    assert.equal(fragment.offset, range.start);
    assert(!/^[\uDC00-\uDFFF]/.test(fragment.text));
    assert(!/[\uD800-\uDBFF]$/.test(fragment.text));
    assert((fragment.previous_context?.length ?? 0) <= 240);
  }
  assert.equal(await sourceHash(text), await sourceHash(text));
  assert.notEqual(await sourceHash(text), await sourceHash(text + "changed"));
});
