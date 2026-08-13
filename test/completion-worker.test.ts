import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionDeliveryStore } from "../src/completions/delivery-store.js";
import {
  formatCompletionNotification,
  runCompletionCycle,
} from "../src/completions/worker.js";
import type { CompletionEvent } from "../src/completions/types.js";

const event: CompletionEvent = {
  id: "a".repeat(64),
  threadId: "thread-1",
  turnId: "turn-1234567890abcdef",
  cwd: "/workspace/demo",
  requestSummary: "build feature",
  resultSummary: "feature completed",
  createdAt: "2026-08-12T00:00:00.000Z",
};

function deliveryStore(): CompletionDeliveryStore {
  const dir = mkdtempSync(join(tmpdir(), "cw-delivery-"));
  return new CompletionDeliveryStore(join(dir, "delivery.json"));
}

describe("completion delivery worker", () => {
  it("formats a concise project notification", () => {
    const text = formatCompletionNotification(
      { id: "mac", label: "Mac Agent" },
      event,
    );
    assert.match(text, /host=mac Mac Agent/);
    assert.match(text, /项目: demo/);
    assert.match(text, /请求: build feature/);
    assert.match(text, /结果: feature completed/);
  });

  it("sends, records delivery, then acknowledges", async () => {
    const actions: string[] = [];
    const store = deliveryStore();
    await runCompletionCycle({
      host: {
        id: "mac",
        label: "Mac",
        completionNotificationsEnabled: true,
        pollCompletions: async () => [event],
        ackCompletions: async (ids) => actions.push(`ack:${ids.join(",")}`),
      },
      batchSize: 10,
      deliveryStore: store,
      userId: "wx-user",
      sendToUser: async () => actions.push("send"),
    });

    assert.deepEqual(actions, ["send", `ack:${event.id}`]);
    assert.equal(store.isSent("mac", event.id), true);
  });

  it("retries acknowledgement without sending twice after delivery was recorded", async () => {
    const actions: string[] = [];
    const store = deliveryStore();
    store.markSent("mac", event.id);

    await runCompletionCycle({
      host: {
        id: "mac",
        label: "Mac",
        completionNotificationsEnabled: true,
        pollCompletions: async () => [event],
        ackCompletions: async () => actions.push("ack"),
      },
      batchSize: 10,
      deliveryStore: store,
      userId: "wx-user",
      sendToUser: async () => actions.push("send"),
    });

    assert.deepEqual(actions, ["ack"]);
  });

  it("does not send or acknowledge until a WeChat user is bound", async () => {
    const actions: string[] = [];
    await runCompletionCycle({
      host: {
        id: "mac",
        label: "Mac",
        completionNotificationsEnabled: true,
        pollCompletions: async () => [event],
        ackCompletions: async () => actions.push("ack"),
      },
      batchSize: 10,
      deliveryStore: deliveryStore(),
      userId: null,
      sendToUser: async () => actions.push("send"),
    });

    assert.deepEqual(actions, []);
  });

  it("preserves and reports a corrupted delivery ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-delivery-corrupt-"));
    const path = join(dir, "delivery.json");
    writeFileSync(path, "{broken");
    const store = new CompletionDeliveryStore(path);

    assert.throws(() => store.isSent("mac", event.id), /损坏.*保留原文件/);
    assert.equal(readFileSync(path, "utf8"), "{broken");
  });
});
