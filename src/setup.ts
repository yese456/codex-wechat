import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  CODEX_SANDBOX_MODES,
  defaultDataDir,
  expandHome,
  resolveConfigPath,
  type CodexSandboxMode,
  type StartupMode,
} from "./config.js";

export type InitialSetup = {
  startupMode: StartupMode;
  defaultCwd: string;
  sandboxMode: CodexSandboxMode;
};

export function setupConfigPath(home = homedir()): string {
  const configured = process.env.CODEX_WECHAT_CONFIG?.trim();
  if (configured) return resolve(expandHome(configured, home));
  return resolveConfigPath(home) ?? join(defaultDataDir(home), "config.yaml");
}

export function hasUserConfig(home = homedir()): boolean {
  const path = resolveConfigPath(home);
  return Boolean(path && existsSync(path));
}

export function hasEnvironmentConfig(): boolean {
  return Boolean(
    process.env.CODEX_WECHAT_CWD?.trim() ||
      process.env.CODEX_WECHAT_CONFIG?.trim() ||
      process.env.CODEX_WECHAT_AGENT_TOKEN?.trim(),
  );
}

export function renderInitialConfig(
  setup: InitialSetup,
  existing: Record<string, unknown> = {},
): string {
  const next: Record<string, unknown> = {
    ...existing,
    startup_mode: setup.startupMode,
    machine_name:
      process.env.CODEX_WECHAT_MACHINE?.trim() ||
      (typeof existing.machine_name === "string" && existing.machine_name.trim()
        ? existing.machine_name
        : hostname() || "local"),
    default_cwd: setup.defaultCwd,
    allowed_roots:
      Array.isArray(existing.allowed_roots) && existing.allowed_roots.length > 0
        ? existing.allowed_roots
        : [setup.defaultCwd],
    codex_sandbox_mode: setup.sandboxMode,
    codex_approval_policy:
      typeof existing.codex_approval_policy === "string"
        ? existing.codex_approval_policy
        : "on-request",
  };

  const existingAgent =
    existing.agent && typeof existing.agent === "object" && !Array.isArray(existing.agent)
      ? (existing.agent as Record<string, unknown>)
      : {};
  next.agent = {
    ...existingAgent,
    host: existingAgent.host ?? "127.0.0.1",
    port: existingAgent.port ?? 18765,
    token:
      typeof existingAgent.token === "string" && existingAgent.token.length >= 32
        ? existingAgent.token
        : randomBytes(32).toString("hex"),
    allow_insecure_http: existingAgent.allow_insecure_http ?? false,
  };

  return `# codex-wechat 首次使用配置，可再次运行 codex-wechat init --force 修改\n${stringifyYaml(next, {
    lineWidth: 0,
  })}`;
}

export function writeInitialConfig(
  path: string,
  setup: InitialSetup,
  opts: { overwrite?: boolean } = {},
): void {
  if (existsSync(path) && !opts.overwrite) {
    throw new Error(`配置已存在: ${path}`);
  }
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, renderInitialConfig(setup, existing), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function normalizeProjectPath(input: string, home: string): string {
  const expanded = expandHome(input.trim(), home);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
  if (absolute === resolve(home)) {
    throw new Error("默认项目路径不能直接使用整个用户主目录，请选择 ~/code 等具体目录");
  }
  mkdirSync(absolute, { recursive: true });
  const canonical = realpathSync(absolute);
  const canonicalHome = realpathSync(home);
  if (canonical === canonicalHome || canonical === resolve("/")) {
    throw new Error("默认项目路径不能指向整个用户主目录或文件系统根目录");
  }
  return canonical;
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  question: string,
  choices: readonly string[],
  defaultIndex: number,
): Promise<number> {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (!answer) return defaultIndex;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) return index;
    console.log(`请输入 1-${choices.length}`);
  }
}

export async function runSetupWizard(opts: {
  preferredMode?: StartupMode;
  home?: string;
} = {}): Promise<InitialSetup> {
  const home = opts.home ?? homedir();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n=== codex-wechat 首次使用向导 ===\n");
    console.log("请选择本机角色：");
    console.log("  1) Host / Gateway：微信入口，可运行本机 Codex 或路由到 Agent");
    console.log("  2) Agent：执行机，无微信登录，由 Host / Gateway 调用");
    const preferredMode = opts.preferredMode ?? "gateway";
    const modeIndex = await choose(
      rl,
      `角色 [${preferredMode === "agent" ? "2" : "1"}]: `,
      ["gateway", "agent"],
      preferredMode === "agent" ? 1 : 0,
    );
    const startupMode: StartupMode = modeIndex === 1 ? "agent" : "gateway";

    let defaultCwd = "";
    const envCwd = process.env.CODEX_WECHAT_CWD?.trim();
    const suggestedCwd = envCwd
      ? resolve(expandHome(envCwd, home))
      : join(home, "code");
    while (!defaultCwd) {
      const answer = await rl.question(`默认项目路径 [${suggestedCwd}]: `);
      try {
        defaultCwd = normalizeProjectPath(answer.trim() || suggestedCwd, home);
      } catch (err) {
        console.log(`路径不可用: ${(err as Error).message}`);
      }
    }

    console.log("\n请选择 Codex 沙箱权限：");
    console.log("  1) read-only：只读，最安全；写操作需要调整权限");
    console.log("  2) workspace-write：可写默认项目目录，推荐日常开发");
    console.log("  3) danger-full-access：完全访问，风险高");
    const sandboxIndex = await choose(
      rl,
      "沙箱 [1]: ",
      CODEX_SANDBOX_MODES,
      0,
    );
    const sandboxMode = CODEX_SANDBOX_MODES[sandboxIndex];
    if (sandboxMode === "danger-full-access") {
      const confirmation = (
        await rl.question('高风险：Codex 可访问并修改系统可见文件。输入 "confirm" 继续: ')
      )
        .trim()
        .toLowerCase();
      if (confirmation !== "confirm") {
        console.log("未确认高风险权限，已改为 read-only。");
        return { startupMode, defaultCwd, sandboxMode: "read-only" };
      }
    }

    return { startupMode, defaultCwd, sandboxMode };
  } finally {
    rl.close();
  }
}

export async function ensureFirstRunSetup(): Promise<InitialSetup | null> {
  if (hasUserConfig() || hasEnvironmentConfig()) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "尚未完成首次配置。请先在交互终端运行 codex-wechat init，或设置 CODEX_WECHAT_CONFIG 指向已准备好的配置。",
    );
  }
  const setup = await runSetupWizard();
  const path = setupConfigPath();
  writeInitialConfig(path, setup);
  console.log(`\n配置已保存: ${path}`);
  console.log(`启动角色: ${setup.startupMode === "agent" ? "Agent" : "Host / Gateway"}`);
  console.log(`默认项目: ${setup.defaultCwd}`);
  console.log(`沙箱权限: ${setup.sandboxMode}\n`);
  return setup;
}
