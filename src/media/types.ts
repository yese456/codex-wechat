export type AttachmentKind = "image" | "file" | "video" | "voice";

export type Attachment = {
  kind: AttachmentKind;
  /** Absolute path on disk after download. */
  path: string;
  fileName: string;
  size: number;
  /** MIME if known */
  mime?: string;
};

/** Outbound reply channel (text + optional media). */
export type ReplyChannel = {
  text: (s: string) => Promise<void>;
  image: (buf: Buffer, caption?: string) => Promise<void>;
  file: (buf: Buffer, fileName: string) => Promise<void>;
};

export type IncomingPayload = {
  text: string;
  attachments: Attachment[];
};
