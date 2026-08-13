import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CodexClient,
  approvalResultFor,
  formatTurnCompletionText,
} from "../src/codex/client.js";

describe("Codex sandbox and approval policy", () => {
  it("enforces read-only/on-request when starting and resuming threads", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const codex = new CodexClient({ command: "codex" });
    codex.ensureConnected = async () => {};
    (codex as unknown as {
      client: {
        request: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    }).client = {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-1",
              cwd: "/work",
              preview: "",
              updatedAt: 1,
              createdAt: 1,
            },
          };
        }
        return {};
      },
    };

    await codex.startThread("/work");
    await codex.resumeThread("thread-1", "/work");
    await codex.startTurn({ threadId: "thread-1", text: "hello", cwd: "/work" });

    assert.deepEqual(requests[0]?.params, {
      cwd: "/work",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    assert.deepEqual(requests[1]?.params, {
      threadId: "thread-1",
      cwd: "/work",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    assert.equal(requests[2]?.params.approvalPolicy, "on-request");
    assert.equal(requests[2]?.params.approvalsReviewer, "user");
  });

  it("reports a failed turn before any partial assistant text", () => {
    assert.equal(
      formatTurnCompletionText({
        status: "failed",
        lastAgentText: "partial answer",
      }),
      "❌ Codex 执行失败（failed）（无详细错误信息）",
    );
    assert.equal(
      formatTurnCompletionText({
        status: "completed",
        lastAgentText: "final answer",
      }),
      "final answer",
    );
  });

  it("grants only the requested permission profile for the current turn", () => {
    const requested = {
      fileSystem: {
        entries: [
          { access: "write", path: { type: "path", path: "/work" } },
        ],
      },
    };
    assert.deepEqual(
      approvalResultFor(
        "item/permissions/requestApproval",
        "accept",
        { permissions: requested },
      ),
      { permissions: requested, scope: "turn" },
    );
    assert.deepEqual(
      approvalResultFor(
        "item/permissions/requestApproval",
        "decline",
        { permissions: requested },
      ),
      { permissions: {}, scope: "turn" },
    );
  });

  it("writes dynamic policy globally and reapplies it to the next thread resume", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const codex = new CodexClient({ command: "codex" });
    codex.ensureConnected = async () => {};
    (codex as unknown as {
      client: {
        request: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    }).client = {
      request: async (method, params) => {
        requests.push({ method, params });
        return {};
      },
    };

    await codex.setSandboxMode("workspace-write");
    await codex.setApprovalPolicy("never");
    await codex.resumeThread("thread-1", "/work");

    assert.deepEqual(requests[0], {
      method: "config/value/write",
      params: {
        keyPath: "sandbox_mode",
        value: "workspace-write",
        mergeStrategy: "replace",
      },
    });
    assert.deepEqual(requests[1], {
      method: "config/value/write",
      params: {
        keyPath: "approval_policy",
        value: "never",
        mergeStrategy: "replace",
      },
    });
    assert.deepEqual(requests[2]?.params, {
      threadId: "thread-1",
      cwd: "/work",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    assert.deepEqual(codex.getSecurityPolicy(), {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });
  });
});
