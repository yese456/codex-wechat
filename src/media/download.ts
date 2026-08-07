import type { IncomingMessage, WeChatBot } from "@wechatbot/wechatbot";
import { saveAttachment } from "./save.js";
import type { Attachment, AttachmentKind } from "./types.js";

/**
 * Download all media items from a WeChat message into inboxRoot.
 */
export async function downloadMessageAttachments(
  bot: WeChatBot,
  msg: IncomingMessage,
  opts: {
    inboxRoot: string;
    maxBytes: number;
    maxCount: number;
    maxTotalBytes: number;
    maxInboxBytes: number;
  },
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  let totalBytes = 0;
  const save = (
    data: Buffer,
    fileName: string,
    kind: AttachmentKind,
  ): Attachment => {
    if (out.length >= opts.maxCount) {
      throw new Error(`附件数量超过上限 (${opts.maxCount})`);
    }
    totalBytes += data.length;
    if (totalBytes > opts.maxTotalBytes) {
      throw new Error(`附件总大小超过上限 (${opts.maxTotalBytes} bytes)`);
    }
    return saveAttachment({
      data,
      fileName,
      kind,
      inboxRoot: opts.inboxRoot,
      maxBytes: opts.maxBytes,
      maxInboxBytes: opts.maxInboxBytes,
    });
  };

  for (const [i, img] of (msg.images ?? []).entries()) {
    if (!img.media) continue;
    const data = await bot.downloadRaw(img.media, img.aeskey);
    out.push(save(data, `image-${i + 1}.jpg`, "image"));
  }

  for (const [i, file] of (msg.files ?? []).entries()) {
    if (!file.media) continue;
    const data = await bot.downloadRaw(file.media);
    const name = file.fileName || `file-${i + 1}.bin`;
    out.push(save(data, name, "file"));
  }

  for (const [i, video] of (msg.videos ?? []).entries()) {
    if (!video.media) continue;
    const data = await bot.downloadRaw(video.media);
    out.push(save(data, `video-${i + 1}.mp4`, "video"));
  }

  // Voice: best-effort via bot.download (may transcode to wav)
  if ((msg.voices?.length ?? 0) > 0 && out.length === 0 && msg.type === "voice") {
    const media = await bot.download(msg);
    if (media) {
      const kind: AttachmentKind = "voice";
      const ext = media.format === "wav" ? "wav" : "silk";
      out.push(save(media.data, media.fileName || `voice.${ext}`, kind));
    }
  }

  // Fallback: single download() if type is media but arrays empty (defensive)
  if (out.length === 0 && msg.type !== "text") {
    const media = await bot.download(msg);
    if (media) {
      out.push(
        save(
          media.data,
          media.fileName ||
            (media.type === "image"
              ? "image.jpg"
              : media.type === "video"
                ? "video.mp4"
                : "file.bin"),
          media.type,
        ),
      );
    }
  }

  return out;
}
