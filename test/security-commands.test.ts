import { it } from "node:test";
import assert from "node:assert/strict";
import { MessageHandler } from "../src/handler.js";
import type { AppConfig } from "../src/config.js";
import type { StateStore } from "../src/state.js";
import type { HostRegistry } from "../src/hosts/registry.js";
import type {
  CodexHost,
  SecurityPolicySnapshot,
} from "../src/hosts/types.js";

it("queries and safely switches sandbox and approval policy", async () => {
  let policy: SecurityPolicySnapshot = {
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
  };
  const calls: string[] = [];
  const host = {
    id: "local",
    label: "Local",
    kind: "local",
    async getSecurityPolicy() {
      calls.push("read");
      return policy;
    },
    async setSandboxMode(mode: SecurityPolicySnapshot["sandboxMode"]) {
      calls.push(`sandbox:${mode}`);
      policy = { ...policy, sandboxMode: mode };
      return policy;
    },
    async setApprovalPolicy(
      approvalPolicy: SecurityPolicySnapshot["approvalPolicy"],
    ) {
      calls.push(`approval:${approvalPolicy}`);
      policy = { ...policy, approvalPolicy };
      return policy;
    },
  } as unknown as CodexHost;
  const state = {
    load: () => ({ allowUserId: "user-1" }),
  } as unknown as StateStore;
  const hosts = {
    current: () => host,
  } as unknown as HostRegistry;
  const handler = new MessageHandler(
    { bindMaxFails: 5, maxReplyChars: 3500 } as AppConfig,
    state,
    hosts,
  );
  const replies: string[] = [];
  const reply = {
    text: async (text: string) => {
      replies.push(text);
    },
    image: async () => {},
    file: async () => {},
  };

  await handler.handle("user-1", { text: "/permissions" }, reply);
  await handler.handle("user-1", { text: "/sandbox workspace-write" }, reply);
  assert.equal(policy.sandboxMode, "read-only");
  await handler.handle(
    "user-1",
    { text: "/sandbox workspace-write confirm" },
    reply,
  );
  await handler.handle("user-1", { text: "/approval never" }, reply);
  assert.equal(policy.approvalPolicy, "on-request");
  await handler.handle(
    "user-1",
    { text: "/approval never confirm" },
    reply,
  );
  await handler.handle("user-1", { text: "/sandbox read-only" }, reply);

  assert.deepEqual(calls, [
    "read",
    "read",
    "read",
    "sandbox:workspace-write",
    "read",
    "read",
    "approval:never",
    "read",
    "sandbox:read-only",
  ]);
  assert.match(replies[0]!, /sandbox: read-only/);
  assert.match(replies[1]!, /60 秒内/);
  assert.match(replies[2]!, /全局 sandbox/);
  assert.match(replies[3]!, /\/approval never confirm/);
  assert.match(replies[4]!, /高风险设置/);
  assert.match(replies[5]!, /sandbox: read-only/);
});
