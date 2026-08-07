import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import {
  ensureDataDirs,
  isUnsafeToken,
  loadConfig,
} from "../config.js";
import { StateStore } from "../state.js";
import { CodexClient } from "../codex/client.js";
import { LocalHost } from "../hosts/local-host.js";
import { ApprovalBridge } from "../approvals.js";
import { saveAttachment } from "../media/save.js";
import type { Attachment, AttachmentKind } from "../media/types.js";
import { inboxRootForCwd } from "../media/save.js";

type WireAttachment = {
  kind?: string;
  fileName?: string;
  base64?: string;
  path?: string;
  size?: number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, `请求体过大 (${declared} > ${maxBytes} bytes)`));
      req.resume();
      return;
    }
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, `请求体超过上限 (${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJson<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Content-Type 必须是 application/json");
  }
  const text = await readBody(req, maxBytes);
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new HttpError(400, "无效 JSON 请求体");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: "unauthorized" });
}

/**
 * Headless agent: exposes Codex over HTTP for a gateway.
 * No WeChat — only the entry machine runs WeChat.
 */
export async function runAgentServer(
  opts: { config?: AppConfig } = {},
): Promise<void> {
  const config = opts.config ?? loadConfig();
  ensureDataDirs(config);

  const token =
    config.agentToken ||
    process.env.CODEX_WECHAT_AGENT_TOKEN ||
    "";
  if (!token) {
    console.warn(
      "[agent] 未设置 agent.token / CODEX_WECHAT_AGENT_TOKEN — 仅允许 loopback 且会生成临时 token 打印一次",
    );
  }
  if (token && isUnsafeToken(token)) {
    throw new Error("agent token 必须至少 32 字符且不能使用 change-me 等占位符");
  }
  const effectiveToken = token || randomBytes(32).toString("hex");
  if (!token) {
    console.log(`[agent] 临时 token（请写入 gateway hosts.*.token）:\n  ${effectiveToken}\n`);
  }

  const hostBind = config.agentHost || "127.0.0.1";
  const port = config.agentPort || 18765;
  if (!isLoopback(hostBind) && !token) {
    throw new Error("非 loopback 监听时必须配置 agent.token");
  }
  if (!isLoopback(hostBind) && !config.agentAllowInsecureHttp) {
    throw new Error(
      "非 loopback 明文 HTTP 默认拒绝；请绑定 127.0.0.1 并使用 HTTPS/SSH 隧道，或对可信私网显式设置 agent.allow_insecure_http: true",
    );
  }
  if (!isLoopback(hostBind)) {
    console.warn(
      "[agent] 警告: 正在非 loopback 地址提供明文 HTTP；仅可用于 Tailscale/WireGuard 等可信加密私网",
    );
  }

  const state = new StateStore(config.statePath, config.defaultCwd);
  const codex = new CodexClient({
    command: config.codexBin,
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: config.codexApprovalPolicy,
  });
  try {
    await codex.initialize();
    console.log("[agent] app-server connected");
  } catch (err) {
    console.warn("[agent] app-server 暂未连上:", (err as Error).message);
  }

  const local = new LocalHost(
    "agent",
    config.machineName,
    config,
    state,
    codex,
  );

  // Collect approvals for polling; optional log
  const approvalBridge = new ApprovalBridge(
    codex,
    config.approvalTimeoutSec,
    async (approval) => {
      console.log(
        `[agent] 待审批 ${approval.shortCode}: ${approval.summary.slice(0, 80)}`,
      );
    },
  );
  approvalBridge.attach();

  const checkAuth = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const actual = Buffer.from(m[1] ?? "", "utf8");
    const expected = Buffer.from(effectiveToken, "utf8");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  };

  let operationInFlight = false;
  const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (operationInFlight) throw new HttpError(409, "agent busy");
    operationInFlight = true;
    try {
      return await fn();
    } finally {
      operationInFlight = false;
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${hostBind}`);
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!checkAuth(req)) {
        unauthorized(res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/ping") {
        sendJson(res, 200, { ok: true, machine: config.machineName });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/status") {
        sendJson(res, 200, { text: await local.statusText() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/usage") {
        sendJson(res, 200, { text: await local.usageText() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/config/read") {
        sendJson(res, 200, { config: await local.getModelConfig() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, { models: await local.listModels() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/config/write") {
        const updated = await exclusive(async () => {
          const body = await readJson<{
            keyPath?: string;
            value?: string;
          }>(req, config.agentMaxBodyBytes);
          if (typeof body.value !== "string" || !body.value.trim()) {
            throw new HttpError(400, "value 必须是非空字符串");
          }
          if (body.keyPath === "model") {
            return local.setModel(body.value);
          }
          if (body.keyPath === "model_reasoning_effort") {
            return local.setReasoningEffort(body.value);
          }
          throw new HttpError(400, "只允许修改 model 或 model_reasoning_effort");
        });
        sendJson(res, 200, { config: updated });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/cwd") {
        sendJson(res, 200, { cwd: await local.getCwd() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/cwd") {
        const text = await exclusive(async () => {
          const body = await readJson<{ path?: string }>(
            req,
            config.agentMaxBodyBytes,
          );
          if (typeof body.path !== "string") {
            throw new HttpError(400, "path 必须是字符串");
          }
          return local.setCwd(body.path);
        });
        sendJson(res, 200, { text });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(res, 200, { text: await local.listSessions() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions/new") {
        const text = await exclusive(async () => {
          const body = await readJson<{ title?: string }>(
            req,
            config.agentMaxBodyBytes,
          );
          if (body.title !== undefined && typeof body.title !== "string") {
            throw new HttpError(400, "title 必须是字符串");
          }
          return local.newThread(body.title || undefined);
        });
        sendJson(res, 200, { text });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions/use") {
        const text = await exclusive(async () => {
          const body = await readJson<{ arg?: string }>(
            req,
            config.agentMaxBodyBytes,
          );
          if (typeof body.arg !== "string") {
            throw new HttpError(400, "arg 必须是字符串");
          }
          return local.useSession(body.arg);
        });
        sendJson(res, 200, { text });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/approvals") {
        const items = codex.listPendingApprovals().map((a) => ({
          shortCode: a.shortCode,
          summary: a.summary,
        }));
        sendJson(res, 200, { items });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/approvals/text") {
        sendJson(res, 200, { text: await local.listApprovalsText() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/approve") {
        const body = await readJson<{
          code?: string;
          decision?: "accept" | "decline";
        }>(req, config.agentMaxBodyBytes);
        if (typeof body.code !== "string" || !body.code.trim()) {
          throw new HttpError(400, "code 必须是非空字符串");
        }
        if (body.decision !== "accept" && body.decision !== "decline") {
          throw new HttpError(400, "decision 必须是 accept 或 decline");
        }
        sendJson(res, 200, {
          text: await local.resolveApproval(
            body.code,
            body.decision || "decline",
          ),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/get-file") {
        const body = await readJson<{ path?: string }>(
          req,
          config.agentMaxBodyBytes,
        );
        if (typeof body.path !== "string" || !body.path.trim()) {
          throw new HttpError(400, "path 必须是非空字符串");
        }
        const file = await local.getFile(body.path);
        sendJson(res, 200, {
          fileName: file.fileName,
          base64: file.data.toString("base64"),
          isImage: file.isImage,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/prompt") {
        const text = await exclusive(async () => {
          const body = await readJson<{
            text?: string;
            attachments?: WireAttachment[];
          }>(req, config.agentMaxBodyBytes);
          if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
            throw new HttpError(400, "attachments 必须是数组");
          }
          if (body.text !== undefined && typeof body.text !== "string") {
            throw new HttpError(400, "text 必须是字符串");
          }
          const attachments = materializeAttachments(
            body.attachments || [],
            await local.getCwd(),
            config,
          );
          return local.runPrompt(body.text || "", attachments);
        });
        sendJson(res, 200, { text });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error("[agent] request failed:", err);
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
    }
  });

  server.listen(port, hostBind, () => {
    console.log(
      `[agent] listening http://${hostBind}:${port}  machine=${config.machineName}`,
    );
    console.log(
      "[agent] 无微信；由 gateway 通过 hosts 配置连接此 agent",
    );
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;

  const shutdown = async () => {
    approvalBridge.dispose();
    await codex.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function materializeAttachments(
  wire: WireAttachment[],
  cwd: string,
  config: AppConfig,
): Attachment[] {
  if (wire.length > config.maxAttachmentCount) {
    throw new HttpError(413, `附件数量超过上限 (${config.maxAttachmentCount})`);
  }
  const out: Attachment[] = [];
  const inbox = inboxRootForCwd(cwd);
  mkdirSync(inbox, { recursive: true });
  let totalBytes = 0;
  for (const w of wire) {
    if (!w || typeof w !== "object") {
      throw new HttpError(400, "附件项必须是对象");
    }
    if (w.fileName !== undefined && typeof w.fileName !== "string") {
      throw new HttpError(400, "附件 fileName 必须是字符串");
    }
    if (typeof w.base64 !== "string" || !w.base64) {
      throw new HttpError(400, "附件缺少 base64 内容");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(w.base64) || w.base64.length % 4 !== 0) {
      throw new HttpError(400, `附件 base64 无效: ${w.fileName || "file"}`);
    }
    const estimatedBytes = Math.floor((w.base64.length * 3) / 4);
    if (estimatedBytes > config.maxMediaBytes) {
      throw new HttpError(413, `附件过大: ${w.fileName || "file"}`);
    }
    const data = Buffer.from(w.base64, "base64");
    totalBytes += data.length;
    if (data.length > config.maxMediaBytes) {
      throw new HttpError(413, `附件过大: ${w.fileName || "file"}`);
    }
    if (totalBytes > config.maxAttachmentTotalBytes) {
      throw new HttpError(
        413,
        `附件总大小超过上限 (${config.maxAttachmentTotalBytes} bytes)`,
      );
    }
    const allowedKinds: AttachmentKind[] = ["image", "file", "video", "voice"];
    const kind = allowedKinds.includes(w.kind as AttachmentKind)
      ? (w.kind as AttachmentKind)
      : "file";
    out.push(
      saveAttachment({
        data,
        fileName: w.fileName || "file.bin",
        kind,
        inboxRoot: inbox,
        maxBytes: config.maxMediaBytes,
        maxInboxBytes: config.inboxMaxBytes,
      }),
    );
  }
  return out;
}
