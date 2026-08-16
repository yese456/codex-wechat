import { it } from "node:test";
import assert from "node:assert/strict";
import { MessageHandler } from "../src/handler.js";
import type { AppConfig } from "../src/config.js";
import type { StateStore } from "../src/state.js";
import type { HostRegistry } from "../src/hosts/registry.js";
import type { CodexHost } from "../src/hosts/types.js";
import type { ReplyChannel } from "../src/media/types.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function replyChannel(messages: string[]): ReplyChannel {
  return {
    text: async (text) => {
      messages.push(text);
    },
    image: async () => {},
    file: async () => {},
  };
}

it("queues busy-host prompts and drains them in FIFO order", async () => {
  const gates = new Map([
    ["first", deferred()],
    ["second", deferred()],
    ["third", deferred()],
  ]);
  const calls: string[] = [];
  const host = {
    id: "local",
    label: "Local",
    kind: "local",
    async runPrompt(text: string) {
      calls.push(text);
      await gates.get(text)!.promise;
      return `answer:${text}`;
    },
  } as unknown as CodexHost;
  const state = {
    load: () => ({ allowUserId: "user-1" }),
  } as unknown as StateStore;
  const hosts = {
    current: () => host,
  } as unknown as HostRegistry;
  const handler = new MessageHandler(
    { bindMaxFails: 5, maxReplyChars: 3_500 } as AppConfig,
    state,
    hosts,
  );
  const firstReplies: string[] = [];
  const secondReplies: string[] = [];
  const thirdReplies: string[] = [];

  const first = handler.handle(
    "user-1",
    { text: "first" },
    replyChannel(firstReplies),
  );
  await waitFor(() => calls.length === 1);
  await handler.handle(
    "user-1",
    { text: "second" },
    replyChannel(secondReplies),
  );
  await handler.handle(
    "user-1",
    { text: "third" },
    replyChannel(thirdReplies),
  );

  assert.deepEqual(calls, ["first"]);
  assert.match(secondReplies[0]!, /已加入队列.*等待第 1 项/);
  assert.match(thirdReplies[0]!, /已加入队列.*等待第 2 项/);

  gates.get("first")!.resolve();
  await first;
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["first", "second"]);
  assert.match(secondReplies[1]!, /开始处理排队任务.*后面还有 1 项/);

  gates.get("second")!.resolve();
  await waitFor(() => calls.length === 3);
  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.match(thirdReplies[1]!, /开始处理排队任务.*后面还有 0 项/);

  gates.get("third")!.resolve();
  await waitFor(() => thirdReplies.includes("answer:third"));
  assert.ok(firstReplies.includes("answer:first"));
  assert.ok(secondReplies.includes("answer:second"));
});

it("continues draining after a queued task fails", async () => {
  const gate = deferred();
  const calls: string[] = [];
  const host = {
    id: "local",
    label: "Local",
    kind: "local",
    async runPrompt(text: string) {
      calls.push(text);
      if (text === "first") await gate.promise;
      if (text === "second") throw new Error("second failed");
      return `answer:${text}`;
    },
  } as unknown as CodexHost;
  const handler = new MessageHandler(
    { bindMaxFails: 5, maxReplyChars: 3_500 } as AppConfig,
    { load: () => ({ allowUserId: "user-1" }) } as unknown as StateStore,
    { current: () => host } as unknown as HostRegistry,
  );
  const replies: string[] = [];
  const reply = replyChannel(replies);

  const first = handler.handle("user-1", { text: "first" }, reply);
  await waitFor(() => calls.length === 1);
  await handler.handle("user-1", { text: "second" }, reply);
  await handler.handle("user-1", { text: "third" }, reply);
  gate.resolve();
  await first;

  await waitFor(() => replies.includes("answer:third"));
  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.ok(replies.includes("❌ second failed"));
});
