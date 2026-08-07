import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function configWith(yaml: string) {
  const home = mkdtempSync(join(tmpdir(), "cw-config-"));
  const path = join(home, "config.yaml");
  writeFileSync(path, yaml);
  return () => loadConfig({ home, configPath: path });
}

describe("loadConfig validation", () => {
  it("defaults WeChat-driven Codex to read-only with on-request approval", () => {
    const config = configWith("default_cwd: ~/code\n")();
    assert.equal(config.codexSandboxMode, "read-only");
    assert.equal(config.codexApprovalPolicy, "on-request");
  });

  it("rejects home as an implicit workspace root", () => {
    assert.throws(
      configWith('default_cwd: "~"\n'),
      /不能直接指向 \$HOME/,
    );
  });

  it("rejects zero max_reply_chars", () => {
    assert.throws(
      configWith("default_cwd: ~/code\nmax_reply_chars: 0\n"),
      /max_reply_chars.*整数/,
    );
  });

  it("rejects malformed hosts and unknown defaults", () => {
    assert.throws(
      configWith("default_cwd: ~/code\nhosts:\n  - id: bad\n    type: ftp\n"),
      /type 只能是/,
    );
    assert.throws(
      configWith("default_cwd: ~/code\ndefault_host: missing\n"),
      /default_host 不存在/,
    );
  });

  it("rejects placeholder agent tokens", () => {
    assert.throws(
      configWith("default_cwd: ~/code\nagent:\n  token: change-me\n"),
      /agent\.token/,
    );
  });

  it("rejects invalid sandbox and approval policies", () => {
    assert.throws(
      configWith("default_cwd: ~/code\ncodex_sandbox_mode: root\n"),
      /codex_sandbox_mode 只能是/,
    );
    assert.throws(
      configWith("default_cwd: ~/code\ncodex_approval_policy: always\n"),
      /codex_approval_policy 只能是/,
    );
  });
});
