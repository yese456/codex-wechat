import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompletionStore,
  completionEventId,
  truncateSummary,
} from "../src/completions/store.js";
import type { CompletionEvent } from "../src/completions/types.js";

function event(overrides: Partial<CompletionEvent> = {}): CompletionEvent {
  const threadId = overrides.threadId ?? "thread-1";
  const turnId = overrides.turnId ?? "turn-1";
  return {
    id: overrides.id ?? completionEventId(threadId, turnId),
    threadId,
    turnId,
    cwd: overrides.cwd ?? "/tmp/project",
    requestSummary: overrides.requestSummary ?? "do work",
    resultSummary: overrides.resultSummary ?? "done",
    createdAt: overrides.createdAt ?? "2026-08-12T00:00:00.000Z",
  };
}

describe("CompletionStore", () => {
  it("deduplicates queued and acknowledged events", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-completion-store-"));
    const path = join(dir, "outbox.json");
    const store = new CompletionStore(path);
    const item = event();

    assert.equal(store.enqueue(item), true);
    assert.equal(store.enqueue(item), false);
    assert.deepEqual(store.poll(10), [item]);

    store.ack([item.id]);
    assert.deepEqual(store.poll(10), []);
    assert.equal(store.enqueue(item), false);
  });

  it("ignores unknown acknowledgement ids instead of persisting tombstones", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-completion-ack-"));
    const path = join(dir, "outbox.json");
    const store = new CompletionStore(path);

    store.ack(["f".repeat(64)]);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      tombstones: unknown[];
    };
    assert.deepEqual(raw.tombstones, []);
  });

  it("uses suppression markers once and prunes expired markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-completion-suppress-"));
    const path = join(dir, "outbox.json");
    let now = Date.parse("2026-08-12T00:00:00.000Z");
    const store = new CompletionStore(path, { now: () => now });

    store.markSuppression("thread", "same input", 1_000);
    assert.equal(store.consumeSuppression("thread", "same input"), true);
    assert.equal(store.consumeSuppression("thread", "same input"), false);

    store.markSuppression("thread", "expired input", 1_000);
    now += 1_001;
    assert.equal(store.consumeSuppression("thread", "expired input"), false);
  });

  it("preserves and reports a corrupted outbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-completion-corrupt-"));
    const path = join(dir, "outbox.json");
    writeFileSync(path, "{not-json");
    const store = new CompletionStore(path);

    assert.throws(() => store.poll(10), /损坏.*保留原文件/);
    assert.equal(readFileSync(path, "utf8"), "{not-json");
  });

  it("normalizes whitespace and truncates summaries", () => {
    assert.equal(truncateSummary(" a\n  b ", 20), "a b");
    assert.equal(truncateSummary("abcdef", 4), "abc…");
  });
});
