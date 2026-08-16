import { WeChatBot, type IncomingMessage } from "@wechatbot/wechatbot";
import type { MessageHandler } from "../handler.js";
import { splitText } from "../text.js";
import { downloadMessageAttachments } from "../media/download.js";
import type { ReplyChannel } from "../media/types.js";

export type WechatRuntime = {
  bot: WeChatBot;
  /** Long-poll loop; resolves only after stop or a fatal polling failure. */
  runPromise: Promise<void>;
  /** Last peer we can push notifications to (approvals). */
  lastUserId: string | null;
  sendToUser: (userId: string, text: string) => Promise<void>;
};

function makeReplyChannel(
  bot: WeChatBot,
  msg: IncomingMessage,
  maxReplyChars: number,
): ReplyChannel {
  return {
    text: async (s: string) => {
      const chunks = splitText(s, maxReplyChars);
      for (const chunk of chunks) {
        await bot.reply(msg, chunk);
      }
    },
    image: async (buf: Buffer, caption?: string) => {
      await bot.reply(msg, { image: buf, caption });
    },
    file: async (buf: Buffer, fileName: string) => {
      await bot.reply(msg, { file: buf, fileName });
    },
  };
}

export async function startWechatPolling(
  bot: WeChatBot,
): Promise<{ runPromise: Promise<void> }> {
  const runPromise = bot.start();
  await new Promise<void>((resolve, reject) => {
    const onStarted = () => {
      cleanup();
      resolve();
    };
    const onStopped = () => {
      cleanup();
      reject(new Error("微信长轮询在启动完成前停止"));
    };
    const cleanup = () => {
      bot.off("poll:start", onStarted);
      bot.off("poll:stop", onStopped);
    };
    bot.on("poll:start", onStarted);
    bot.on("poll:stop", onStopped);
    if (bot.isRunning) onStarted();
    void runPromise.catch((error) => {
      cleanup();
      reject(error);
    });
  });
  return { runPromise };
}

export async function startWechatBot(opts: {
  storageDir: string;
  handler: MessageHandler;
  maxReplyChars: number;
  maxMediaBytes: number;
  maxAttachmentCount: number;
  maxAttachmentTotalBytes: number;
  inboxMaxBytes: number;
}): Promise<WechatRuntime> {
  const bot = new WeChatBot({
    storageDir: opts.storageDir,
    logLevel: "info",
    botAgent: "CodexWeChat/0.1",
    loginCallbacks: {
      onQrUrl: (url: string) => {
        console.log("\n========== 请用微信扫描二维码登录 iLink ==========");
        console.log(url);
        console.log("================================================\n");
      },
      onScanned: () => console.log("已扫码，请在手机上确认…"),
      onExpired: () => console.warn("二维码已过期，将刷新…"),
    },
  });

  let lastUserId: string | null = null;
  let lastMsg: IncomingMessage | null = null;

  const sendToUser = async (userId: string, text: string) => {
    const chunks = splitText(text, opts.maxReplyChars);
    for (const chunk of chunks) {
      if (lastMsg && lastMsg.userId === userId) {
        await bot.reply(lastMsg, chunk);
      } else {
        await bot.send(userId, chunk);
      }
    }
  };

  const handleSafely = async (
    userId: string,
    payload: Parameters<MessageHandler["handle"]>[1],
    reply: ReplyChannel,
  ): Promise<void> => {
    try {
      await opts.handler.handle(userId, payload, reply);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      console.error(`[wechat] handler failed user=${userId.slice(0, 12)}:`, message);
      await reply.text("❌ 处理消息失败，请稍后重试；可用 /status 检查连接状态");
    }
  };

  bot.onMessage(async (msg: IncomingMessage) => {
    const userId = msg.userId;
    // Placeholder text like [image] from SDK — treat as empty caption
    let text = (msg.text ?? "").trim();
    if (/^\[(image|file|video|voice|图片|文件|视频|语音)\]$/i.test(text)) {
      text = "";
    }

    if (!userId) {
      console.warn("收到无 userId 的消息，已忽略");
      return;
    }

    lastUserId = userId;
    lastMsg = msg;
    const reply = makeReplyChannel(bot, msg, opts.maxReplyChars);

    // Commands without media
    if (text.startsWith("/")) {
      try {
        await bot.sendTyping(userId);
      } catch {
        /* optional */
      }
      await handleSafely(
        userId,
        { text, attachments: [] },
        reply,
      );
      return;
    }

    // Download media if present
    let attachments: Awaited<
      ReturnType<typeof downloadMessageAttachments>
    > = [];
    const hasMedia =
      msg.type !== "text" ||
      (msg.images?.length ?? 0) > 0 ||
      (msg.files?.length ?? 0) > 0 ||
      (msg.videos?.length ?? 0) > 0 ||
      (msg.voices?.length ?? 0) > 0;

    if (hasMedia) {
      if (!opts.handler.isAllowed(userId)) {
        await reply.text(
          `未授权。\n1) 本机运行: codex-wechat bind\n2) 微信发送: /bind <终端显示的码>`,
        );
        return;
      }
      try {
        await bot.sendTyping(userId);
        attachments = await downloadMessageAttachments(bot, msg, {
          inboxRoot: opts.handler.inboxRoot(),
          maxBytes: opts.maxMediaBytes,
          maxCount: opts.maxAttachmentCount,
          maxTotalBytes: opts.maxAttachmentTotalBytes,
          maxInboxBytes: opts.inboxMaxBytes,
        });
        if (attachments.length === 0) {
          await reply.text("未能下载附件（可能已过期或不支持该类型）");
          return;
        }
        console.log(
          `[media] saved ${attachments.length}:`,
          attachments.map((a) => a.path).join(", "),
        );
      } catch (err) {
        await reply.text(`下载附件失败: ${(err as Error).message}`);
        return;
      }
    }

    if (!text && attachments.length === 0) {
      return;
    }

    try {
      await bot.sendTyping(userId);
    } catch {
      /* optional */
    }

    await handleSafely(
      userId,
      { text, attachments },
      reply,
    );
  });

  // QR poll can hit HTTP TimeoutError if the code isn't scanned quickly enough.
  // Keep re-requesting QR until login succeeds (Ctrl+C to stop).
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.login({ force: attempt > 1 });
      break;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      const name = (err as { name?: string })?.name ?? "";
      const retryable =
        name === "TimeoutError" ||
        name === "AbortError" ||
        /timeout|timed out|QR code expired|login aborted/i.test(msg);
      if (!retryable) throw err;
      console.warn(
        `[wechat] 登录未完成（${msg.slice(0, 80)}），5s 后重新出码 (第 ${attempt} 次)…`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const { runPromise } = await startWechatPolling(bot);
  console.log("微信长轮询已启动（支持文本 / 图片 / 文件）");

  return {
    bot,
    runPromise,
    get lastUserId() {
      return lastUserId;
    },
    set lastUserId(v: string | null) {
      lastUserId = v;
    },
    sendToUser,
  };
}
