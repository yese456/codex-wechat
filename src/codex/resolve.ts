import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve codex binary. Override env wins. Then common install locations, then PATH name.
 */
export function resolveCodexCommand(opts: {
  override?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (p: string) => boolean;
} = {}): string {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();

  const override =
    opts.override?.trim() ||
    env.CODEX_WECHAT_CODEX_PATH?.trim() ||
    env.CODEX_PATH?.trim() ||
    "";
  if (override) return override;

  const candidates: string[] = [];

  // Prefer CLI next to current node (nvm/fnm/volta global install) over GUI app bundles
  const nodeDir = process.execPath ? join(process.execPath, "..") : "";
  if (nodeDir) {
    candidates.push(
      join(nodeDir, platform === "win32" ? "codex.cmd" : "codex"),
      join(nodeDir, "codex"),
    );
  }

  candidates.push(
    join(home, ".local/bin/codex"),
    join(home, ".npm-global/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  );

  // Desktop app bundles as last resort (version may differ from CLI)
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      join(home, "Applications/Codex.app/Contents/Resources/codex"),
    );
  }

  for (const c of candidates) {
    if (c && exists(c)) return c;
  }

  return "codex";
}
