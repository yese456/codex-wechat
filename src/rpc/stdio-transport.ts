import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, dirname, isAbsolute } from "node:path";
import type { Transport } from "./json-rpc.js";

const STDERR_TAIL_MAX_CHARS = 4096;
const STDOUT_BUFFER_MAX_CHARS = 8 * 1024 * 1024;

export function spawnEnvFor(
  command: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (typeof command !== "string" || !isAbsolute(command)) {
    return undefined;
  }
  const dir = dirname(command);
  const path = baseEnv.PATH ? `${dir}${delimiter}${baseEnv.PATH}` : dir;
  return { ...baseEnv, PATH: path };
}

export class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private messageHandler: ((message: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private buffer = "";
  private stderrTail = "";

  constructor(
    private readonly command: string,
    private readonly args: string[] = ["app-server", "--stdio"],
  ) {}

  async connect(): Promise<void> {
    if (this.child) return;

    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnvFor(this.command) ?? process.env,
    }) as ChildProcessWithoutNullStreams;

    this.stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          reject(
            new Error(
              `找不到 codex 可执行文件（${this.command}）。请安装 Codex CLI：npm i -g @openai/codex，或设置 CODEX_WECHAT_CODEX_PATH。`,
            ),
          );
        } else {
          reject(error);
        }
      });
    });

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.feed(chunk));
    const onGone = () => {
      if (this.child === child) this.child = null;
      this.closeHandler?.();
    };
    child.once("exit", onGone);
    child.once("error", onGone);
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > STDOUT_BUFFER_MAX_CHARS) {
      this.failProtocol("stdout 单帧超过 8 MiB，拒绝继续缓冲");
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (/^Content-Length\s*:/i.test(line)) {
        this.failProtocol(
          "检测到 Content-Length framing；当前版本只支持 Codex app-server 的 NDJSON framing",
        );
        return;
      }
      if (line) this.messageHandler?.(line);
    }
  }

  private failProtocol(message: string): void {
    this.stderrTail = (this.stderrTail + `\n[protocol] ${message}`).slice(
      -STDERR_TAIL_MAX_CHARS,
    );
    this.buffer = "";
    this.child?.kill();
  }

  send(message: string): void {
    if (!this.child) throw new Error("codex app-server 进程未连接");
    this.child.stdin.write(`${message}\n`);
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
