import { randomBytes } from "node:crypto";
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

type DeliveryRecord = {
  hostId: string;
  eventId: string;
  sentAt: string;
};

type DeliveryStoreData = {
  version: 1;
  sent: DeliveryRecord[];
};

export type CompletionDeliveryStoreOptions = {
  ackRetentionDays?: number;
  now?: () => number;
};

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseData(raw: unknown): DeliveryStoreData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("completion delivery 顶层必须是对象");
  }
  const data = raw as Partial<DeliveryStoreData>;
  if (data.version !== 1) {
    throw new Error(`completion delivery 版本不支持: ${String(data.version)}`);
  }
  if (!Array.isArray(data.sent)) {
    throw new Error("completion delivery sent 必须是数组");
  }
  const sent = data.sent.filter(
    (item): item is DeliveryRecord =>
      Boolean(
        item &&
          typeof item === "object" &&
          validString((item as DeliveryRecord).hostId) &&
          validString((item as DeliveryRecord).eventId) &&
          validString((item as DeliveryRecord).sentAt) &&
          Number.isFinite(Date.parse((item as DeliveryRecord).sentAt)),
      ),
  );
  if (sent.length !== data.sent.length) {
    throw new Error("completion delivery 包含无效 sent 记录");
  }
  return { version: 1, sent };
}

export class CompletionDeliveryStore {
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(
    readonly path: string,
    options: CompletionDeliveryStoreOptions = {},
  ) {
    this.retentionMs = (options.ackRetentionDays ?? 7) * 86_400_000;
    this.now = options.now ?? Date.now;
  }

  isSent(hostId: string, eventId: string): boolean {
    return this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      this.saveUnlocked(data);
      return data.sent.some(
        (record) => record.hostId === hostId && record.eventId === eventId,
      );
    });
  }

  markSent(hostId: string, eventId: string): void {
    this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      if (
        !data.sent.some(
          (record) => record.hostId === hostId && record.eventId === eventId,
        )
      ) {
        data.sent.push({
          hostId,
          eventId,
          sentAt: new Date(this.now()).toISOString(),
        });
      }
      this.saveUnlocked(data);
    });
  }

  private loadUnlocked(): DeliveryStoreData {
    if (!existsSync(this.path)) return { version: 1, sent: [] };
    try {
      return parseData(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      throw new Error(
        `completion delivery 文件损坏，已保留原文件，请修复或备份后移走: ${this.path}`,
        { cause: error },
      );
    }
  }

  private prune(data: DeliveryStoreData): void {
    const now = this.now();
    data.sent = data.sent.filter(
      (record) => now - Date.parse(record.sentAt) <= this.retentionMs,
    );
  }

  private saveUnlocked(data: DeliveryStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
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

  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    let lockFd: number | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (this.now() - statSync(lockPath).mtimeMs > 30_000) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        Atomics.wait(waitArray, 0, 0, 10);
      }
    }
    if (lockFd === null) throw new Error(`completion delivery 文件正忙: ${this.path}`);
    try {
      return fn();
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        // stale-lock cleanup may have removed it
      }
    }
  }
}
