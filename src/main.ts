import { loadConfig, ensureDataDirs } from "./config.js";
import { StateStore } from "./state.js";
import { CodexClient } from "./codex/client.js";
import { MessageHandler } from "./handler.js";
import { ApprovalBridge } from "./approvals.js";
import { startWechatBot } from "./wechat/bot.js";
import { HostRegistry } from "./hosts/registry.js";
import { startCompletionWorker } from "./completions/worker.js";

/** Gateway mode: WeChat entry + optional multi-host routing. */
export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  ensureDataDirs(config);

  console.log(`[codex-wechat] mode=gateway machine=${config.machineName}`);
  console.log(`[codex-wechat] state=${config.statePath}`);
  console.log(`[codex-wechat] default_cwd=${config.defaultCwd}`);
  console.log(
    `[codex-wechat] configured sandbox=${config.codexSandboxMode} approval=${config.codexApprovalPolicy}`,
  );
  if (config.defaultCwdIsFallback) {
    console.warn(
      "[codex-wechat] 未配置 default_cwd，已使用 ~/code。请编辑 config.yaml。",
    );
  }
  if (config.hosts.length > 0) {
    console.log(
      `[codex-wechat] hosts=${config.hosts.map((h) => `${h.id}:${h.type}`).join(", ")}`,
    );
  } else {
    console.log("[codex-wechat] hosts 未配置 → 单机 local");
  }

  const state = new StateStore(config.statePath, config.defaultCwd);
  const startupState = state.load();
  if (!startupState.cwd) {
    state.update({ cwd: config.defaultCwd });
  }
  const sandboxMode =
    startupState.codexSandboxMode ?? config.codexSandboxMode;
  const approvalPolicy =
    startupState.codexApprovalPolicy ?? config.codexApprovalPolicy;
  console.log(
    `[codex-wechat] effective sandbox=${sandboxMode} approval=${approvalPolicy}`,
  );

  const codex = new CodexClient({
    command: config.codexBin,
    sandboxMode,
    approvalPolicy,
  });
  console.log(`[codex-wechat] codex_bin=${codex.getCommand()}`);

  const needsLocalCodex =
    config.hosts.length === 0 || config.hosts.some((host) => host.type === "local");
  if (needsLocalCodex) {
    try {
      await codex.initialize();
      console.log("[codex-wechat] local app-server connected");
    } catch (err) {
      console.warn(
        "[codex-wechat] local app-server 暂未连上:",
        (err as Error).message,
      );
    }
  } else {
    console.log("[codex-wechat] 纯 remote gateway，跳过本地 app-server");
  }

  const hosts = new HostRegistry(config, state, codex);
  const handler = new MessageHandler(config, state, hosts);

  const wechat = await startWechatBot({
    storageDir: config.wechatStorageDir,
    handler,
    maxReplyChars: config.maxReplyChars,
    maxMediaBytes: config.maxMediaBytes,
    maxAttachmentCount: config.maxAttachmentCount,
    maxAttachmentTotalBytes: config.maxAttachmentTotalBytes,
    inboxMaxBytes: config.inboxMaxBytes,
  });

  const completionWorker = startCompletionWorker({
    config,
    hosts: hosts.list(),
    getUserId: () => state.load().allowUserId || null,
    sendToUser: wechat.sendToUser,
  });

  // Local approvals → WeChat (remote agents poll via HttpHost hooks)
  const localCodex = hosts.localCodexClient();
  const localHost = hosts.localHost();
  const approvals =
    localCodex && localHost
      ? new ApprovalBridge(
          localCodex,
          config.approvalTimeoutSec,
          async (approval) => {
            const userId = state.load().allowUserId;
            if (!userId) {
              console.warn("有审批但尚无绑定用户:", approval.shortCode);
              return;
            }
            const body = [
              `⏳ 需要审批 (host=${localHost.id})`,
              approval.summary,
              "",
              `回复 /ok 同意，/no 拒绝（超时 ${config.approvalTimeoutSec}s 自动拒绝）`,
            ].join("\n");
            await wechat.sendToUser(userId, body);
          },
        )
      : null;
  approvals?.attach();

  // Connection notices without breaking ApprovalBridge chain
  if (localCodex) {
    const prev = localCodex.onEvent;
    localCodex.onEvent = (ev) => {
      prev?.(ev);
      if (ev.type === "connectionGaveUp") {
        const userId = state.load().allowUserId || wechat.lastUserId;
        if (userId) {
          void wechat.sendToUser(
            userId,
            "⚠️ 本地 Codex 连接失败，正在后台重试。/status 查看。",
          );
        }
      }
      if (ev.type === "reconnected") {
        const userId = state.load().allowUserId || wechat.lastUserId;
        if (userId) {
          void wechat.sendToUser(userId, "✅ 本地 Codex 已重新连接");
        }
      }
    };
  }

  if (!state.load().allowUserId) {
    console.log(
      "\n尚未绑定微信。运行 `npx tsx src/cli.ts bind` 生成绑定码。\n",
    );
  } else {
    console.log(
      `[codex-wechat] 已绑定用户 ${state.load().allowUserId.slice(0, 8)}…`,
    );
  }
  console.log(
    `[codex-wechat] 当前 host=${hosts.current().id}  可用 /hosts /m 切换`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在退出…`);
    await completionWorker.stop();
    approvals?.dispose();
    await codex.close().catch(() => {});
    try {
      wechat.bot.stop();
      await wechat.runPromise.catch(() => {});
    } catch {
      // ignore
    }
    process.exit(exitCode);
  };
  void wechat.runPromise.then(
    () => {
      if (shuttingDown) return;
      console.error("[wechat] 长轮询意外停止且未返回错误");
      void shutdown("WECHAT_POLL_STOPPED", 1);
    },
    (error) => {
      if (shuttingDown) return;
      console.error("[wechat] 长轮询意外停止:", error);
      void shutdown("WECHAT_POLL_STOPPED", 1);
    },
  );
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isDirect =
  process.argv[1] != null &&
  (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("main.js"));
if (isDirect) {
  runDaemon().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
