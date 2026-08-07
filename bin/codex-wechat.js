#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distCli = join(root, "dist", "src", "cli.js");
const srcCli = join(root, "src", "cli.ts");

if (existsSync(distCli)) {
  await import(pathToFileURL(distCli).href);
} else {
  // Dev / npm link without build: run via tsx if available
  try {
    await import("tsx/esm");
    await import(pathToFileURL(srcCli).href);
  } catch {
    console.error(
      "codex-wechat: run `npm run build` first, or use `npx tsx src/cli.ts <cmd>`",
    );
    process.exit(1);
  }
}
