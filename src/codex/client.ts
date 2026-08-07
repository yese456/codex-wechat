import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JsonRpcClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "../rpc/json-rpc.js";
import { StdioTransport } from "../rpc/stdio-transport.js";
import { resolveCodexCommand } from "./resolve.js";
import { clip, shortId } from "../text.js";
import type {
  CodexModelInfo,
  ModelConfigKey,
  ModelConfigSnapshot,
} from "../models.js";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../config.js";

export type CodexEvent =
  | { type: "approval"; approval: PendingApproval }
  | { type: "approvalResolved"; approval: PendingApproval; decision: string }
  | { type: "delta"; threadId: string; itemId: string; text: string }
  | { type: "message"; threadId: string; text: string }
  | { type: "turnStarted"; threadId: string }
  | {
      type: "turnCompleted";
      threadId: string;
      status?: string;
      error?: string | null;
    }
  | {
      type: "error";
      message: string;
      threadId?: string;
      willRetry?: boolean;
    }
  | { type: "connectionLost" }
  | { type: "reconnected" }
  | { type: "connectionGaveUp" };

const SLOW_RECONNECT_MS = 60_000;

export type PendingApproval = {
  id: string;
  rpcId: string | number;
  shortCode: string;
  method: string;
  params: Record<string, unknown>;
  threadId: string | null;
  summary: string;
  createdAt: number;
};

export type ThreadSummary = {
  id: string;
  preview: string;
  cwd: string;
  name: string | null;
  updatedAt: number;
  createdAt: number;
};

function packageVersion(): string {
  if (process.env.npm_package_version?.trim()) {
    return process.env.npm_package_version.trim();
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // src/codex → ../.. ; dist/src/codex → ../../..
  for (const rel of ["../../package.json", "../../../package.json", "package.json"]) {
    try {
      const pkgPath = join(here, rel);
      if (existsSync(pkgPath)) {
        return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
      }
    } catch {
      // try next
    }
  }
  return "0.1.0";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeModelConfig(response: unknown): ModelConfigSnapshot {
  const outer = record(response);
  const config = record(outer.config ?? response);
  return {
    model: optionalText(config.model),
    reasoningEffort: optionalText(
      config.model_reasoning_effort,
      config.modelReasoningEffort,
    ),
    provider: optionalText(config.model_provider, config.modelProvider),
    serviceTier: optionalText(config.service_tier, config.serviceTier),
  };
}

function normalizeModelInfo(value: unknown): CodexModelInfo | null {
  const raw = record(value);
  const id = optionalText(raw.id, raw.model, raw.slug);
  if (!id) return null;
  const effortsRaw =
    raw.supportedReasoningEfforts ?? raw.supported_reasoning_efforts;
  const efforts = Array.isArray(effortsRaw)
    ? effortsRaw
        .map((entry) => {
          if (typeof entry === "string") return entry.trim();
          const item = record(entry);
          return optionalText(
            item.reasoningEffort,
            item.reasoning_effort,
            item.effort,
          );
        })
        .filter((effort): effort is string => Boolean(effort))
    : [];
  return {
    id,
    displayName: optionalText(raw.displayName, raw.display_name, raw.name) ?? id,
    description: optionalText(raw.description) ?? "",
    supportedReasoningEfforts: [...new Set(efforts)],
    defaultReasoningEffort: optionalText(
      raw.defaultReasoningEffort,
      raw.default_reasoning_effort,
    ),
    isDefault: raw.isDefault === true || raw.is_default === true,
  };
}

export function approvalResultFor(
  method: string,
  decision: "accept" | "decline",
  params: Record<string, unknown> = {},
): unknown {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions:
        decision === "accept" &&
        params.permissions &&
        typeof params.permissions === "object"
          ? params.permissions
          : {},
      scope: "turn",
    };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: decision === "accept" ? "approved" : "denied" };
  }
  // v2 item/* requestApproval APIs
  return { decision: decision === "accept" ? "accept" : "decline" };
}

function summarizeApproval(
  method: string,
  params: Record<string, unknown>,
): string {
  if (method === "item/permissions/requestApproval") {
    const cwd = optionalText(params.cwd) ?? "";
    const reason = optionalText(params.reason) ?? "";
    const permissions = params.permissions
      ? clip(JSON.stringify(params.permissions), 700)
      : "(未提供详情)";
    return [
      "【权限提升审批】",
      cwd ? `cwd: ${cwd}` : "",
      reason ? `原因: ${reason}` : "",
      `请求权限: ${permissions}`,
      "批准范围: 当前 turn",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (
    method.includes("commandExecution") ||
    method === "execCommandApproval"
  ) {
    const command =
      typeof params.command === "string"
        ? params.command
        : Array.isArray(params.command)
          ? (params.command as string[]).join(" ")
          : "";
    const cwd = String(params.cwd ?? "");
    const reason = params.reason ? String(params.reason) : "";
    return [
      "【命令审批】",
      command ? `$ ${clip(command, 500)}` : method,
      cwd ? `cwd: ${cwd}` : "",
      reason ? `原因: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (method.includes("fileChange") || method === "applyPatchApproval") {
    const reason = params.reason ? String(params.reason) : "";
    const grant = params.grantRoot ? String(params.grantRoot) : "";
    const changes = params.fileChanges ?? params.changes;
    let files = "";
    if (changes && typeof changes === "object") {
      files = Object.keys(changes as object).slice(0, 8).join("\n");
    }
    return [
      "【写文件审批】",
      reason ? `原因: ${reason}` : "",
      grant ? `grantRoot: ${grant}` : "",
      files ? `文件:\n${files}` : method,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `【审批】${method}\n${clip(JSON.stringify(params), 400)}`;
}

export class CodexClient {
  private client: JsonRpcClient;
  private state: "not_connected" | "connected" | "reconnecting" =
    "not_connected";
  private lastError: string | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private shortCodeToKey = new Map<string, string>();
  private approvalCounter = 0;
  private agentMessageTextByItem = new Map<string, string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private slowReconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private initializePromise: Promise<unknown> | null = null;
  private maxReconnectAttempts = 8;
  private readonly command: string;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly approvalPolicy: CodexApprovalPolicy;
  onEvent: ((ev: CodexEvent) => void) | null = null;

  constructor(
    opts: {
      command?: string | null;
      sandboxMode?: CodexSandboxMode;
      approvalPolicy?: CodexApprovalPolicy;
    } = {},
  ) {
    this.command = resolveCodexCommand({ override: opts.command });
    this.sandboxMode = opts.sandboxMode ?? "read-only";
    this.approvalPolicy = opts.approvalPolicy ?? "on-request";
    this.client = this.createClient();
  }

  getCommand(): string {
    return this.command;
  }

  getStatus(): {
    state: string;
    command: string;
    lastError: string | null;
    pendingApprovals: number;
  } {
    return {
      state: this.state,
      command: this.command,
      lastError: this.lastError,
      pendingApprovals: this.pendingApprovals.size,
    };
  }

  private createClient(): JsonRpcClient {
    const transport = new StdioTransport(this.command);
    const client = new JsonRpcClient(transport);
    client.onServerRequest((req) => this.handleServerRequest(req));
    client.onNotification((n) => this.handleNotification(n));
    client.onClose(() => this.handleDisconnect());
    return client;
  }

  private emit(ev: CodexEvent): void {
    try {
      this.onEvent?.(ev);
    } catch (err) {
      console.error("onEvent handler error:", err);
    }
  }

  private handleDisconnect(): void {
    if (this.state === "reconnecting") return;
    this.state = "reconnecting";
    this.stopHeartbeat();
    const stderr = this.client.getStderrTail()?.trim().slice(-500);
    if (stderr) {
      this.lastError = this.lastError
        ? `${this.lastError}\nstderr: ${stderr}`
        : `连接断开\nstderr: ${stderr}`;
    }
    this.agentMessageTextByItem.clear();
    for (const approval of this.pendingApprovals.values()) {
      this.emit({
        type: "approvalResolved",
        approval,
        decision: "connection_lost",
      });
    }
    this.pendingApprovals.clear();
    this.shortCodeToKey.clear();
    this.emit({ type: "connectionLost" });
    this.scheduleReconnect(1);
  }

  private scheduleReconnect(attempt: number): void {
    if (this.reconnectTimer || this.slowReconnectTimer) return;
    if (attempt > this.maxReconnectAttempts) {
      this.state = "not_connected";
      this.emit({ type: "connectionGaveUp" });
      // Keep trying slowly so the daemon recovers without a full restart.
      this.scheduleSlowReconnect();
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.client.close().catch(() => {});
        this.client = this.createClient();
        await this.initialize();
        this.emit({ type: "reconnected" });
      } catch {
        this.scheduleReconnect(attempt + 1);
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private scheduleSlowReconnect(): void {
    if (this.slowReconnectTimer || this.reconnectTimer) return;
    this.slowReconnectTimer = setTimeout(async () => {
      this.slowReconnectTimer = null;
      if (this.state === "connected") return;
      try {
        await this.client.close().catch(() => {});
        this.client = this.createClient();
        await this.initialize();
        this.emit({ type: "reconnected" });
      } catch {
        this.scheduleSlowReconnect();
      }
    }, SLOW_RECONNECT_MS);
    this.slowReconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "connected") return;
      this.client
        .request("thread/list", {
          cwd: null,
          archived: false,
          limit: 1,
          useStateDbOnly: false,
        })
        .catch(() => this.handleDisconnect());
    }, 45_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async initialize(): Promise<unknown> {
    if (this.state === "connected") return { alreadyConnected: true };
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.requestInitialize().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  async requestInitialize(): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.client.request("initialize", {
        clientInfo: {
          name: "codex-wechat",
          title: "Codex WeChat",
          version: packageVersion(),
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
    } catch (error) {
      if (/already initialized/i.test((error as Error)?.message ?? "")) {
        this.state = "connected";
        this.lastError = null;
        this.startHeartbeat();
        return { alreadyInitialized: true };
      }
      const base = (error as Error)?.message ?? String(error);
      const stderr = this.client.getStderrTail()?.trim().slice(-500);
      this.lastError = stderr ? `${base}\nstderr: ${stderr}` : base;
      throw error;
    }
    this.state = "connected";
    this.lastError = null;
    this.startHeartbeat();
    return result;
  }

  async ensureConnected(): Promise<void> {
    if (this.state === "connected") return;
    await this.initialize();
  }

  /**
   * Fetch account + rate-limit snapshot for /usage.
   * Best-effort: individual RPCs may fail on older Codex builds.
   */
  async getUsageSummary(): Promise<string> {
    await this.ensureConnected();
    const lines: string[] = [];

    try {
      const account = (await this.client.request("account/read", {})) as {
        account?: { type?: string; email?: string; planType?: string };
      };
      const a = account.account;
      if (a) {
        lines.push(`账号: ${a.email ?? a.type ?? "unknown"}`);
        if (a.planType) lines.push(`套餐: ${a.planType}`);
      }
    } catch (err) {
      lines.push(`账号: (读取失败: ${(err as Error).message})`);
    }

    try {
      const rl = (await this.client.request(
        "account/rateLimits/read",
        undefined,
      )) as {
        rateLimits?: {
          planType?: string;
          primary?: {
            usedPercent?: number;
            windowDurationMins?: number;
            resetsAt?: number;
          };
          credits?: {
            hasCredits?: boolean;
            unlimited?: boolean;
            balance?: string;
          };
          rateLimitReachedType?: string | null;
        };
        rateLimitResetCredits?: {
          availableCount?: number;
          credits?: Array<{
            title?: string;
            status?: string;
            expiresAt?: number;
          }>;
        };
      };
      const lim = rl.rateLimits;
      if (lim?.planType && !lines.some((l) => l.startsWith("套餐:"))) {
        lines.push(`套餐: ${lim.planType}`);
      }
      const primary = lim?.primary;
      if (primary) {
        const pct =
          primary.usedPercent != null ? `${primary.usedPercent}%` : "?";
        lines.push(`主限额已用: ${pct}`);
        if (primary.windowDurationMins != null) {
          const days = (primary.windowDurationMins / 60 / 24).toFixed(1);
          lines.push(`限额窗口: ${primary.windowDurationMins} 分钟（约 ${days} 天）`);
        }
        if (primary.resetsAt != null) {
          lines.push(`重置时间: ${formatUnix(primary.resetsAt)}`);
        }
      }
      const credits = lim?.credits;
      if (credits) {
        if (credits.unlimited) {
          lines.push("Credits: 无限");
        } else {
          lines.push(
            `Credits: ${credits.balance ?? "0"}${credits.hasCredits ? "" : "（无）"}`,
          );
        }
      }
      if (lim?.rateLimitReachedType) {
        lines.push(`限额状态: ${lim.rateLimitReachedType}`);
      }
      const resets = rl.rateLimitResetCredits;
      if (resets?.availableCount && resets.availableCount > 0) {
        const first = resets.credits?.find((c) => c.status === "available");
        lines.push(
          `免费重置券: ${resets.availableCount} 张` +
            (first?.title ? `（${first.title}` : "") +
            (first?.expiresAt
              ? `，过期 ${formatUnix(first.expiresAt)}）`
              : first?.title
                ? "）"
                : ""),
        );
      }
    } catch (err) {
      lines.push(`限额: (读取失败: ${(err as Error).message})`);
    }

    try {
      const usage = (await this.client.request(
        "account/usage/read",
        undefined,
      )) as {
        summary?: {
          lifetimeTokens?: number;
          peakDailyTokens?: number;
          currentStreakDays?: number;
          longestStreakDays?: number;
        };
        dailyUsageBuckets?: Array<{ startDate?: string; tokens?: number }>;
      };
      const s = usage.summary;
      if (s) {
        if (s.lifetimeTokens != null) {
          lines.push(`累计 tokens: ${formatTokens(s.lifetimeTokens)}`);
        }
        if (s.peakDailyTokens != null) {
          lines.push(`单日峰值: ${formatTokens(s.peakDailyTokens)}`);
        }
        if (s.longestStreakDays != null) {
          lines.push(`最长连续: ${s.longestStreakDays} 天`);
        }
      }
      const buckets = usage.dailyUsageBuckets ?? [];
      if (buckets.length > 0) {
        const last = buckets[buckets.length - 1]!;
        lines.push(
          `最近一日: ${last.startDate ?? "?"} → ${formatTokens(last.tokens ?? 0)}`,
        );
      }
    } catch {
      // optional
    }

    if (lines.length === 0) {
      return "无法读取用量信息（当前 Codex 版本可能不支持）";
    }
    return ["📊 Codex 用量", ...lines].join("\n");
  }

  async getModelConfig(): Promise<ModelConfigSnapshot> {
    await this.ensureConnected();
    const response = await this.client.request("config/read", {});
    return normalizeModelConfig(response);
  }

  async setModelConfig(
    keyPath: ModelConfigKey,
    value: string,
  ): Promise<ModelConfigSnapshot> {
    await this.ensureConnected();
    const normalized = value.trim();
    if (!normalized) throw new Error(`${keyPath} 不能为空`);
    await this.client.request("config/value/write", {
      keyPath,
      value: normalized,
      mergeStrategy: "replace",
    });
    return this.getModelConfig();
  }

  async listModels(): Promise<CodexModelInfo[]> {
    await this.ensureConnected();
    const response = record(await this.client.request("model/list", {}));
    const data = response.data ?? response.models;
    if (!Array.isArray(data)) {
      throw new Error("Codex model/list 返回格式异常");
    }
    return data
      .map((model) => normalizeModelInfo(model))
      .filter((model): model is CodexModelInfo => model !== null);
  }

  async listThreads(opts: {
    cwd?: string | null;
    limit?: number;
  } = {}): Promise<ThreadSummary[]> {
    await this.ensureConnected();
    const response = (await this.client.request("thread/list", {
      cwd: opts.cwd ?? null,
      archived: false,
      limit: opts.limit ?? 15,
      useStateDbOnly: false,
    })) as { data?: unknown[] };
    const data = response.data ?? [];
    return data.map((t) => normalizeThread(t));
  }

  async startThread(cwd: string): Promise<ThreadSummary> {
    await this.ensureConnected();
    const response = (await this.client.request("thread/start", {
      cwd,
      sandbox: this.sandboxMode,
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: "user",
    })) as { thread?: unknown };
    return normalizeThread(response.thread ?? response);
  }

  async resumeThread(threadId: string, cwd?: string | null): Promise<unknown> {
    await this.ensureConnected();
    const params: Record<string, unknown> = { threadId };
    if (cwd) params.cwd = cwd;
    params.sandbox = this.sandboxMode;
    params.approvalPolicy = this.approvalPolicy;
    params.approvalsReviewer = "user";
    return this.client.request("thread/resume", params);
  }

  async startTurn(opts: {
    threadId: string;
    text: string;
    cwd?: string | null;
    /** Absolute paths for localImage inputs */
    imagePaths?: string[];
  }): Promise<unknown> {
    await this.ensureConnected();
    const input: Array<Record<string, unknown>> = [];
    if (opts.text?.trim()) {
      input.push({ type: "text", text: opts.text, text_elements: [] });
    }
    for (const path of opts.imagePaths ?? []) {
      if (path) {
        input.push({ type: "localImage", path });
      }
    }
    if (input.length === 0) {
      input.push({
        type: "text",
        text: "（空消息）",
        text_elements: [],
      });
    }
    return this.client.request("turn/start", {
      threadId: opts.threadId,
      input,
      cwd: opts.cwd ?? null,
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: "user",
    });
  }

  /**
   * Wait until turn/completed for the given thread, accumulating agent text.
   * Must be started *before* startTurn (or race-safe immediately after).
   */
  waitForTurn(threadId: string, timeoutMs = 15 * 60 * 1000): Promise<string> {
    return this.createTurnWaiter(threadId, timeoutMs).promise;
  }

  private createTurnWaiter(
    threadId: string,
    timeoutMs = 15 * 60 * 1000,
  ): { promise: Promise<string>; cancel: (error: Error) => void } {
    let cancel = (_error: Error) => {};
    const promise = new Promise<string>((resolve, reject) => {
      let lastAgentText = "";
      let lastError = "";
      let settled = false;
      const prev = this.onEvent;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onEvent = prev;
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error("等待 Codex 回复超时")));
      }, timeoutMs);
      timer.unref?.();
      cancel = (error: Error) => finish(() => reject(error));

      this.onEvent = (ev) => {
        prev?.(ev);
        if (ev.type === "delta" && ev.threadId === threadId) {
          lastAgentText = ev.text;
        }
        if (ev.type === "message" && ev.threadId === threadId) {
          lastAgentText = ev.text;
        }
        if (
          ev.type === "error" &&
          (!ev.threadId || ev.threadId === threadId) &&
          ev.message
        ) {
          if (!ev.willRetry) {
            lastError = ev.message;
          }
        }
        if (ev.type === "turnCompleted" && ev.threadId === threadId) {
          const err = ev.error || lastError;
          if (lastAgentText.trim()) {
            finish(() => resolve(lastAgentText.trim()));
            return;
          }
          if (err) {
            finish(() =>
              resolve(
                `❌ Codex 失败${ev.status ? `（${ev.status}）` : ""}:\n${err}`,
              ),
            );
            return;
          }
          finish(() =>
            resolve(
              ev.status === "failed"
                ? "❌ Codex 执行失败（无详细错误信息）"
                : "(无文本回复)",
            ),
          );
        }
        if (ev.type === "connectionLost") {
          finish(() => reject(new Error("Codex 连接中断")));
        }
      };
    });
    return { promise, cancel };
  }

  async runPrompt(opts: {
    threadId: string;
    text: string;
    cwd?: string | null;
    imagePaths?: string[];
    timeoutMs?: number;
  }): Promise<string> {
    const waiter = this.createTurnWaiter(opts.threadId, opts.timeoutMs);
    try {
      await this.startTurn({
        threadId: opts.threadId,
        text: opts.text,
        cwd: opts.cwd,
        imagePaths: opts.imagePaths,
      });
    } catch (err) {
      waiter.cancel(err as Error);
      await waiter.promise.catch(() => {});
      throw err;
    }
    return waiter.promise;
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()];
  }

  getApproval(code: string): PendingApproval | undefined {
    const key = this.shortCodeToKey.get(code) ?? code;
    return this.pendingApprovals.get(key);
  }

  async resolveApproval(
    code: string,
    decision: "accept" | "decline",
  ): Promise<void> {
    const key = this.shortCodeToKey.get(code) ?? code;
    const approval = this.pendingApprovals.get(key);
    if (!approval) {
      throw new Error(`未知审批码: ${code}`);
    }
    const result = approvalResultFor(
      approval.method,
      decision,
      approval.params,
    );
    await this.client.respond(approval.rpcId, result);
    this.pendingApprovals.delete(key);
    this.shortCodeToKey.delete(approval.shortCode);
    this.emit({ type: "approvalResolved", approval, decision });
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const method = request.method ?? "";
    const isApproval =
      method.includes("requestApproval") ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval";
    if (!isApproval) {
      // Never leave the server hanging on interactive requests we don't handle.
      console.warn(`未处理的 server request（将拒绝）: ${method}`);
      if (
        method.includes("requestUserInput") ||
        method.includes("elicitation") ||
        method.includes("permissions/request")
      ) {
        void this.client
          .respond(request.id, { decision: "decline" })
          .catch(() =>
            this.client.respondError(
              request.id,
              -32000,
              `rejected by codex-wechat: ${method}`,
            ),
          );
      } else {
        void this.client.respondError(
          request.id,
          -32601,
          `Method not supported by codex-wechat: ${method}`,
        );
      }
      return;
    }
    const key = String(request.id);
    const shortCode =
      this.pendingApprovals.get(key)?.shortCode ?? `a${++this.approvalCounter}`;
    const params = (request.params ?? {}) as Record<string, unknown>;
    const approval: PendingApproval = {
      id: key,
      rpcId: request.id,
      shortCode,
      method,
      params,
      threadId: (params.threadId as string) ?? null,
      summary: summarizeApproval(method, params),
      createdAt: Date.now(),
    };
    this.pendingApprovals.set(key, approval);
    this.shortCodeToKey.set(shortCode, key);
    this.emit({ type: "approval", approval });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const method = notification.method;
    const params = (notification.params ?? {}) as Record<string, unknown>;

    if (method === "item/agentMessage/delta") {
      const threadId = String(params.threadId ?? "");
      const itemId = String(params.itemId ?? "");
      const delta = String(params.delta ?? "");
      const key = `${threadId}:${itemId}`;
      const prev = this.agentMessageTextByItem.get(key) ?? "";
      // Codex 0.136+ deltas are chunks; some versions send cumulative text.
      // If delta starts with prev, treat as cumulative; else append.
      const next =
        delta.startsWith(prev) && delta.length >= prev.length
          ? delta
          : prev + delta;
      this.agentMessageTextByItem.set(key, next);
      this.emit({ type: "delta", threadId, itemId, text: next });
      return;
    }

    if (method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      const itemType = String(item?.type ?? "");
      if (itemType === "agentMessage" || itemType === "agent_message") {
        const threadId = String(params.threadId ?? item?.threadId ?? "");
        const itemId = String(item?.id ?? params.itemId ?? "");
        const text =
          (typeof item?.text === "string" ? item.text : "") ||
          this.agentMessageTextByItem.get(`${threadId}:${itemId}`) ||
          extractTextFromItem(item ?? {});
        if (text) {
          this.emit({ type: "message", threadId, text });
        }
        this.agentMessageTextByItem.delete(`${threadId}:${itemId}`);
      }
      return;
    }

    if (method === "item/updated") {
      const item = params.item as Record<string, unknown> | undefined;
      const itemType = String(item?.type ?? "");
      if (
        (itemType === "agentMessage" || itemType === "agent_message") &&
        (item?.text || item?.content)
      ) {
        const threadId = String(params.threadId ?? "");
        const text =
          (typeof item?.text === "string" ? item.text : "") ||
          extractTextFromItem(item ?? {});
        if (text) {
          this.emit({ type: "message", threadId, text });
        }
      }
      return;
    }

    // Some Codex builds stream as agentMessage/delta without the item/ prefix
    if (
      method === "agentMessage/delta" ||
      method === "item/agent_message/delta"
    ) {
      const threadId = String(params.threadId ?? "");
      const itemId = String(params.itemId ?? params.id ?? "");
      const delta = String(params.delta ?? params.text ?? "");
      const key = `${threadId}:${itemId}`;
      const prev = this.agentMessageTextByItem.get(key) ?? "";
      const next =
        delta.startsWith(prev) && delta.length >= prev.length
          ? delta
          : prev + delta;
      this.agentMessageTextByItem.set(key, next);
      this.emit({ type: "delta", threadId, itemId, text: next });
      return;
    }

    if (method === "turn/started") {
      this.emit({
        type: "turnStarted",
        threadId: String(params.threadId ?? ""),
      });
      return;
    }

    if (method === "turn/completed") {
      const threadId = String(params.threadId ?? "");
      // flush any remaining deltas as message
      for (const [key, text] of this.agentMessageTextByItem) {
        if (key.startsWith(`${threadId}:`)) {
          this.emit({ type: "message", threadId, text });
          this.agentMessageTextByItem.delete(key);
        }
      }
      const turn = params.turn as Record<string, unknown> | undefined;
      const turnErr = turn?.error as
        | { message?: string }
        | string
        | null
        | undefined;
      let errorMsg: string | null = null;
      if (typeof turnErr === "string") errorMsg = turnErr;
      else if (turnErr && typeof turnErr === "object" && turnErr.message) {
        errorMsg = String(turnErr.message);
      }
      this.emit({
        type: "turnCompleted",
        threadId,
        status: turn?.status ? String(turn.status) : undefined,
        error: errorMsg,
      });
      return;
    }

    if (method === "error") {
      const raw = params.error ?? params.message;
      let message = "unknown error";
      if (typeof raw === "string") message = raw;
      else if (raw && typeof raw === "object" && "message" in raw) {
        message = String((raw as { message?: string }).message ?? message);
      }
      this.emit({
        type: "error",
        message,
        threadId: params.threadId ? String(params.threadId) : undefined,
        willRetry: Boolean(params.willRetry),
      });
    }
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.slowReconnectTimer) {
      clearTimeout(this.slowReconnectTimer);
      this.slowReconnectTimer = null;
    }
    await this.client.close().catch(() => {});
    this.state = "not_connected";
  }
}

function normalizeThread(raw: unknown): ThreadSummary {
  const t = (raw ?? {}) as Record<string, unknown>;
  const cwd =
    (t.cwd as string) ||
    (t.workingDirectory as string) ||
    (t.projectPath as string) ||
    "";
  return {
    id: String(t.id ?? ""),
    preview: String(t.preview ?? t.name ?? ""),
    cwd,
    name: (t.name as string) ?? null,
    updatedAt: Number(t.updatedAt ?? t.recencyAt ?? 0),
    createdAt: Number(t.createdAt ?? 0),
  };
}

function extractTextFromItem(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function formatThreadList(threads: ThreadSummary[]): string {
  if (threads.length === 0) return "（无会话）";
  return threads
    .map((t, i) => {
      const title = clip(t.name || t.preview || "(无预览)", 40);
      return `${i + 1}. ${shortId(t.id)}  ${title}\n   ${t.cwd || "-"}`;
    })
    .join("\n");
}

function formatUnix(sec: number): string {
  try {
    // Codex returns unix seconds
    const ms = sec > 1e12 ? sec : sec * 1000;
    return new Date(ms).toLocaleString();
  } catch {
    return String(sec);
  }
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
