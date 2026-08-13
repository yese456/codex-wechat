import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  normalizeProjectPath,
  renderInitialConfig,
  setupConfigPath,
  writeInitialConfig,
} from "../src/setup.js";
import { loadConfig } from "../src/config.js";

describe("first-run setup", () => {
  it("writes role, project root, sandbox and a stable agent token", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-setup-"));
    const configPath = join(home, ".codex-wechat", "config.yaml");
    const defaultCwd = join(home, "projects");

    writeInitialConfig(configPath, {
      startupMode: "agent",
      defaultCwd,
      sandboxMode: "workspace-write",
    });

    const first = parseYaml(readFileSync(configPath, "utf8")) as {
      startup_mode: string;
      default_cwd: string;
      allowed_roots: string[];
      codex_sandbox_mode: string;
      agent: { token: string };
    };
    assert.equal(first.startup_mode, "agent");
    assert.equal(first.default_cwd, defaultCwd);
    assert.deepEqual(first.allowed_roots, [defaultCwd]);
    assert.equal(first.codex_sandbox_mode, "workspace-write");
    assert.match(first.agent.token, /^[0-9a-f]{64}$/);

    const loaded = loadConfig({ home, configPath });
    assert.equal(loaded.startupMode, "agent");
    assert.equal(loaded.defaultCwd, defaultCwd);
    assert.equal(loaded.agentToken, first.agent.token);
  });

  it("rejects symlink aliases to the full home or filesystem root", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-setup-root-"));
    const normal = join(home, "project");
    mkdirSync(normal);
    assert.equal(normalizeProjectPath(normal, home), realpathSync(normal));

    const homeLink = join(home, "home-link");
    symlinkSync(home, homeLink, "dir");
    assert.throws(() => normalizeProjectPath(homeLink, home), /主目录或文件系统根目录/);
  });

  it("preserves advanced configuration when re-running setup", () => {
    const text = renderInitialConfig(
      {
        startupMode: "gateway",
        defaultCwd: "/srv/projects",
        sandboxMode: "read-only",
      },
      {
        max_reply_chars: 2000,
        allowed_roots: ["/srv/projects", "/srv/shared"],
        codex_approval_policy: "never",
        hosts: [{ id: "mac", type: "http", url: "http://127.0.0.1:18765" }],
        agent: { token: "a".repeat(64), port: 19000 },
      },
    );
    const parsed = parseYaml(text) as {
      max_reply_chars: number;
      allowed_roots: string[];
      codex_approval_policy: string;
      hosts: unknown[];
      agent: { token: string; port: number };
    };
    assert.equal(parsed.max_reply_chars, 2000);
    assert.deepEqual(parsed.allowed_roots, ["/srv/projects", "/srv/shared"]);
    assert.equal(parsed.codex_approval_policy, "never");
    assert.equal(parsed.hosts.length, 1);
    assert.equal(parsed.agent.token, "a".repeat(64));
    assert.equal(parsed.agent.port, 19000);
  });

  it("honors CODEX_WECHAT_CONFIG as the setup target", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-setup-path-"));
    const original = process.env.CODEX_WECHAT_CONFIG;
    process.env.CODEX_WECHAT_CONFIG = "~/custom/config.yaml";
    try {
      assert.equal(setupConfigPath(home), join(home, "custom", "config.yaml"));
    } finally {
      if (original === undefined) delete process.env.CODEX_WECHAT_CONFIG;
      else process.env.CODEX_WECHAT_CONFIG = original;
    }
  });
});
