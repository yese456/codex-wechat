import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompletionStore,
  completionEventId,
} from "../src/completions/store.js";
import {
  dispatchCompletionNotify,
  parseCompletionNotifyEvent,
  trustedNotifyConfigPath,
} from "../src/completions/dispatcher.js";
import type { AppConfig } from "../src/config.js";

function config(queuePath: string, enabled = true): AppConfig {
  return {
    completionNotifications: {
      enabled,
      queuePath,
      deliveryPath: join(tmpdir(), "unused-delivery.json"),
      pollIntervalMs: 5_000,
      batchSize: 20,
      requestSummaryChars: 40,
      resultSummaryChars: 60,
      ackRetentionDays: 7,
      callbacks: [],
    },
  } as AppConfig;
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-1",
    "turn-id": "turn-1",
    cwd: "/tmp/project",
    "input-messages": [{ text: "first" }, { text: "last request" }],
    "last-assistant-message": "final result",
    ...overrides,
  });
}

describe("completion notify dispatcher", () => {
  it("uses only the trusted user config path for global notify dispatch", () => {
    const previous = process.env.CODEX_WECHAT_CONFIG;
    try {
      delete process.env.CODEX_WECHAT_CONFIG;
      assert.equal(
        trustedNotifyConfigPath("/home/tester"),
        "/home/tester/.codex-wechat/config.yaml",
      );
      process.env.CODEX_WECHAT_CONFIG = "/trusted/config.yaml";
      assert.equal(trustedNotifyConfigPath("/home/tester"), "/trusted/config.yaml");
    } finally {
      if (previous === undefined) delete process.env.CODEX_WECHAT_CONFIG;
      else process.env.CODEX_WECHAT_CONFIG = previous;
    }
  });

  it("parses supported notify payloads and ignores invalid events", () => {
    const cfg = config("/tmp/outbox.json");
    const parsed = parseCompletionNotifyEvent(payload(), cfg);
    assert.ok(parsed);
    assert.equal(parsed.id, completionEventId("thread-1", "turn-1"));
    assert.equal(parsed.requestSummary, "last request");
    assert.equal(parsed.resultSummary, "final result");
    assert.equal(parseCompletionNotifyEvent("not-json", cfg), null);
    assert.equal(
      parseCompletionNotifyEvent(payload({ type: "other" }), cfg),
      null,
    );
  });

  it("queues unsuppressed events and deduplicates repeats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-dispatch-"));
    const queuePath = join(dir, "outbox.json");
    const cfg = config(queuePath);
    const store = new CompletionStore(queuePath);

    await dispatchCompletionNotify({ rawJson: payload(), config: cfg, store });
    await dispatchCompletionNotify({ rawJson: payload(), config: cfg, store });

    assert.equal(store.poll(10).length, 1);
  });

  it("suppresses matching synchronous prompts once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-dispatch-suppress-"));
    const queuePath = join(dir, "outbox.json");
    const cfg = config(queuePath);
    const store = new CompletionStore(queuePath);
    store.markSuppression("thread-1", "last request", 60_000);

    await dispatchCompletionNotify({ rawJson: payload(), config: cfg, store });
    assert.deepEqual(store.poll(10), []);

    await dispatchCompletionNotify({ rawJson: payload(), config: cfg, store });
    assert.equal(store.poll(10).length, 1);
  });

  it("keeps existing callbacks active even when completion queueing is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-dispatch-callback-"));
    const queuePath = join(dir, "outbox.json");
    const cfg = config(queuePath, false);
    cfg.completionNotifications.callbacks = [
      { argv: ["existing-callback", "--flag"], timeoutMs: 1_000 },
    ];
    const calls: Array<{ command: string; args: string[] }> = [];

    await dispatchCompletionNotify({
      rawJson: payload(),
      config: cfg,
      spawnCallback: ((command, args) => {
        calls.push({ command, args });
        const listeners = new Map<string, (...values: unknown[]) => void>();
        const child = {
          once(name: string, listener: (...values: unknown[]) => void) {
            listeners.set(name, listener);
            if (name === "exit") queueMicrotask(() => listener(0, null));
            return child;
          },
          kill() {
            return true;
          },
        };
        return child as never;
      }) as never,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "existing-callback");
    assert.deepEqual(calls[0]?.args.slice(0, 1), ["--flag"]);
    assert.equal(calls[0]?.args[1], payload());
  });
});
