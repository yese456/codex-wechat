import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temp = mkdtempSync(join(tmpdir(), "codex-wechat-tarball-"));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: temp,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
};

try {
  run(
    "npm",
    ["pack", process.cwd(), "--pack-destination", temp, "--silent"],
    {
      env: {
        ...process.env,
        npm_config_cache: join(temp, "npm-cache"),
      },
    },
  );
  const filename = readdirSync(temp).find((name) => name.endsWith(".tgz"));
  if (!filename) throw new Error("npm pack did not create a tarball");
  const tarball = join(temp, filename);
  run("tar", ["-xzf", tarball]);
  const packageRoot = join(temp, "package");
  for (const required of [
    "dist/src/cli.js",
    "config.example.yaml",
    "scripts/patch-wechatbot.mjs",
  ]) {
    if (!existsSync(join(packageRoot, required))) {
      throw new Error(`tarball missing required asset: ${required}`);
    }
  }
  // Supply the repository's already-installed locked dependencies without
  // requiring network access in the packaging smoke test.
  symlinkSync(join(process.cwd(), "node_modules"), join(packageRoot, "node_modules"), "dir");

  const fakeHome = join(temp, "home");
  run(process.execPath, [join(packageRoot, "dist/src/cli.js"), "init"], {
    env: { ...process.env, HOME: fakeHome, CODEX_WECHAT_CONFIG: "" },
  });
  const generated = readFileSync(
    join(fakeHome, ".codex-wechat", "config.yaml"),
    "utf8",
  );
  if (!/^default_cwd:\s*~\/code\s*$/m.test(generated)) {
    throw new Error("tarball CLI init did not use the safe ~/code default");
  }
  console.log("tarball smoke OK: required assets and built init verified");
} finally {
  if (temp.startsWith(`${tmpdir()}/codex-wechat-tarball-`)) {
    rmSync(temp, { recursive: true, force: true });
  }
}
