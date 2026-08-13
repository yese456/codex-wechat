import { basename } from "node:path";
import type { AppConfig } from "../config.js";
import type { CodexHost } from "../hosts/types.js";
import type { CompletionEvent } from "./types.js";
import { CompletionDeliveryStore } from "./delivery-store.js";

export type CompletionWorkerHost = Pick<
  CodexHost,
  | "id"
  | "label"
  | "completionNotificationsEnabled"
  | "pollCompletions"
  | "ackCompletions"
>;

type Logger = Pick<Console, "warn" | "error">;

export function formatCompletionNotification(
  host: Pick<CompletionWorkerHost, "id" | "label">,
  event: CompletionEvent,
): string {
  const project = basename(event.cwd) || event.cwd;
  const turn = event.turnId.slice(0, 12);
  const request = event.requestSummary || "(无请求摘要)";
  const result = event.resultSummary || "(无结果摘要)";
  return [
    `Codex 已完成 (host=${host.id}${host.label !== host.id ? ` ${host.label}` : ""})`,
    `项目: ${project}`,
    `请求: ${request}`,
    `结果: ${result}`,
    `turn: ${turn}`,
  ].join("\n");
}

export async function runCompletionCycle(options: {
  host: CompletionWorkerHost;
  batchSize: number;
  deliveryStore: CompletionDeliveryStore;
  userId: string | null;
  sendToUser: (userId: string, text: string) => Promise<void>;
}): Promise<void> {
  const { host } = options;
  if (
    !host.completionNotificationsEnabled ||
    !host.pollCompletions ||
    !host.ackCompletions
  ) {
    return;
  }

  const events = await host.pollCompletions(options.batchSize);
  for (const event of events) {
    if (options.deliveryStore.isSent(host.id, event.id)) {
      await host.ackCompletions([event.id]);
      continue;
    }
    if (!options.userId) continue;
    await options.sendToUser(
      options.userId,
      formatCompletionNotification(host, event),
    );
    options.deliveryStore.markSent(host.id, event.id);
    await host.ackCompletions([event.id]);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type CompletionWorker = {
  stop(): Promise<void>;
};

export function startCompletionWorker(options: {
  config: Pick<AppConfig, "completionNotifications">;
  hosts: CompletionWorkerHost[];
  getUserId: () => string | null;
  sendToUser: (userId: string, text: string) => Promise<void>;
  logger?: Logger;
  deliveryStore?: CompletionDeliveryStore;
}): CompletionWorker {
  const logger = options.logger ?? console;
  const config = options.config.completionNotifications;
  const deliveryStore =
    options.deliveryStore ??
    new CompletionDeliveryStore(config.deliveryPath, {
      ackRetentionDays: config.ackRetentionDays,
    });
  const controller = new AbortController();
  const loops = options.hosts
    .filter(
      (host) =>
        host.completionNotificationsEnabled &&
        host.pollCompletions &&
        host.ackCompletions,
    )
    .map(async (host) => {
      let delayMs = config.pollIntervalMs;
      while (!controller.signal.aborted) {
        try {
          await runCompletionCycle({
            host,
            batchSize: config.batchSize,
            deliveryStore,
            userId: options.getUserId(),
            sendToUser: options.sendToUser,
          });
          delayMs = config.pollIntervalMs;
        } catch (error) {
          logger.warn(`[completion] host=${host.id} cycle failed:`, error);
          delayMs = Math.min(
            Math.max(config.pollIntervalMs, delayMs * 2),
            300_000,
          );
        }
        await wait(delayMs, controller.signal);
      }
    });

  return {
    async stop(): Promise<void> {
      controller.abort();
      await Promise.allSettled(loops);
    },
  };
}
