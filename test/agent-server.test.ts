import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentHttpStatusForError,
  agentRequestTimeout,
  validateCompletionAckIds,
  validateCompletionLimit,
} from "../src/agent/server.js";
import { HostInputError } from "../src/hosts/types.js";

describe("Agent HTTP safeguards", () => {
  it("keeps requestTimeout beyond the long prompt lifecycle", () => {
    assert.equal(agentRequestTimeout(30 * 60_000), 31 * 60_000);
    assert.equal(agentRequestTimeout(30_000), 120_000);
  });

  it("maps user-controlled host validation errors to HTTP 400", () => {
    assert.equal(agentHttpStatusForError(new HostInputError("bad model")), 400);
    assert.equal(agentHttpStatusForError(new Error("app-server offline")), 500);
  });

  it("validates completion poll limits and acknowledgement ids", () => {
    assert.equal(validateCompletionLimit(null, 20), 20);
    assert.equal(validateCompletionLimit("100", 20), 100);
    assert.throws(() => validateCompletionLimit("0", 20), /1-100/);
    assert.throws(() => validateCompletionLimit("1.5", 20), /1-100/);

    const id = "a".repeat(64);
    assert.deepEqual(validateCompletionAckIds([id, id.toUpperCase()]), [id]);
    assert.throws(() => validateCompletionAckIds(["short"]), /SHA-256/);
    assert.throws(() => validateCompletionAckIds([]), /SHA-256/);
  });
});
