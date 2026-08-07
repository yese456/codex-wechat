/**
 * Minimal probe: initialize + thread/list via app-server.
 * Usage: npx tsx scripts/probe-codex.ts
 */
import { CodexClient } from "../src/codex/client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const client = new CodexClient({ command: config.codexBin });
console.log("codex:", client.getCommand());
const init = await client.initialize();
console.log("initialize:", init);
const threads = await client.listThreads({ limit: 5 });
console.log(
  "threads:",
  threads.map((t) => ({ id: t.id.slice(0, 8), cwd: t.cwd, preview: t.preview?.slice(0, 40) })),
);
await client.close();
