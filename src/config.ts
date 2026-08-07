import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  canonicalDirectoryUnderRoots,
  isUnderDir,
} from "./path-safety.js";

export type HostConfigEntry = {
  id: string;
  type: "local" | "http";
  label?: string;
  /** http only */
  url?: string;
  /** http only */
  token?: string;
  /** Required for plaintext HTTP to a non-loopback address. */
  allowInsecureHttp?: boolean;
};

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

export type AppConfig = {
  machineName: string;
  defaultCwd: string;
  /** True when default_cwd fell back to ~/code (not user-configured). */
  defaultCwdIsFallback: boolean;
  allowedRoots: string[];
  codexBin: string | null;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  wechatStorageDir: string;
  statePath: string;
  configPath: string | null;
  approvalTimeoutSec: number;
  maxReplyChars: number;
  /** Max bytes per inbound media file (default 25MB). */
  maxMediaBytes: number;
  maxAttachmentCount: number;
  maxAttachmentTotalBytes: number;
  inboxMaxBytes: number;
  /** Bind code TTL ms (default 5 min). */
  bindTtlMs: number;
  /** Max failed /bind attempts before code is invalidated. */
  bindMaxFails: number;
  homeDir: string;
  /** Multi-host: empty = single local. */
  hosts: HostConfigEntry[];
  defaultHostId: string | null;
  agentHost: string;
  agentPort: number;
  agentToken: string | null;
  agentAllowInsecureHttp: boolean;
  agentMaxBodyBytes: number;
  httpRequestTimeoutMs: number;
  promptTimeoutMs: number;
  maxHttpResponseBytes: number;
};

type RawConfig = {
  machine_name?: string;
  default_cwd?: string;
  allowed_roots?: string[];
  codex_bin?: string;
  codex_sandbox_mode?: string;
  codex_approval_policy?: string;
  wechat_storage_dir?: string;
  state_path?: string;
  approval_timeout_sec?: number;
  max_reply_chars?: number;
  max_media_bytes?: number;
  max_attachment_count?: number;
  max_attachment_total_bytes?: number;
  inbox_max_bytes?: number;
  bind_ttl_sec?: number;
  bind_max_fails?: number;
  default_host?: string;
  hosts?: Array<{
    id?: string;
    type?: string;
    label?: string;
    url?: string;
    token?: string;
    allow_insecure_http?: boolean;
  }>;
  agent?: {
    host?: string;
    port?: number;
    token?: string;
    allow_insecure_http?: boolean;
    max_body_bytes?: number;
  };
  http_request_timeout_ms?: number;
  prompt_timeout_ms?: number;
  max_http_response_bytes?: number;
};

function positiveInteger(
  name: string,
  value: unknown,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`配置 ${name} 必须是 ${min}-${max} 的整数，当前值: ${String(value)}`);
  }
  return n;
}

function booleanValue(name: string, value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`配置 ${name} 必须是 true/false，当前值: ${String(value)}`);
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`配置 ${name} 必须是字符串`);
  }
  return value.trim() || undefined;
}

function enumValue<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = optionalString(name, value) ?? fallback;
  if (!allowed.includes(normalized as T)) {
    throw new Error(`配置 ${name} 只能是: ${allowed.join(" | ")}`);
  }
  return normalized as T;
}

export function isUnsafeToken(token: string | null | undefined): boolean {
  const normalized = token?.trim().toLowerCase() ?? "";
  return (
    normalized.length < 32 ||
    ["change-me", "changeme", "change-me-long-random", "token"].includes(
      normalized,
    )
  );
}

export function expandHome(path: string, home = homedir()): string {
  if (!path) return path;
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }
  return path;
}

export function defaultDataDir(home = homedir()): string {
  return join(home, ".codex-wechat");
}

export function resolveConfigPath(home = homedir()): string | null {
  const fromEnv = process.env.CODEX_WECHAT_CONFIG?.trim();
  if (fromEnv) return expandHome(fromEnv, home);
  const candidates = [
    join(process.cwd(), "config.yaml"),
    join(process.cwd(), "config.local.yaml"),
    join(defaultDataDir(home), "config.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadRaw(path: string | null): RawConfig {
  if (!path || !existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text) as unknown;
  if (!parsed) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置文件顶层必须是 YAML 对象");
  }
  return parsed as RawConfig;
}

/**
 * Safe default workspace: ~/code (created if missing).
 * Never default to $HOME itself.
 */
export function resolveDefaultCwd(
  home: string,
  explicit: string | undefined,
): { cwd: string; isFallback: boolean } {
  if (explicit?.trim()) {
    const cwd = resolve(expandHome(explicit.trim(), home));
    return { cwd, isFallback: false };
  }
  const cwd = resolve(join(home, "code"));
  mkdirSync(cwd, { recursive: true });
  return { cwd, isFallback: true };
}

export function loadConfig(opts: { home?: string; configPath?: string | null } = {}): AppConfig {
  const home = opts.home ?? homedir();
  const configPath =
    opts.configPath === undefined ? resolveConfigPath(home) : opts.configPath;
  const raw = loadRaw(configPath);
  const dataDir = defaultDataDir(home);

  const machineName =
    process.env.CODEX_WECHAT_MACHINE?.trim() ||
    optionalString("machine_name", raw.machine_name) ||
    process.env.HOSTNAME?.trim() ||
    "local";

  const explicitCwd =
    process.env.CODEX_WECHAT_CWD?.trim() ||
    optionalString("default_cwd", raw.default_cwd);
  const { cwd: defaultCwd, isFallback: defaultCwdIsFallback } = resolveDefaultCwd(
    home,
    explicitCwd,
  );

  if (raw.allowed_roots !== undefined && !Array.isArray(raw.allowed_roots)) {
    throw new Error("配置 allowed_roots 必须是数组");
  }
  if ((raw.allowed_roots ?? []).some((root) => typeof root !== "string")) {
    throw new Error("配置 allowed_roots 中每一项都必须是字符串");
  }
  const allowedRoots = (raw.allowed_roots ?? [])
    .map((r) => expandHome(String(r).trim(), home))
    .filter(Boolean)
    .map((r) => resolve(r));

  // Refuse accidental home-as-cwd unless the user explicitly authorizes roots.
  if (resolve(defaultCwd) === resolve(home) && (raw.allowed_roots?.length ?? 0) === 0) {
    throw new Error(
      "default_cwd 不能直接指向 $HOME；请改为 ~/code 等具体目录，或显式配置 allowed_roots",
    );
  }

  const codexBin =
    process.env.CODEX_WECHAT_CODEX_PATH?.trim() ||
    process.env.CODEX_PATH?.trim() ||
    optionalString("codex_bin", raw.codex_bin) ||
    null;
  const codexSandboxMode = enumValue<CodexSandboxMode>(
    "codex_sandbox_mode",
    process.env.CODEX_WECHAT_CODEX_SANDBOX ?? raw.codex_sandbox_mode,
    ["read-only", "workspace-write", "danger-full-access"],
    "read-only",
  );
  const codexApprovalPolicy = enumValue<CodexApprovalPolicy>(
    "codex_approval_policy",
    process.env.CODEX_WECHAT_CODEX_APPROVAL_POLICY ??
      raw.codex_approval_policy,
    ["untrusted", "on-request", "never"],
    "on-request",
  );

  const wechatStorageDir = expandHome(
    process.env.CODEX_WECHAT_WECHAT_DIR?.trim() ||
      optionalString("wechat_storage_dir", raw.wechat_storage_dir) ||
      join(dataDir, "wechat"),
    home,
  );

  const statePath = expandHome(
    process.env.CODEX_WECHAT_STATE?.trim() ||
      optionalString("state_path", raw.state_path) ||
      join(dataDir, "state.json"),
    home,
  );

  const approvalTimeoutSec = positiveInteger(
    "approval_timeout_sec",
    process.env.CODEX_WECHAT_APPROVAL_TIMEOUT ??
      raw.approval_timeout_sec,
    300,
    1,
    86_400,
  );

  const maxReplyChars = positiveInteger(
    "max_reply_chars",
    process.env.CODEX_WECHAT_MAX_REPLY_CHARS ?? raw.max_reply_chars,
    3500,
    1,
    10_000,
  );

  const maxMediaBytes = positiveInteger(
    "max_media_bytes",
    process.env.CODEX_WECHAT_MAX_MEDIA_BYTES ??
      raw.max_media_bytes,
    25 * 1024 * 1024,
    1,
    1024 * 1024 * 1024,
  );
  const maxAttachmentCount = positiveInteger(
    "max_attachment_count",
    process.env.CODEX_WECHAT_MAX_ATTACHMENT_COUNT ?? raw.max_attachment_count,
    8,
    1,
    32,
  );
  const maxAttachmentTotalBytes = positiveInteger(
    "max_attachment_total_bytes",
    process.env.CODEX_WECHAT_MAX_ATTACHMENT_TOTAL_BYTES ??
      raw.max_attachment_total_bytes,
    50 * 1024 * 1024,
    1,
    2 * 1024 * 1024 * 1024,
  );
  const inboxMaxBytes = positiveInteger(
    "inbox_max_bytes",
    process.env.CODEX_WECHAT_INBOX_MAX_BYTES ?? raw.inbox_max_bytes,
    1024 * 1024 * 1024,
    maxAttachmentTotalBytes,
    16 * 1024 * 1024 * 1024,
  );

  const bindTtlSec = positiveInteger(
    "bind_ttl_sec",
    process.env.CODEX_WECHAT_BIND_TTL_SEC ?? raw.bind_ttl_sec,
    300,
    30,
    86_400,
  );
  const bindMaxFails = positiveInteger(
    "bind_max_fails",
    process.env.CODEX_WECHAT_BIND_MAX_FAILS ?? raw.bind_max_fails,
    5,
    1,
    20,
  );

  const hosts: HostConfigEntry[] = [];
  if (raw.hosts !== undefined && !Array.isArray(raw.hosts)) {
    throw new Error("配置 hosts 必须是数组");
  }
  const hostIds = new Set<string>();
  let localHostCount = 0;
  for (const h of raw.hosts ?? []) {
    if (!h || typeof h !== "object" || !h.id || !h.type) {
      throw new Error("hosts 中每一项都必须包含 id 和 type");
    }
    if (typeof h.id !== "string" || typeof h.type !== "string") {
      throw new Error("host 的 id 和 type 必须是字符串");
    }
    if (h.type !== "local" && h.type !== "http") {
      throw new Error(`host ${String(h.id)}: type 只能是 local 或 http`);
    }
    const id = String(h.id).trim();
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`host id 仅允许字母、数字、_、-：${id}`);
    }
    if (hostIds.has(id)) throw new Error(`host id 重复: ${id}`);
    hostIds.add(id);
    if (h.type === "local" && ++localHostCount > 1) {
      throw new Error("最多只能配置一个 local host");
    }
    hosts.push({
      id,
      type: h.type,
      label: typeof h.label === "string" ? h.label.trim() || undefined : undefined,
      url: typeof h.url === "string" ? h.url.trim() || undefined : undefined,
      token: typeof h.token === "string" ? h.token.trim() || undefined : undefined,
      allowInsecureHttp: booleanValue(
        `hosts.${id}.allow_insecure_http`,
        h.allow_insecure_http,
      ),
    });
  }

  const defaultHostId =
    process.env.CODEX_WECHAT_DEFAULT_HOST?.trim() ||
    optionalString("default_host", raw.default_host) ||
    null;
  if (defaultHostId) {
    const validDefault =
      hosts.length === 0 ? defaultHostId === "local" : hostIds.has(defaultHostId);
    if (!validDefault) throw new Error(`default_host 不存在: ${defaultHostId}`);
  }

  if (
    raw.agent !== undefined &&
    (!raw.agent || typeof raw.agent !== "object" || Array.isArray(raw.agent))
  ) {
    throw new Error("配置 agent 必须是对象");
  }
  const agentHost =
    process.env.CODEX_WECHAT_AGENT_HOST?.trim() ||
    optionalString("agent.host", raw.agent?.host) ||
    "127.0.0.1";
  const agentPort = positiveInteger(
    "agent.port",
    process.env.CODEX_WECHAT_AGENT_PORT ?? raw.agent?.port,
    18765,
    1,
    65_535,
  );
  const agentToken =
    process.env.CODEX_WECHAT_AGENT_TOKEN?.trim() ||
    optionalString("agent.token", raw.agent?.token) ||
    null;
  if (agentToken && isUnsafeToken(agentToken)) {
    throw new Error("agent.token 必须至少 32 字符且不能使用 change-me 等占位符");
  }
  const agentAllowInsecureHttp = booleanValue(
    "agent.allow_insecure_http",
    process.env.CODEX_WECHAT_AGENT_ALLOW_INSECURE_HTTP ??
      raw.agent?.allow_insecure_http,
  );
  const agentMaxBodyBytes = positiveInteger(
    "agent.max_body_bytes",
    process.env.CODEX_WECHAT_AGENT_MAX_BODY_BYTES ?? raw.agent?.max_body_bytes,
    Math.ceil((maxAttachmentTotalBytes * 4) / 3) + 1024 * 1024,
    1024,
    3 * 1024 * 1024 * 1024,
  );
  const httpRequestTimeoutMs = positiveInteger(
    "http_request_timeout_ms",
    process.env.CODEX_WECHAT_HTTP_TIMEOUT_MS ?? raw.http_request_timeout_ms,
    15_000,
    100,
    120_000,
  );
  const promptTimeoutMs = positiveInteger(
    "prompt_timeout_ms",
    process.env.CODEX_WECHAT_PROMPT_TIMEOUT_MS ?? raw.prompt_timeout_ms,
    15 * 60 * 1000,
    1_000,
    24 * 60 * 60 * 1000,
  );
  const maxHttpResponseBytes = positiveInteger(
    "max_http_response_bytes",
    process.env.CODEX_WECHAT_MAX_HTTP_RESPONSE_BYTES ??
      raw.max_http_response_bytes,
    Math.max(8 * 1024 * 1024, Math.ceil((maxMediaBytes * 4) / 3) + 1024 * 1024),
    1024,
    3 * 1024 * 1024 * 1024,
  );

  return {
    machineName,
    defaultCwd,
    defaultCwdIsFallback,
    allowedRoots,
    codexBin,
    codexSandboxMode,
    codexApprovalPolicy,
    wechatStorageDir,
    statePath,
    configPath,
    approvalTimeoutSec,
    maxReplyChars,
    maxMediaBytes,
    maxAttachmentCount,
    maxAttachmentTotalBytes,
    inboxMaxBytes,
    bindTtlMs: bindTtlSec * 1000,
    bindMaxFails,
    homeDir: home,
    hosts,
    defaultHostId,
    agentHost,
    agentPort,
    agentToken,
    agentAllowInsecureHttp,
    agentMaxBodyBytes,
    httpRequestTimeoutMs,
    promptTimeoutMs,
    maxHttpResponseBytes,
  };
}

export function ensureDataDirs(config: AppConfig): void {
  const secureDirs = [
    defaultDataDir(config.homeDir),
    config.wechatStorageDir,
    join(config.statePath, ".."),
  ];
  for (const dir of secureDirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  }
  mkdirSync(config.defaultCwd, { recursive: true });
  if (config.configPath && existsSync(config.configPath) && process.platform !== "win32") {
    chmodSync(config.configPath, 0o600);
  }
}

/**
 * Resolve and validate a user-supplied cwd.
 * - Must be an existing directory
 * - If allowed_roots set: must be under one of them
 * - If not: must be under default_cwd (never arbitrary FS)
 */
export function resolveCwd(input: string, config: AppConfig): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("cwd 不能为空");
  }
  const expanded = expandHome(trimmed, config.homeDir);
  const abs = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(config.defaultCwd, expanded);

  const roots =
    config.allowedRoots.length > 0
      ? config.allowedRoots
      : [config.defaultCwd];

  return canonicalDirectoryUnderRoots(abs, roots);
}

/**
 * For non-/get path checks: under allowed_roots, or under default_cwd when roots empty.
 * Never defaults to entire $HOME.
 */
export function isPathAllowed(absPath: string, config: AppConfig): boolean {
  const abs = resolve(absPath);
  const roots =
    config.allowedRoots.length > 0
      ? config.allowedRoots
      : [config.defaultCwd];
  try {
    const target = existsSync(abs) ? realpathSync(abs) : abs;
    return roots.some((root) => {
      const rootAbs = resolve(root);
      const canonicalRoot = existsSync(rootAbs) ? realpathSync(rootAbs) : rootAbs;
      return isUnderDir(target, canonicalRoot);
    });
  } catch {
    return false;
  }
}
