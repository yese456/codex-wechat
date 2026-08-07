import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findModel, reasoningEffortFor, type CodexModelInfo } from "../src/models.js";

const model: CodexModelInfo = {
  id: "gpt-5.1-codex",
  displayName: "GPT-5.1 Codex",
  description: "",
  supportedReasoningEfforts: ["low", "medium", "high", "max"],
  defaultReasoningEffort: "high",
  isDefault: true,
};

describe("model selection", () => {
  it("matches canonical id and display name case-insensitively", () => {
    assert.equal(findModel([model], "GPT-5.1-CODEX"), model);
    assert.equal(findModel([model], "gpt-5.1 codex"), model);
    assert.equal(findModel([model], "missing"), undefined);
  });

  it("returns the canonical supported reasoning effort", () => {
    assert.equal(reasoningEffortFor(model, "HIGH"), "high");
    assert.equal(reasoningEffortFor(model, "extreme"), undefined);
  });
});
