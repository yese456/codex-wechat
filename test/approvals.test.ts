import { it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalBridge } from "../src/approvals.js";
import type {
  CodexClient,
  CodexEvent,
  PendingApproval,
} from "../src/codex/client.js";

it("auto-declines even when approval notification fails", async () => {
  const resolved: Array<[string, string]> = [];
  const fake = {
    onEvent: null as ((event: CodexEvent) => void) | null,
    async resolveApproval(code: string, decision: string) {
      resolved.push([code, decision]);
      return "ok";
    },
  } as unknown as CodexClient;
  const bridge = new ApprovalBridge(fake, 0.01, async () => {
    throw new Error("notification offline");
  });
  bridge.attach();
  const approval: PendingApproval = {
    id: "request-1",
    rpcId: 1,
    shortCode: "a1",
    method: "item/commandExecution/requestApproval",
    params: {},
    threadId: "thread-1",
    summary: "test",
    createdAt: Date.now(),
  };
  fake.onEvent?.({ type: "approval", approval });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(resolved, [["a1", "decline"]]);
  bridge.dispose();
});
