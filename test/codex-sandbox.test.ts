import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexClient, approvalResultFor } from "../src/codex/client.js";

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
});
