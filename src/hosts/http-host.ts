import { readFileSync, statSync } from "node:fs";
import {
  isUnsafeToken,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "../config.js";
import type { Attachment } from "../media/types.js";
import type { CompletionEvent } from "../completions/types.js";
import type {
  CodexHost,
  PendingApprovalView,
  ProjectInfo,
  SecurityPolicySnapshot,
} from "./types.js";
import type { CodexModelInfo, ModelConfigSnapshot } from "../models.js";

export type HttpHostConfig = {
  id: string;
  label: string;
  url: string;
  token: string;
  allowInsecureHttp: boolean;
  requestTimeoutMs: number;
  promptTimeoutMs: number;
  maxResponseBytes: number;
  maxMediaBytes: number;
  maxAttachmentCount: number;
  maxAttachmentTotalBytes: number;
  completionNotificationsEnabled: boolean;
};

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

async function readResponseText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`Agent 响应过大 (${declared} > ${maxBytes} bytes)`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large").catch(() => {});
      throw new Error(`Agent 响应超过上限 (${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Remote agent over HTTP (token auth).
 * Expects codex-wechat running in `agent` mode on the other machine.
 */
export class HttpHost implements CodexHost {
  readonly kind = "http" as const;
  readonly id: string;
  readonly label: string;
  readonly completionNotificationsEnabled: boolean;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxMediaBytes: number;
  private readonly maxAttachmentCount: number;
  private readonly maxAttachmentTotalBytes: number;

  constructor(cfg: HttpHostConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    const parsed = new URL(cfg.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`host ${cfg.id}: 仅支持 http/https URL`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`host ${cfg.id}: URL 不能包含账号、密码、查询参数或 fragment`);
    }
    if (
      parsed.protocol === "http:" &&
      !isLoopbackHost(parsed.hostname) &&
      !cfg.allowInsecureHttp
    ) {
      throw new Error(
        `host ${cfg.id}: 非 loopback 明文 HTTP 被拒绝；请使用 HTTPS/SSH 隧道，或对可信私网显式设置 allow_insecure_http: true`,
      );
    }
    if (isUnsafeToken(cfg.token)) {
      throw new Error(`host ${cfg.id}: token 必须至少 32 字符且不能是占位符`);
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.token = cfg.token;
    this.requestTimeoutMs = cfg.requestTimeoutMs;
    this.promptTimeoutMs = cfg.promptTimeoutMs;
    this.maxResponseBytes = cfg.maxResponseBytes;
    this.maxMediaBytes = cfg.maxMediaBytes;
    this.maxAttachmentCount = cfg.maxAttachmentCount;
    this.maxAttachmentTotalBytes = cfg.maxAttachmentTotalBytes;
    this.completionNotificationsEnabled = cfg.completionNotificationsEnabled;
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = await readResponseText(res, this.maxResponseBytes);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Agent 请求超时 (${timeoutMs}ms): ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg =
        (data as { error?: string })?.error ||
        text ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.api("GET", "/v1/ping");
      return true;
    } catch {
      return false;
    }
  }

  async statusText(): Promise<string> {
    const r = await this.api<{ text: string }>("GET", "/v1/status");
    return `host: ${this.id} (http ${this.baseUrl})\n${r.text}`;
  }

  async usageText(): Promise<string> {
    const r = await this.api<{ text: string }>("GET", "/v1/usage");
    return r.text;
  }

  async getModelConfig(): Promise<ModelConfigSnapshot> {
    const r = await this.api<{ config: ModelConfigSnapshot }>(
      "GET",
      "/v1/config/read",
    );
    return r.config;
  }

  async listModels(): Promise<CodexModelInfo[]> {
    const r = await this.api<{ models: CodexModelInfo[] }>(
      "GET",
      "/v1/models",
    );
    return r.models;
  }

  async setModel(modelId: string): Promise<ModelConfigSnapshot> {
    const r = await this.api<{ config: ModelConfigSnapshot }>(
      "POST",
      "/v1/config/write",
      { keyPath: "model", value: modelId },
    );
    return r.config;
  }

  async setReasoningEffort(effort: string): Promise<ModelConfigSnapshot> {
    const r = await this.api<{ config: ModelConfigSnapshot }>(
      "POST",
      "/v1/config/write",
      { keyPath: "model_reasoning_effort", value: effort },
    );
    return r.config;
  }

  async getSecurityPolicy(): Promise<SecurityPolicySnapshot> {
    const r = await this.api<{ policy: SecurityPolicySnapshot }>(
      "GET",
      "/v1/security",
    );
    return r.policy;
  }

  async setSandboxMode(
    mode: CodexSandboxMode,
  ): Promise<SecurityPolicySnapshot> {
    const r = await this.api<{ policy: SecurityPolicySnapshot }>(
      "POST",
      "/v1/security",
      { sandboxMode: mode },
    );
    return r.policy;
  }

  async setApprovalPolicy(
    policy: CodexApprovalPolicy,
  ): Promise<SecurityPolicySnapshot> {
    const r = await this.api<{ policy: SecurityPolicySnapshot }>(
      "POST",
      "/v1/security",
      { approvalPolicy: policy },
    );
    return r.policy;
  }

  async getCwd(): Promise<string> {
    const r = await this.api<{ cwd: string }>("GET", "/v1/cwd");
    return r.cwd;
  }

  async setCwd(path: string): Promise<string> {
    const r = await this.api<{ text: string }>("POST", "/v1/cwd", { path });
    return r.text;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const r = await this.api<{ projects: ProjectInfo[] }>("GET", "/v1/projects");
    return r.projects;
  }

  async selectProject(selector: string): Promise<string> {
    const r = await this.api<{ text: string }>("POST", "/v1/project", {
      selector,
    });
    return r.text;
  }

  async newThread(title?: string): Promise<string> {
    const body: Record<string, string> = {};
    if (title) body.title = title;
    const r = await this.api<{ text: string }>("POST", "/v1/sessions/new", body);
    return r.text;
  }

  async listSessions(): Promise<string> {
    const r = await this.api<{ text: string }>("GET", "/v1/sessions");
    return r.text;
  }

  async useSession(arg: string): Promise<string> {
    const r = await this.api<{ text: string }>("POST", "/v1/sessions/use", {
      arg,
    });
    return r.text;
  }

  async runPrompt(
    text: string,
    attachments: Attachment[],
    hooks?: {
      onApproval?: (a: PendingApprovalView) => void | Promise<void>;
    },
  ): Promise<string> {
    // Poll approvals while the long prompt request runs
    let stop = false;
    const seen = new Set<string>();
    const poll = (async () => {
      while (!stop) {
        try {
          const r = await this.api<{
            items: PendingApprovalView[];
          }>("GET", "/v1/approvals", undefined, 5_000);
          for (const a of r.items ?? []) {
            if (seen.has(a.shortCode)) continue;
            seen.add(a.shortCode);
            await hooks?.onApproval?.(a);
          }
        } catch {
          // ignore poll errors during prompt
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();

    try {
      // Serialize attachments as base64 for the wire
      if (attachments.length > this.maxAttachmentCount) {
        throw new Error(`附件数量超过上限 (${this.maxAttachmentCount})`);
      }
      let totalBytes = 0;
      const wireAtt = attachments.map((a) => {
        const st = statSync(a.path);
        if (!st.isFile()) throw new Error(`附件不是普通文件: ${a.fileName}`);
        if (st.size > this.maxMediaBytes) {
          throw new Error(`附件过大: ${a.fileName} (${st.size} bytes)`);
        }
        totalBytes += st.size;
        if (totalBytes > this.maxAttachmentTotalBytes) {
          throw new Error(`附件总大小超过上限 (${this.maxAttachmentTotalBytes} bytes)`);
        }
        return {
          kind: a.kind,
          fileName: a.fileName,
          size: st.size,
          base64: readFileSync(a.path).toString("base64"),
        };
      });

      const r = await this.api<{ text: string }>("POST", "/v1/prompt", {
        text,
        attachments: wireAtt,
      }, this.promptTimeoutMs);
      return r.text;
    } finally {
      stop = true;
      await poll.catch(() => {});
    }
  }

  async listApprovalsText(): Promise<string> {
    const r = await this.api<{ text: string }>("GET", "/v1/approvals/text");
    return r.text;
  }

  async listPendingApprovals(): Promise<PendingApprovalView[]> {
    const r = await this.api<{ items: PendingApprovalView[] }>(
      "GET",
      "/v1/approvals",
      undefined,
      5_000,
    );
    return r.items ?? [];
  }

  async resolveApproval(
    code: string,
    decision: "accept" | "decline",
  ): Promise<string> {
    const r = await this.api<{ text: string }>("POST", "/v1/approve", {
      code,
      decision,
    });
    return r.text;
  }

  async ackCompletions(ids: string[]): Promise<void> {
    await this.api<{ ok: true }>("POST", "/v1/completions/ack", { ids });
  }

  async pollCompletions(limit: number): Promise<CompletionEvent[]> {
    const r = await this.api<{ events: CompletionEvent[] }>(
      "GET",
      `/v1/completions?limit=${encodeURIComponent(String(limit))}`,
    );
    return r.events ?? [];
  }

  async getFile(
    path: string,
  ): Promise<{ fileName: string; data: Buffer; isImage: boolean }> {
    const r = await this.api<{
      fileName: string;
      base64: string;
      isImage: boolean;
    }>("POST", "/v1/get-file", { path });
    if (
      typeof r.base64 !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(r.base64) ||
      r.base64.length % 4 !== 0
    ) {
      throw new Error("Agent 返回了无效的 base64 文件内容");
    }
    const data = Buffer.from(r.base64, "base64");
    if (data.length > this.maxMediaBytes) {
      throw new Error(`Agent 返回文件超过上限 (${data.length} bytes)`);
    }
    return {
      fileName: r.fileName,
      data,
      isImage: r.isImage,
    };
  }
}
