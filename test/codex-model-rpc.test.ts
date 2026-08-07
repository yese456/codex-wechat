import { it } from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../src/codex/client.js";

it("uses the real Codex model RPC shapes including mergeStrategy", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const codex = new CodexClient({ command: "codex" });
  codex.ensureConnected = async () => {};
  (codex as unknown as {
    client: { request: (method: string, params: unknown) => Promise<unknown> };
  }).client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "config/read") {
        return {
          config: {
            model: "gpt-test",
            model_reasoning_effort: "high",
            model_provider: "openai",
            service_tier: "fast",
          },
        };
      }
      if (method === "model/list") {
        return {
          data: [
            {
              id: "gpt-test",
              displayName: "GPT Test",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "low",
              isDefault: true,
            },
          ],
        };
      }
      return {};
    },
  };

  assert.deepEqual(await codex.getModelConfig(), {
    model: "gpt-test",
    reasoningEffort: "high",
    provider: "openai",
    serviceTier: "fast",
  });
  assert.deepEqual((await codex.listModels())[0]?.supportedReasoningEfforts, [
    "low",
    "high",
  ]);
  await codex.setModelConfig("model", "gpt-test");

  assert.deepEqual(requests.at(-2), {
    method: "config/value/write",
    params: {
      keyPath: "model",
      value: "gpt-test",
      mergeStrategy: "replace",
    },
  });
  assert.equal(requests.at(-1)?.method, "config/read");
});
