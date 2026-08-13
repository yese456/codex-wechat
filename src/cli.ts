import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  ensureDataDirs,
  type StartupMode,
} from "./config.js";
import {
  ensureFirstRunSetup,
  runSetupWizard,
  setupConfigPath,
  writeInitialConfig,
} from "./setup.js";
import { StateStore } from "./state.js";
import { resolveCodexCommand } from "./codex/resolve.js";
import { CodexClient } from "./codex/client.js";
import { runDaemon } from "./main.js";
import { runAgentServer } from "./agent/server.js";
import { runNotifyDispatch } from "./completions/dispatcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  ensureDataDirs(config);
  const codexBin = resolveCodexCommand({ override: config.codexBin });
  console.log("== codex-wechat doctor ==");
  console.log(`node:        ${process.version}`);
  console.log(`machine:     ${config.machineName}`);
  console.log(`config cwd:  ${config.defaultCwd}${config.defaultCwdIsFallback ? " (fallback ~/code)" : ""}`);
  console.log(
    `roots:       ${config.allowedRoots.length ? config.allowedRoots.join(", ") : "(default_cwd only)"}`,
  );
  console.log(`state:       ${config.statePath}`);
  console.log(`wechat dir:  ${config.wechatStorageDir}`);
  console.log(`codex bin:   ${codexBin}`);
  console.log(`sandbox:     ${config.codexSandboxMode}`);
  console.log(`approval:    ${config.codexApprovalPolicy}`);
  console.log(`bind TTL:    ${config.bindTtlMs / 1000}s / max fails ${config.bindMaxFails}`);

  if (codexBin !== "codex" && !existsSync(codexBin)) {
    console.log("❌ codex 路径不存在");
  } else {
    console.log("✅ codex 解析成功");
  }

  const state = new StateStore(config.statePath, config.defaultCwd).load();
  const sandboxMode = state.codexSandboxMode ?? config.codexSandboxMode;
  const approvalPolicy =
    state.codexApprovalPolicy ?? config.codexApprovalPolicy;
  console.log(`runtime:     sandbox=${sandboxMode} approval=${approvalPolicy}`);
  console.log(
    state.allowUserId
      ? `✅ 已绑定微信用户: ${state.allowUserId.slice(0, 12)}…`
      : "⚠️  尚未绑定微信用户（运行 codex-wechat bind）",
  );

  console.log("正在探测 app-server initialize …");
  const client = new CodexClient({
    command: config.codexBin,
    sandboxMode,
    approvalPolicy,
  });
  try {
    const init = await client.initialize();
    console.log("✅ app-server initialize OK");
    console.log(
      "   ",
      typeof init === "object" && init
        ? JSON.stringify(init).slice(0, 200)
        : init,
    );
    const threads = await client.listThreads({ limit: 3 });
    console.log(`✅ thread/list OK（最近 ${threads.length} 条）`);
    await client.close();
  } catch (err) {
    console.log("❌ app-server 失败:", (err as Error).message);
    console.log(
      "   请确认已 `codex login`，且当前用户能访问 ~/.codex",
    );
    await client.close().catch(() => {});
    process.exitCode = 1;
  }
}

function cmdBind(): void {
  const config = loadConfig();
  ensureDataDirs(config);
  const store = new StateStore(config.statePath, config.defaultCwd);
  const state = store.load();
  if (state.allowUserId) {
    console.log(
      `已绑定用户 ${state.allowUserId.slice(0, 12)}…\n若要换绑，先: codex-wechat unbind`,
    );
    return;
  }
  const { code, expiresAt } = store.issueBindCode(config.bindTtlMs);
  console.log("\n========== 绑定码 ==========");
  console.log(`  ${code}`);
  console.log(`有效期至: ${new Date(expiresAt).toLocaleString()}`);
  console.log(`失败上限: ${config.bindMaxFails} 次（超限作废）`);
  console.log("在微信里发送:");
  console.log(`  /bind ${code}`);
  console.log("============================\n");
  console.log("（daemon 需正在运行才能收到微信消息）");
}

function cmdUnbind(): void {
  const config = loadConfig();
  const store = new StateStore(config.statePath, config.defaultCwd);
  store.unbind();
  console.log("已解绑。重新 bind 后可用新微信用户控制。");
}

async function cmdInitConfig(force = false): Promise<void> {
  const target = setupConfigPath();
  if (existsSync(target) && !force) {
    console.log(`配置已存在: ${target}`);
    console.log("如需重新运行向导，请使用: codex-wechat init --force");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (force) {
      throw new Error("init --force 需要交互终端");
    }
    const example = resolveExampleConfigPath();
    const targetDir = dirname(target);
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    if (example) {
      copyFileSync(example, target);
      console.log(`已写入 ${target}（非交互安全默认值）`);
      return;
    }
    writeInitialConfig(target, {
      startupMode: "gateway",
      defaultCwd: "~/code",
      sandboxMode: "read-only",
    });
    console.log(`已写入 ${target}（非交互安全默认值）`);
    return;
  }

  const setup = await runSetupWizard();
  writeInitialConfig(target, setup, { overwrite: force });
  const config = loadConfig({ configPath: target });
  if (existsSync(config.statePath)) {
    new StateStore(config.statePath, config.defaultCwd).update({
      cwd: config.defaultCwd,
      threadId: null,
      threadPreview: null,
      codexSandboxMode: null,
      codexApprovalPolicy: null,
    });
  }
  console.log(`\n配置已保存: ${target}`);
  console.log("下次直接运行 codex-wechat，将按所选角色启动。");
}

export function resolveExampleConfigPath(baseDir = __dirname): string | null {
  for (const relative of ["../config.example.yaml", "../../config.example.yaml"]) {
    const candidate = join(baseDir, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function cmdAgentToken(): void {
  console.log(randomBytes(32).toString("hex"));
}

async function startConfiguredMode(explicitMode?: StartupMode): Promise<void> {
  const setup = await ensureFirstRunSetup();
  const mode = setup?.startupMode ?? explicitMode ?? loadConfig().startupMode;
  if (mode === "agent") {
    await runAgentServer();
    return;
  }
  await runDaemon();
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
      await startConfiguredMode();
      break;
    case "start":
    case "run":
    case "daemon":
    case "gateway":
    case "host":
      await startConfiguredMode("gateway");
      break;
    case "agent":
      await startConfiguredMode("agent");
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "bind":
      cmdBind();
      break;
    case "unbind":
      cmdUnbind();
      break;
    case "init":
      await cmdInitConfig(args.includes("--force"));
      break;
    case "agent-token":
      cmdAgentToken();
      break;
    case "notify-dispatch":
      await runNotifyDispatch(process.argv);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(`codex-wechat — 微信遥控本机/VPS Codex

用法:
  codex-wechat                 按首次配置保存的角色启动
  codex-wechat start|gateway  Host / Gateway：微信入口 + 路由
  codex-wechat host           Host / Gateway 的易懂别名
  codex-wechat agent          Agent：仅 HTTP 执行机（无微信）
  codex-wechat doctor         检查 codex / 绑定 / app-server
  codex-wechat bind           生成绑定码
  codex-wechat unbind         解除绑定
  codex-wechat init           首次配置向导
  codex-wechat init --force   重新运行向导并保留其它高级配置
  codex-wechat agent-token    生成 256-bit Agent token
  codex-wechat notify-dispatch <JSON>
                             接收 Codex notify 事件并分发完成通知

多机（同一微信）:
  - 只在一台机器 start（入口，扫码一次）
  - 其它机器 agent（配置 token，被入口 /m 切换）
  - 见 README「多机架构」

环境变量:
  CODEX_WECHAT_MACHINE, CODEX_WECHAT_CWD, CODEX_WECHAT_CODEX_PATH
  CODEX_WECHAT_CONFIG, CODEX_WECHAT_STATE
  CODEX_WECHAT_AGENT_HOST, CODEX_WECHAT_AGENT_PORT, CODEX_WECHAT_AGENT_TOKEN
`);
      break;
    default:
      console.error(`未知命令: ${cmd}（try help）`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
