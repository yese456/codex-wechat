import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { AppConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { LocalHost } from "../src/hosts/local-host.js";
import { CompletionStore } from "../src/completions/store.js";

function createHost(options: {
  root: string;
  cwd: string;
  allowedRoots?: string[];
}): LocalHost {
  const statePath = join(options.root, "state.json");
  const state = new StateStore(statePath, options.cwd);
  state.update({ cwd: options.cwd });
  const config = {
    homeDir: options.root,
    defaultCwd: options.cwd,
    allowedRoots: options.allowedRoots ?? [options.root],
    completionNotifications: {
      enabled: false,
      queuePath: join(options.root, "outbox.json"),
      deliveryPath: join(options.root, "delivery.json"),
      pollIntervalMs: 5_000,
      batchSize: 20,
      requestSummaryChars: 240,
      resultSummaryChars: 600,
      ackRetentionDays: 7,
      callbacks: [],
    },
  } as AppConfig;
  const codex = {} as never;
  return new LocalHost(
    "local",
    "Local",
    config,
    state,
    codex,
    new CompletionStore(config.completionNotifications.queuePath),
    false,
  );
}

describe("LocalHost projects", () => {
  it("lists first-level projects in stable name order", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-projects-"));
    const beta = join(root, "beta");
    const alpha = join(root, "Alpha");
    mkdirSync(beta);
    mkdirSync(alpha);
    mkdirSync(join(root, ".hidden"));
    const host = createHost({ root, cwd: beta });

    const projects = await host.listProjects();
    assert.deepEqual(projects.map((project) => project.name), ["Alpha", "beta"]);
    assert.equal(
      projects.find((project) => project.path === realpathSync(beta))?.current,
      true,
    );
    assert.ok(projects.every((project) => /^p[0-9a-f]{10}$/.test(project.id)));
  });

  it("includes the configured root itself when it is the current project", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-root-project-"));
    const host = createHost({ root, cwd: root, allowedRoots: [root] });

    const projects = await host.listProjects();
    assert.ok(
      projects.some(
        (project) => project.path === realpathSync(root) && project.current,
      ),
    );
  });

  it("ignores directory symlinks escaping the configured root", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-project-root-"));
    const outside = mkdtempSync(join(tmpdir(), "cw-project-outside-"));
    const current = join(root, "current");
    mkdirSync(current);
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
    } catch {
      return;
    }
    const host = createHost({ root, cwd: current });

    const projects = await host.listProjects();
    assert.equal(projects.some((project) => project.path === outside), false);
  });

  it("selects by sequence and clears the active thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-project-select-"));
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    mkdirSync(alpha);
    mkdirSync(beta);
    const statePath = join(root, "state.json");
    const state = new StateStore(statePath, beta);
    state.update({ cwd: beta, threadId: "thread", threadPreview: "preview" });
    const config = {
      homeDir: root,
      defaultCwd: beta,
      allowedRoots: [root],
      completionNotifications: {
        enabled: false,
        queuePath: join(root, "outbox.json"),
        deliveryPath: join(root, "delivery.json"),
        pollIntervalMs: 5_000,
        batchSize: 20,
        requestSummaryChars: 240,
        resultSummaryChars: 600,
        ackRetentionDays: 7,
        callbacks: [],
      },
    } as AppConfig;
    const host = new LocalHost(
      "local",
      "Local",
      config,
      state,
      {} as never,
      new CompletionStore(config.completionNotifications.queuePath),
      false,
    );

    const text = await host.selectProject("1");
    assert.match(text, new RegExp(`已切换项目: ${basename(alpha)}`));
    assert.equal(state.load().cwd, realpathSync(alpha));
    assert.equal(state.load().threadId, null);
  });
});
