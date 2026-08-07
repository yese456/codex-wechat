import { it } from "node:test";
import assert from "node:assert/strict";
import { MessageHandler } from "../src/handler.js";
import type { AppConfig } from "../src/config.js";
import type { StateStore } from "../src/state.js";
import type { HostRegistry } from "../src/hosts/registry.js";
import type { CodexHost } from "../src/hosts/types.js";
import type { ModelConfigSnapshot } from "../src/models.js";

it("handles model query, switch, think and list commands on current host", async () => {
  let config: ModelConfigSnapshot = {
    model: "gpt-a",
    reasoningEffort: "high",
    provider: "openai",
    serviceTier: "fast",
  };
  const calls: string[] = [];
  const host = {
    id: "mac",
    label: "Mac",
    kind: "http",
    async getModelConfig() {
      calls.push("read");
      return config;
    },
    async listModels() {
      calls.push("list");
      return [
        {
          id: "gpt-a",
          displayName: "GPT A",
          description: "",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
          isDefault: false,
        },
        {
          id: "gpt-b",
          displayName: "GPT B",
          description: "",
          supportedReasoningEfforts: ["medium", "max"],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ];
    },
    async setModel(id: string) {
      calls.push(`model:${id}`);
      config = { ...config, model: id, reasoningEffort: "medium" };
      return config;
    },
    async setReasoningEffort(effort: string) {
      calls.push(`think:${effort}`);
      config = { ...config, reasoningEffort: effort };
      return config;
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

  await handler.handle("user-1", { text: "/model" }, reply);
  await handler.handle("user-1", { text: "/model gpt-b" }, reply);
  await handler.handle("user-1", { text: "/think max" }, reply);
  await handler.handle("user-1", { text: "/models" }, reply);

  assert.deepEqual(calls, [
    "read",
    "model:gpt-b",
    "think:max",
    "read",
    "list",
  ]);
  assert.match(replies[0]!, /model: gpt-a/);
  assert.match(replies[1]!, /全局模型/);
  assert.match(replies[2]!, /think: max/);
  assert.match(replies[3]!, /→ gpt-b/);
});
