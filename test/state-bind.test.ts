import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.js";

describe("StateStore.bind", () => {
  it("accepts correct code and rejects wrong with lockout", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-state-"));
    const store = new StateStore(join(dir, "state.json"), dir);
    const { code } = store.issueBindCode(60_000);
    assert.equal(store.tryBind("user-a", "deadbeef", 3).ok, false);
    assert.equal(store.tryBind("user-a", "deadbeef", 3).ok, false);
    const third = store.tryBind("user-a", "deadbeef", 3);
    assert.equal(third.ok, false);
    if (!third.ok) {
      assert.match(third.reason, /作废|过多/);
    }
    // code invalidated — even correct code fails until re-issue
    assert.equal(store.tryBind("user-a", code, 3).ok, false);
    const { code: code2 } = store.issueBindCode(60_000);
    assert.equal(store.tryBind("user-a", code2, 3).ok, true);
    assert.equal(store.load().allowUserId, "user-a");
  });

  it("uses long hex codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-state-"));
    const store = new StateStore(join(dir, "state.json"), dir);
    const { code } = store.issueBindCode();
    assert.ok(code.length >= 32);
  });
});
