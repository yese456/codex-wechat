import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type { Attachment, AttachmentKind } from "./types.js";

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
]);

export function isImageFileName(name: string): boolean {
  return IMAGE_EXT.has(extname(name).toLowerCase());
}

function safeName(name: string): string {
  const base = basename(name || "file").replace(/[^\w.\-()+@\u4e00-\u9fff]+/g, "_");
  return base.slice(0, 120) || "file";
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Save a buffer under inboxRoot / <stamp> / <name>.
 * Prefer project cwd inbox so Codex sandbox can read the path.
 */
export function saveAttachment(opts: {
  data: Buffer;
  fileName: string;
  kind: AttachmentKind;
  /** e.g. {cwd}/.codex-wechat-inbox */
  inboxRoot: string;
  maxBytes: number;
  /** Reject new files once the inbox reaches this size. */
  maxInboxBytes?: number;
}): Attachment {
  if (opts.data.length > opts.maxBytes) {
    throw new Error(
      `文件过大: ${opts.fileName} (${opts.data.length} > ${opts.maxBytes} bytes)`,
    );
  }
  if (opts.maxInboxBytes !== undefined) {
    const current = directorySize(opts.inboxRoot);
    if (current + opts.data.length > opts.maxInboxBytes) {
      throw new Error(
        `附件收件箱已达配额 (${current} + ${opts.data.length} > ${opts.maxInboxBytes} bytes)，请清理 ${opts.inboxRoot}`,
      );
    }
  }
  const dir = join(opts.inboxRoot, stamp());
  mkdirSync(dir, { recursive: true });
  let name = safeName(opts.fileName);
  if (!extname(name)) {
    if (opts.kind === "image") name += ".png";
    else if (opts.kind === "video") name += ".mp4";
    else if (opts.kind === "voice") name += ".wav";
  }
  // avoid overwrite within same second
  let path = join(dir, name);
  let i = 1;
  while (true) {
    try {
      writeFileSync(path, opts.data, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const e = extname(name);
      const stem = e ? name.slice(0, -e.length) : name;
      path = join(dir, `${stem}-${i}${e}`);
      i += 1;
    }
  }
  return {
    kind: opts.kind,
    path,
    fileName: basename(path),
    size: opts.data.length,
  };
}

export function directorySize(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        total += lstatSync(path).size;
      }
    }
  }
  return total;
}

export function inboxRootForCwd(cwd: string): string {
  return join(cwd, ".codex-wechat-inbox");
}

/** Build text for Codex describing non-image files (and context). */
export function buildAttachmentPrompt(
  userText: string,
  attachments: Attachment[],
): { text: string; imagePaths: string[] } {
  const imagePaths: string[] = [];
  const fileLines: string[] = [];

  for (const a of attachments) {
    if (a.kind === "image" || isImageFileName(a.fileName)) {
      imagePaths.push(a.path);
    } else {
      fileLines.push(
        `- ${a.fileName} (${a.kind}, ${a.size} bytes)\n  path: ${a.path}`,
      );
    }
  }

  const parts: string[] = [];
  if (userText.trim()) {
    parts.push(userText.trim());
  }
  if (imagePaths.length > 0 && !userText.trim()) {
    parts.push(`用户通过微信发送了 ${imagePaths.length} 张图片，请查看并处理。`);
  }
  if (fileLines.length > 0) {
    parts.push(
      [
        "用户通过微信发送了以下文件（已保存在本机，路径可直接读取）：",
        ...fileLines,
        "请根据文件内容完成用户的请求；若用户未说明用途，请先简述文件内容再询问下一步。",
      ].join("\n"),
    );
  }
  if (parts.length === 0) {
    parts.push("（用户发送了附件）");
  }

  return { text: parts.join("\n\n"), imagePaths };
}
