import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitText } from "../src/text.js";

describe("splitText", () => {
  it("returns single chunk when short", () => {
    assert.deepEqual(splitText("hello", 100), ["hello"]);
  });
  it("splits long text", () => {
    const s = "a".repeat(50) + "\n\n" + "b".repeat(50);
    const parts = splitText(s, 40);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length <= 40));
  });
  it("rejects non-positive chunk sizes", () => {
    assert.throws(() => splitText("hello", 0), /正整数/);
    assert.throws(() => splitText("hello", -1), /正整数/);
  });
});
