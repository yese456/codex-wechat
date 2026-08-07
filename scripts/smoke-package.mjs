import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const tempHome = mkdtempSync(join(tmpdir(), "codex-wechat-smoke-"));
try {
  const cli = resolve("dist/src/cli.js");
  const result = spawnSync(process.execPath, [cli, "init"], {
    env: { ...process.env, HOME: tempHome, CODEX_WECHAT_CONFIG: "" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "built CLI init failed");
  }
  const config = readFileSync(
    join(tempHome, ".codex-wechat", "config.yaml"),
    "utf8",
  );
  if (!/^default_cwd:\s*~\/code\s*$/m.test(config)) {
    throw new Error("built CLI init did not preserve the safe ~/code default");
  }
  if (!config.includes("max_attachment_count")) {
    throw new Error("built CLI init used fallback text instead of packaged example");
  }
  console.log("package smoke OK: built init uses packaged config.example.yaml");
} finally {
  if (tempHome.startsWith(`${tmpdir()}/codex-wechat-smoke-`)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
}
