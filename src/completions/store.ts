import { createHash, randomBytes } from "node:crypto";
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
import type { CompletionEvent } from "./types.js";

type Tombstone = { id: string; ackedAt: string };
type SuppressionMarker = {
  threadId: string;
  inputHash: string;
  expiresAt: string;
};

type CompletionStoreData = {
  version: 1;
  events: CompletionEvent[];
  tombstones: Tombstone[];
  suppressions: SuppressionMarker[];
};

export type CompletionStoreOptions = {
  ackRetentionDays?: number;
  now?: () => number;
};

const EMPTY: CompletionStoreData = {
  version: 1,
  events: [],
  tombstones: [],
  suppressions: [],
};

export function completionEventId(threadId: string, turnId: string): string {
  return createHash("sha256").update(`${threadId}\0${turnId}`).digest("hex");
}

export function truncateSummary(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

export function summaryHash(summary: string): string {
  return createHash("sha256").update(summary).digest("hex");
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validEvent(value: unknown): value is CompletionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<CompletionEvent>;
  return (
    validString(event.id) &&
    validString(event.threadId) &&
    validString(event.turnId) &&
    validString(event.cwd) &&
    typeof event.requestSummary === "string" &&
    typeof event.resultSummary === "string" &&
    validString(event.createdAt) &&
    Number.isFinite(Date.parse(event.createdAt))
  );
}

function parseData(raw: unknown): CompletionStoreData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("completion outbox 顶层必须是对象");
  }
  const data = raw as Partial<CompletionStoreData>;
  if (data.version !== 1) {
    throw new Error(`completion outbox 版本不支持: ${String(data.version)}`);
  }
  if (!Array.isArray(data.events)) {
    throw new Error("completion outbox events 必须是数组");
  }
  if (!Array.isArray(data.tombstones)) {
    throw new Error("completion outbox tombstones 必须是数组");
  }
  if (!Array.isArray(data.suppressions)) {
    throw new Error("completion outbox suppressions 必须是数组");
  }
  const events = data.events.filter(validEvent);
  const tombstones = data.tombstones.filter(
    (item): item is Tombstone =>
      Boolean(
        item &&
          typeof item === "object" &&
          validString((item as Tombstone).id) &&
          validString((item as Tombstone).ackedAt) &&
          Number.isFinite(Date.parse((item as Tombstone).ackedAt)),
      ),
  );
  const suppressions = data.suppressions.filter(
    (item): item is SuppressionMarker =>
      Boolean(
        item &&
          typeof item === "object" &&
          validString((item as SuppressionMarker).threadId) &&
          validString((item as SuppressionMarker).inputHash) &&
          validString((item as SuppressionMarker).expiresAt) &&
          Number.isFinite(Date.parse((item as SuppressionMarker).expiresAt)),
      ),
  );
  if (events.length !== data.events.length) {
    throw new Error("completion outbox 包含无效事件");
  }
  if (tombstones.length !== data.tombstones.length) {
    throw new Error("completion outbox 包含无效 tombstone");
  }
  if (suppressions.length !== data.suppressions.length) {
    throw new Error("completion outbox 包含无效 suppression marker");
  }
  return { version: 1, events, tombstones, suppressions };
}

export class CompletionStore {
  private readonly ackRetentionMs: number;
  private readonly now: () => number;

  constructor(
    readonly path: string,
    options: CompletionStoreOptions = {},
  ) {
    this.ackRetentionMs = (options.ackRetentionDays ?? 7) * 86_400_000;
    this.now = options.now ?? Date.now;
  }

  enqueue(event: CompletionEvent): boolean {
    return this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      if (
        data.events.some((item) => item.id === event.id) ||
        data.tombstones.some((item) => item.id === event.id)
      ) {
        this.saveUnlocked(data);
        return false;
      }
      data.events.push(event);
      data.events.sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
      );
      this.saveUnlocked(data);
      return true;
    });
  }

  poll(limit: number): CompletionEvent[] {
    return this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      this.saveUnlocked(data);
      return data.events.slice(0, limit);
    });
  }

  ack(ids: string[]): void {
    this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      const wanted = new Set(ids);
      const ackedIds = data.events
        .filter((event) => wanted.has(event.id))
        .map((event) => event.id);
      data.events = data.events.filter((event) => !wanted.has(event.id));
      const existing = new Set(data.tombstones.map((item) => item.id));
      const ackedAt = new Date(this.now()).toISOString();
      for (const id of ackedIds) {
        if (!existing.has(id)) data.tombstones.push({ id, ackedAt });
      }
      this.saveUnlocked(data);
    });
  }

  markSuppression(
    threadId: string,
    inputSummary: string,
    ttlMs = 60 * 60 * 1000,
  ): void {
    this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      const inputHash = summaryHash(inputSummary);
      data.suppressions = data.suppressions.filter(
        (marker) =>
          marker.threadId !== threadId || marker.inputHash !== inputHash,
      );
      data.suppressions.push({
        threadId,
        inputHash,
        expiresAt: new Date(this.now() + ttlMs).toISOString(),
      });
      this.saveUnlocked(data);
    });
  }

  consumeSuppression(threadId: string, inputSummary: string): boolean {
    return this.withLock(() => {
      const data = this.loadUnlocked();
      this.prune(data);
      const inputHash = summaryHash(inputSummary);
      const index = data.suppressions.findIndex(
        (marker) =>
          marker.threadId === threadId && marker.inputHash === inputHash,
      );
      if (index < 0) {
        this.saveUnlocked(data);
        return false;
      }
      data.suppressions.splice(index, 1);
      this.saveUnlocked(data);
      return true;
    });
  }

  private loadUnlocked(): CompletionStoreData {
    if (!existsSync(this.path)) return { ...EMPTY, events: [], tombstones: [], suppressions: [] };
    try {
      return parseData(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (err) {
      throw new Error(
        `completion outbox 损坏，已保留原文件，请修复或备份后移走: ${this.path}`,
        { cause: err },
      );
    }
  }

  private prune(data: CompletionStoreData): void {
    const now = this.now();
    data.tombstones = data.tombstones.filter(
      (item) => now - Date.parse(item.ackedAt) <= this.ackRetentionMs,
    );
    data.suppressions = data.suppressions.filter(
      (item) => Date.parse(item.expiresAt) > now,
    );
  }

  private saveUnlocked(data: CompletionStoreData): void {
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
    if (lockFd === null) throw new Error(`completion outbox 正忙: ${this.path}`);
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
