import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./config.js";

export type AppState = {
  version: 1;
  /** Bound WeChat user id (ilink). Empty until /bind. */
  allowUserId: string;
  /** One-time bind code printed on console; cleared after bind. */
  pendingBindCode: string | null;
  pendingBindExpiresAt: number | null;
  /** Failed /bind attempts for current pending code. */
  pendingBindFailCount: number;
  cwd: string;
  threadId: string | null;
  threadPreview: string | null;
  /** Gateway multi-host: current host id (local / vps / …). */
  currentHostId: string | null;
  /** Runtime overrides changed from WeChat; null means config.yaml/env default. */
  codexSandboxMode: CodexSandboxMode | null;
  codexApprovalPolicy: CodexApprovalPolicy | null;
  updatedAt: string;
};

const DEFAULT: Omit<AppState, "cwd"> & { cwd?: string } = {
  version: 1,
  allowUserId: "",
  pendingBindCode: null,
  pendingBindExpiresAt: null,
  pendingBindFailCount: 0,
  threadId: null,
  threadPreview: null,
  currentHostId: null,
  codexSandboxMode: null,
  codexApprovalPolicy: null,
  updatedAt: new Date(0).toISOString(),
};

export class StateStore {
  constructor(
    private readonly path: string,
    private readonly defaultCwd: string,
  ) {}

  load(): AppState {
    return this.loadUnlocked();
  }

  private loadUnlocked(): AppState {
    if (!existsSync(this.path)) {
      return this.createDefault();
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<AppState>;
      return {
        version: 1,
        allowUserId: String(raw.allowUserId ?? ""),
        pendingBindCode:
          typeof raw.pendingBindCode === "string" ? raw.pendingBindCode : null,
        pendingBindExpiresAt:
          typeof raw.pendingBindExpiresAt === "number" &&
          Number.isFinite(raw.pendingBindExpiresAt)
            ? raw.pendingBindExpiresAt
            : null,
        pendingBindFailCount: Number(raw.pendingBindFailCount ?? 0) || 0,
        cwd: typeof raw.cwd === "string" && raw.cwd ? raw.cwd : this.defaultCwd,
        threadId: typeof raw.threadId === "string" ? raw.threadId : null,
        threadPreview:
          typeof raw.threadPreview === "string" ? raw.threadPreview : null,
        currentHostId:
          typeof raw.currentHostId === "string" ? raw.currentHostId : null,
        codexSandboxMode:
          typeof raw.codexSandboxMode === "string" &&
          CODEX_SANDBOX_MODES.includes(raw.codexSandboxMode as CodexSandboxMode)
            ? (raw.codexSandboxMode as CodexSandboxMode)
            : null,
        codexApprovalPolicy:
          typeof raw.codexApprovalPolicy === "string" &&
          CODEX_APPROVAL_POLICIES.includes(
            raw.codexApprovalPolicy as CodexApprovalPolicy,
          )
            ? (raw.codexApprovalPolicy as CodexApprovalPolicy)
            : null,
        updatedAt:
          typeof raw.updatedAt === "string"
            ? raw.updatedAt
            : new Date().toISOString(),
      };
    } catch (err) {
      throw new Error(
        `state 文件损坏，已保留原文件，请修复或备份后移走: ${this.path}`,
        { cause: err },
      );
    }
  }

  save(state: AppState): void {
    this.withLock(() => this.saveUnlocked(state));
  }

  private saveUnlocked(state: AppState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const next: AppState = {
      ...state,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        encoding: "utf8",
      });
      if (process.platform !== "win32") chmodSync(tempPath, 0o600);
      const fd = openSync(tempPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, this.path);
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  update(patch: Partial<AppState>): AppState {
    return this.withLock(() => {
      const current = this.loadUnlocked();
      const next = { ...current, ...patch };
      this.saveUnlocked(next);
      return next;
    });
  }

  /**
   * Issue a short-lived bind code.
   * Default: 16 random bytes → 32 hex chars (128-bit), 5 min TTL.
   */
  issueBindCode(
    ttlMs = 5 * 60 * 1000,
    bytes = 16,
  ): { code: string; expiresAt: number } {
    const code = randomBytes(bytes).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    this.update({
      pendingBindCode: code,
      pendingBindExpiresAt: expiresAt,
      pendingBindFailCount: 0,
    });
    return { code, expiresAt };
  }

  tryBind(
    userId: string,
    code: string,
    maxFails = 5,
  ): { ok: true } | { ok: false; reason: string } {
    return this.withLock(() => {
      const state = this.loadUnlocked();
      if (state.allowUserId && state.allowUserId === userId) {
        return { ok: true };
      }
      if (state.allowUserId && state.allowUserId !== userId) {
        return {
          ok: false,
          reason: "已绑定其他微信用户。解绑请在本机运行: codex-wechat unbind",
        };
      }
      if (!state.pendingBindCode || !state.pendingBindExpiresAt) {
        return { ok: false, reason: "无待绑定码。请在本机运行: codex-wechat bind" };
      }
      if (Date.now() > state.pendingBindExpiresAt) {
        this.saveUnlocked({
          ...state,
          pendingBindCode: null,
          pendingBindExpiresAt: null,
          pendingBindFailCount: 0,
        });
        return { ok: false, reason: "绑定码已过期。请在本机重新运行: codex-wechat bind" };
      }
      const expectedCode = Buffer.from(
        state.pendingBindCode.toLowerCase(),
        "utf8",
      );
      const suppliedCode = Buffer.from(code.trim().toLowerCase(), "utf8");
      const comparableCode = Buffer.alloc(expectedCode.length);
      suppliedCode.copy(comparableCode, 0, 0, expectedCode.length);
      const codeMatches =
        suppliedCode.length === expectedCode.length &&
        timingSafeEqual(comparableCode, expectedCode);
      if (!codeMatches) {
        const fails = (state.pendingBindFailCount || 0) + 1;
        if (fails >= maxFails) {
          this.saveUnlocked({
            ...state,
            pendingBindCode: null,
            pendingBindExpiresAt: null,
            pendingBindFailCount: 0,
          });
          return {
            ok: false,
            reason: `绑定码错误次数过多（${maxFails}），已作废。请在本机重新运行: codex-wechat bind`,
          };
        }
        this.saveUnlocked({ ...state, pendingBindFailCount: fails });
        return {
          ok: false,
          reason: `绑定码错误（${fails}/${maxFails}）`,
        };
      }
      this.saveUnlocked({
        ...state,
        allowUserId: userId,
        pendingBindCode: null,
        pendingBindExpiresAt: null,
        pendingBindFailCount: 0,
      });
      return { ok: true };
    });
  }

  unbind(): void {
    this.update({
      allowUserId: "",
      pendingBindCode: null,
      pendingBindExpiresAt: null,
      pendingBindFailCount: 0,
    });
  }

  private createDefault(): AppState {
    return {
      ...DEFAULT,
      cwd: this.defaultCwd,
      updatedAt: new Date().toISOString(),
    };
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let lockFd: number | null = null;
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        Atomics.wait(waitArray, 0, 0, 10);
      }
    }
    if (lockFd === null) throw new Error(`state 文件正忙: ${this.path}`);
    try {
      return fn();
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        // another process may already have removed a stale lock
      }
    }
  }
}
