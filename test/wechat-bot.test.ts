import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WeChatBot } from "@wechatbot/wechatbot";
import { startWechatPolling } from "../src/wechat/bot.js";

class FakeBot {
  isRunning = false;
  private listeners = new Map<string, Set<() => void>>();
  private resolveRun!: () => void;
  private rejectRun!: (error: Error) => void;
  readonly runPromise = new Promise<void>((resolve, reject) => {
    this.resolveRun = resolve;
    this.rejectRun = reject;
  });

  on(event: string, listener: () => void): this {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: () => void): this {
    const wrapped = () => {
      this.off(event, wrapped);
      listener();
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  start(): Promise<void> {
    queueMicrotask(() => {
      this.isRunning = true;
      this.emit("poll:start");
    });
    return this.runPromise;
  }

  stop(): void {
    this.isRunning = false;
    this.emit("poll:stop");
    this.resolveRun();
  }

  failBeforeStart(error: Error): void {
    this.rejectRun(error);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

describe("WeChat polling lifecycle", () => {
  it("returns after the poll loop starts without waiting for it to stop", async () => {
    const bot = new FakeBot();
    const { runPromise } = await startWechatPolling(
      bot as unknown as WeChatBot,
    );

    assert.equal(bot.isRunning, true);
    assert.equal(bot.listenerCount("poll:start"), 0);
    assert.equal(bot.listenerCount("poll:stop"), 0);
    let stopped = false;
    void runPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);

    bot.stop();
    await runPromise;
    assert.equal(stopped, true);
  });

  it("rejects startup when the poll loop fails before announcing start", async () => {
    class FailingBot extends FakeBot {
      override start(): Promise<void> {
        queueMicrotask(() => this.failBeforeStart(new Error("offline")));
        return this.runPromise;
      }
    }
    const bot = new FailingBot();

    await assert.rejects(
      startWechatPolling(bot as unknown as WeChatBot),
      /offline/,
    );
    assert.equal(bot.listenerCount("poll:start"), 0);
    assert.equal(bot.listenerCount("poll:stop"), 0);
  });
});
