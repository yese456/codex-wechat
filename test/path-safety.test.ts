import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnderDir, resolveUnderRoot } from "../src/path-safety.js";
import {
  resolveDefaultCwd,
  resolveCwd,
  isPathAllowed,
  type AppConfig,
} from "../src/config.js";

describe("isUnderDir", () => {
  it("accepts self and children", () => {
    assert.equal(isUnderDir("/a/b", "/a/b"), true);
    assert.equal(isUnderDir("/a/b/c", "/a/b"), true);
  });
  it("rejects siblings and parents", () => {
    assert.equal(isUnderDir("/a/bc", "/a/b"), false);
    assert.equal(isUnderDir("/a", "/a/b"), false);
  });
});

describe("resolveUnderRoot", () => {
  it("allows files under root and blocks escape", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "f.txt"), "hi");
    const ok = resolveUnderRoot(join(root, "sub", "f.txt"), root);
    assert.equal(ok.ok, true);
    const bad = resolveUnderRoot(join(root, "..", "x"), root);
    assert.equal(bad.ok, false);
  });

  it("blocks symlink escape when possible", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-"));
    const outside = mkdtempSync(join(tmpdir(), "cw-out-"));
    writeFileSync(join(outside, "secret"), "x");
    try {
      symlinkSync(join(outside, "secret"), join(root, "link"));
    } catch {
      // skip on platforms without symlink perms
      return;
    }
    const r = resolveUnderRoot(join(root, "link"), root);
    assert.equal(r.ok, false);
  });
});

describe("resolveDefaultCwd", () => {
  it("never defaults to home itself", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-home-"));
    const { cwd, isFallback } = resolveDefaultCwd(home, undefined);
    assert.equal(isFallback, true);
    assert.notEqual(cwd, home);
    assert.ok(cwd.endsWith("code") || cwd.includes(`${home}/code`) || cwd.includes(`${home}\\code`));
  });

  it("rejects a fallback ~/code symlink to the full home", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-home-link-"));
    symlinkSync(home, join(home, "code"), "dir");
    assert.throws(() => resolveDefaultCwd(home, undefined), /符号链接/);
  });

  it("honors explicit cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-home-"));
    const proj = join(home, "proj");
    mkdirSync(proj);
    const { cwd, isFallback } = resolveDefaultCwd(home, proj);
    assert.equal(isFallback, false);
    assert.equal(cwd, proj);
  });
});

describe("isPathAllowed", () => {
  it("uses default_cwd when roots empty, not entire home", () => {
    const home = "/Users/someone";
    const config = {
      homeDir: home,
      defaultCwd: join(home, "code"),
      allowedRoots: [] as string[],
    } as AppConfig;
    assert.equal(isPathAllowed(join(home, "code", "a"), config), true);
    assert.equal(isPathAllowed(join(home, ".ssh", "id_rsa"), config), false);
  });
});

describe("resolveCwd", () => {
  it("rejects a directory symlink that escapes the policy root", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-root-"));
    const outside = mkdtempSync(join(tmpdir(), "cw-out-"));
    const link = join(root, "outside-link");
    try {
      symlinkSync(outside, link, "dir");
    } catch {
      return;
    }
    const config = {
      homeDir: root,
      defaultCwd: root,
      allowedRoots: [root],
    } as AppConfig;
    assert.throws(() => resolveCwd(link, config), /realpath|允许范围/);
  });

  it("returns the canonical directory path", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-root-"));
    const target = join(root, "project");
    const link = join(root, "project-link");
    mkdirSync(target);
    try {
      symlinkSync(target, link, "dir");
    } catch {
      return;
    }
    const config = {
      homeDir: root,
      defaultCwd: root,
      allowedRoots: [root],
    } as AppConfig;
    assert.equal(resolveCwd(link, config), realpathSync(target));
  });
});
