import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { CompletionStore, completionEventId, truncateSummary } from "./store.js";
import type { CompletionCallbackConfig, CompletionEvent } from "./types.js";

type SpawnCallback = (
  command: string,
  args: string[],
  options: { shell: false; stdio: "ignore" },
) => ReturnType<typeof spawn>;

type Logger = Pick<Console, "warn" | "error">;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  const message = objectValue(value);
  for (const key of ["text", "content", "message"]) {
    const candidate = message[key];
    if (typeof candidate === "string") return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((item) => {
          if (typeof item === "string") return item;
          const part = objectValue(item);
          return typeof part.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    }
  }
  return "";
}

export function parseCompletionNotifyEvent(
  rawJson: string,
  config: Pick<
    AppConfig,
    "completionNotifications"
  >,
): CompletionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const event = objectValue(parsed);
  if (event.type !== "agent-turn-complete") return null;
  const threadId = nonEmptyString(event["thread-id"] ?? event.threadId);
  const turnId = nonEmptyString(event["turn-id"] ?? event.turnId);
  const cwd = nonEmptyString(event.cwd);
  if (!threadId || !turnId || !cwd) return null;
  const inputMessages = event["input-messages"] ?? event.inputMessages;
  const lastInput = Array.isArray(inputMessages)
    ? messageText(inputMessages[inputMessages.length - 1])
    : messageText(inputMessages);
  const lastAssistant = messageText(
    event["last-assistant-message"] ?? event.lastAssistantMessage,
  );
  return {
    id: completionEventId(threadId, turnId),
    threadId,
    turnId,
    cwd,
    requestSummary: truncateSummary(
      lastInput,
      config.completionNotifications.requestSummaryChars,
    ),
    resultSummary: truncateSummary(
      lastAssistant,
      config.completionNotifications.resultSummaryChars,
    ),
    createdAt: new Date().toISOString(),
  };
}

async function runCallback(
  callback: CompletionCallbackConfig,
  rawJson: string,
  spawnCallback: SpawnCallback,
): Promise<void> {
  if (callback.argv.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawnCallback(
      callback.argv[0]!,
      [...callback.argv.slice(1), rawJson],
      { shell: false, stdio: "ignore" },
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`notify callback 超时 (${callback.timeoutMs}ms)`));
    }, callback.timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`notify callback 退出: code=${code} signal=${signal ?? ""}`));
    });
  });
}

export async function dispatchCompletionNotify(options: {
  rawJson: string;
  config: AppConfig;
  store?: CompletionStore;
  spawnCallback?: SpawnCallback;
  logger?: Logger;
}): Promise<void> {
  const { rawJson, config } = options;
  const logger = options.logger ?? console;
  const store =
    options.store ??
    new CompletionStore(config.completionNotifications.queuePath, {
      ackRetentionDays: config.completionNotifications.ackRetentionDays,
    });
  const spawnCallback = options.spawnCallback ?? spawn;

  const outboxTask = Promise.resolve().then(() => {
    const event = parseCompletionNotifyEvent(rawJson, config);
    if (!event || !config.completionNotifications.enabled) return;
    if (store.consumeSuppression(event.threadId, event.requestSummary)) return;
    store.enqueue(event);
  });

  const callbackTasks = config.completionNotifications.callbacks.map((callback) =>
    runCallback(callback, rawJson, spawnCallback).catch((error) => {
      logger.warn("[notify-dispatch] callback failed:", error);
    }),
  );

  await Promise.all([
    outboxTask.catch((error) => {
      logger.error("[notify-dispatch] outbox failed:", error);
    }),
    ...callbackTasks,
  ]);
}

export function trustedNotifyConfigPath(home = homedir()): string {
  const explicit = process.env.CODEX_WECHAT_CONFIG?.trim();
  return explicit || join(home, ".codex-wechat", "config.yaml");
}

export async function runNotifyDispatch(argv = process.argv): Promise<void> {
  const rawJson = argv[argv.length - 1];
  if (!rawJson) return;
  const config = loadConfig({ configPath: trustedNotifyConfigPath() });
  await dispatchCompletionNotify({ rawJson, config });
}
