/**
 * Log all agent-related app-server notifications for one short turn.
 * Usage: npx tsx scripts/probe-turn.ts
 */
import { spawn } from "node:child_process";
import { resolveCodexCommand } from "../src/codex/resolve.js";

const cmd = resolveCodexCommand({});
const cwd = process.cwd();
const child = spawn(cmd, ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let id = 1;
const pending = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    t: NodeJS.Timeout;
  }
>();

function send(method: string, params?: unknown): Promise<unknown> {
  const reqId = id++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout " + method)), 120_000);
    pending.set(reqId, { resolve, reject, t });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n",
    );
  });
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.log("NONJSON", line.slice(0, 200));
      continue;
    }
    if (
      msg.id != null &&
      (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))
    ) {
      const p = pending.get(msg.id as number);
      if (p) {
        clearTimeout(p.t);
        pending.delete(msg.id as number);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }
      continue;
    }
    const m = String(msg.method ?? "");
    if (
      m.includes("agentMessage") ||
      m.includes("agent_message") ||
      m.includes("turn/") ||
      m.includes("item/") ||
      m === "error" ||
      m.includes("Message")
    ) {
      console.log("<<", m, JSON.stringify(msg).slice(0, 800));
    } else if (msg.id != null && msg.method) {
      console.log("<< SERVER_REQ", m, JSON.stringify(msg.params).slice(0, 200));
      const isExec =
        m.includes("execCommand") || m === "applyPatchApproval";
      const result = isExec
        ? { decision: "denied" }
        : m.includes("requestApproval") || m.includes("Approval")
          ? { decision: "decline" }
          : null;
      if (result) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
        );
      } else {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "no" },
          }) + "\n",
        );
      }
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (c: string) => {
  if (c.trim()) process.stderr.write(`[stderr] ${c.slice(0, 300)}\n`);
});

async function main() {
  console.log("codex:", cmd);
  await send("initialize", {
    clientInfo: { name: "probe", title: "probe", version: "0.1.0" },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [],
    },
  });
  console.log("init ok");
  const started = (await send("thread/start", {
    cwd,
    approvalsReviewer: "user",
  })) as { thread?: { id: string }; id?: string };
  const threadId = started.thread?.id || started.id;
  console.log("thread", threadId);
  const turn = await send("turn/start", {
    threadId,
    input: [{ type: "text", text: "只回复一个英文单词：pong", text_elements: [] }],
    cwd,
    approvalsReviewer: "user",
  });
  console.log("turn/start result keys", Object.keys((turn as object) ?? {}));
  // Wait for notifications
  await new Promise((r) => setTimeout(r, 60_000));
  child.kill();
}

main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
