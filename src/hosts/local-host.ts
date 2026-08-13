import { createHash } from "node:crypto";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  AppConfig,
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../config.js";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  expandHome,
  resolveCwd,
} from "../config.js";
import type { StateStore } from "../state.js";
import {
  CodexClient,
  formatThreadList,
} from "../codex/client.js";
import { clip, shortId } from "../text.js";
import {
  buildAttachmentPrompt,
  inboxRootForCwd,
  isImageFileName,
} from "../media/save.js";
import type { Attachment } from "../media/types.js";
import { CompletionStore, truncateSummary } from "../completions/store.js";
import type { CompletionEvent } from "../completions/types.js";
import {
  canonicalDirectoryUnderRoots,
  isUnderDir,
  resolveUnderRoot,
} from "../path-safety.js";
import type {
  CodexHost,
  PendingApprovalView,
  ProjectInfo,
  SecurityPolicySnapshot,
} from "./types.js";
import { HostInputError } from "./types.js";
import {
  findModel,
  reasoningEffortFor,
  type CodexModelInfo,
  type ModelConfigSnapshot,
} from "../models.js";

const MAX_PROJECTS = 200;

function projectId(path: string): string {
  return `p${createHash("sha256").update(path).digest("hex").slice(0, 10)}`;
}

function compareProjects(a: ProjectInfo, b: ProjectInfo): number {
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export class LocalHost implements CodexHost {
  readonly kind = "local" as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly codex: CodexClient,
    private readonly completionStore: CompletionStore,
    readonly completionNotificationsEnabled: boolean,
  ) {}

  /** Expose client for ApprovalBridge wiring on the gateway. */
  getCodex(): CodexClient {
    return this.codex;
  }

  inboxRoot(): string {
    return inboxRootForCwd(this.validatedCwd());
  }

  private validatedCwd(): string {
    const state = this.state.load();
    const cwd = resolveCwd(state.cwd, this.config);
    if (cwd !== state.cwd) this.state.update({ cwd });
    return cwd;
  }

  async ping(): Promise<boolean> {
    try {
      await this.codex.ensureConnected();
      return true;
    } catch {
      return false;
    }
  }

  async statusText(): Promise<string> {
    const s = this.state.load();
    const cwd = this.validatedCwd();
    const cs = this.codex.getStatus();
    const security = this.codex.getSecurityPolicy();
    const roots =
      this.config.allowedRoots.length > 0
        ? this.config.allowedRoots.join("\n  ")
        : `${this.config.defaultCwd} (default_cwd only)`;
    return [
      `host: ${this.id} (local)`,
      `label: ${this.label}`,
      `Codex: ${cs.state} (${cs.command})`,
      `sandbox: ${security.sandboxMode} / approval: ${security.approvalPolicy}`,
      `cwd: ${cwd}`,
      `roots:\n  ${roots}`,
      `thread: ${s.threadId ? shortId(s.threadId, 12) : "(无)"}`,
      s.threadPreview ? `预览: ${clip(s.threadPreview, 60)}` : "",
      `待审批: ${cs.pendingApprovals}`,
      cs.lastError ? `最近错误: ${clip(cs.lastError, 200)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async usageText(): Promise<string> {
    return this.codex.getUsageSummary();
  }

  async getModelConfig(): Promise<ModelConfigSnapshot> {
    return this.codex.getModelConfig();
  }

  async listModels(): Promise<CodexModelInfo[]> {
    return this.codex.listModels();
  }

  async setModel(modelId: string): Promise<ModelConfigSnapshot> {
    const models = await this.codex.listModels();
    const selected = findModel(models, modelId);
    if (!selected) {
      throw new HostInputError(
        `未知模型: ${modelId}\n请用 /models 查看可选模型`,
      );
    }
    const before = await this.codex.getModelConfig();
    let config = await this.codex.setModelConfig("model", selected.id);
    if (
      before.reasoningEffort &&
      selected.supportedReasoningEfforts.length > 0 &&
      !reasoningEffortFor(selected, before.reasoningEffort)
    ) {
      const compatible =
        selected.defaultReasoningEffort ??
        selected.supportedReasoningEfforts[0]!;
      config = await this.codex.setModelConfig(
        "model_reasoning_effort",
        compatible,
      );
    }
    return config;
  }

  async setReasoningEffort(effort: string): Promise<ModelConfigSnapshot> {
    const config = await this.codex.getModelConfig();
    if (!config.model) throw new Error("当前 Codex 配置未返回 model");
    const models = await this.codex.listModels();
    const model = findModel(models, config.model);
    if (!model) {
      throw new Error(`当前模型不在 model/list 中: ${config.model}`);
    }
    const selected = reasoningEffortFor(model, effort);
    if (!selected) {
      throw new HostInputError(
        `模型 ${model.id} 不支持 think=${effort}\n可选: ${model.supportedReasoningEfforts.join(" | ") || "(未报告)"}`,
      );
    }
    return this.codex.setModelConfig("model_reasoning_effort", selected);
  }

  async getSecurityPolicy(): Promise<SecurityPolicySnapshot> {
    return this.codex.getSecurityPolicy();
  }

  async setSandboxMode(
    mode: CodexSandboxMode,
  ): Promise<SecurityPolicySnapshot> {
    if (!CODEX_SANDBOX_MODES.includes(mode)) {
      throw new Error(`sandbox 只能是: ${CODEX_SANDBOX_MODES.join(" | ")}`);
    }
    const updated = await this.codex.setSandboxMode(mode);
    this.state.update({ codexSandboxMode: mode });
    return updated;
  }

  async setApprovalPolicy(
    policy: CodexApprovalPolicy,
  ): Promise<SecurityPolicySnapshot> {
    if (!CODEX_APPROVAL_POLICIES.includes(policy)) {
      throw new Error(
        `approval 只能是: ${CODEX_APPROVAL_POLICIES.join(" | ")}`,
      );
    }
    const updated = await this.codex.setApprovalPolicy(policy);
    this.state.update({ codexApprovalPolicy: policy });
    return updated;
  }

  async getCwd(): Promise<string> {
    return this.validatedCwd();
  }

  async setCwd(path: string): Promise<string> {
    const cwd = resolveCwd(path, this.config);
    this.state.update({ cwd, threadId: null, threadPreview: null });
    return `✅ cwd 已切换为:\n${cwd}\n(已清空当前 thread，请 /new 或 /use)`;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    let currentCwd = this.validatedCwd();
    try {
      currentCwd = canonicalDirectoryUnderRoots(currentCwd, [currentCwd]);
    } catch {
      // validatedCwd already enforces policy; keep its path if canonicalization fails.
    }
    const roots =
      this.config.allowedRoots.length > 0
        ? this.config.allowedRoots
        : [this.config.defaultCwd];
    const projects = new Map<string, ProjectInfo>();

    for (const configuredRoot of roots) {
      let root: string;
      try {
        root = canonicalDirectoryUnderRoots(configuredRoot, [configuredRoot]);
      } catch {
        continue;
      }
      if (currentCwd === root && !projects.has(root)) {
        projects.set(root, {
          id: projectId(root),
          name: basename(root),
          path: root,
          current: true,
        });
      }
      let entries;
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (projects.size >= MAX_PROJECTS) break;
        if (entry.name.startsWith(".")) continue;
        const candidate = resolve(root, entry.name);
        try {
          if (!entry.isDirectory() && !statSync(candidate).isDirectory()) continue;
          const canonical = canonicalDirectoryUnderRoots(candidate, [root]);
          if (projects.has(canonical)) continue;
          projects.set(canonical, {
            id: projectId(canonical),
            name: basename(canonical),
            path: canonical,
            current: canonical === currentCwd,
          });
        } catch {
          // Ignore unreadable entries and symlinks escaping their configured root.
        }
      }
    }

    return [...projects.values()].sort(compareProjects).slice(0, MAX_PROJECTS);
  }

  async selectProject(selector: string): Promise<string> {
    const value = selector.trim();
    if (!value) {
      throw new HostInputError("用法: /project <序号|名称|ID>");
    }
    const projects = await this.listProjects();
    let selected: ProjectInfo | undefined;

    if (/^\d+$/.test(value)) {
      const index = Number(value) - 1;
      if (index < 0 || index >= projects.length) {
        throw new HostInputError(
          `项目序号 ${value} 超出范围（共 ${projects.length} 个）`,
        );
      }
      selected = projects[index];
    } else {
      const exactNames = projects.filter((project) => project.name === value);
      if (exactNames.length > 1) {
        throw new HostInputError(
          `项目名称重名: ${value}\n${exactNames
            .map((project) => `- ${project.id}  ${project.path}`)
            .join("\n")}\n请改用序号或 ID`,
        );
      }
      if (exactNames.length === 1) {
        selected = exactNames[0];
      } else {
        const idMatches = projects.filter((project) =>
          project.id.startsWith(value.toLowerCase()),
        );
        if (idMatches.length > 1) {
          throw new HostInputError(
            `项目 ID 前缀不唯一: ${value}\n${idMatches
              .map((project) => `- ${project.id}  ${project.path}`)
              .join("\n")}`,
          );
        }
        selected = idMatches[0];
      }
    }

    if (!selected) {
      throw new HostInputError(`找不到项目: ${value}\n请用 /projects 查看`);
    }
    await this.setCwd(selected.path);
    return `✅ 已切换项目: ${selected.name}\n${selected.path}\n(已清空当前 thread，请 /new 或 /use)`;
  }

  async newThread(title?: string): Promise<string> {
    const cwd = this.validatedCwd();
    await this.codex.ensureConnected();
    const thread = await this.codex.startThread(cwd);
    this.state.update({
      threadId: thread.id,
      threadPreview: title || thread.preview || "new",
    });
    if (title) {
      return `✅ 新会话 ${shortId(thread.id)}\n开始: ${clip(title, 80)}`;
    }
    return `✅ 新会话 ${shortId(thread.id)}\ncwd: ${cwd}\n直接发消息即可`;
  }

  async listSessions(): Promise<string> {
    await this.codex.ensureConnected();
    const cwd = this.validatedCwd();
    const threads = await this.codex.listThreads({ cwd, limit: 12 });
    const list =
      threads.length > 0
        ? threads
        : await this.codex.listThreads({ cwd: null, limit: 12 });
    const header =
      threads.length > 0
        ? `cwd=${cwd} 最近会话:\n`
        : `（当前 cwd 无会话，显示全局）\n`;
    return header + formatThreadList(list);
  }

  async useSession(arg: string): Promise<string> {
    await this.codex.ensureConnected();
    const cwd = this.validatedCwd();
    let list = await this.codex.listThreads({ cwd, limit: 20 });
    if (list.length === 0) {
      list = await this.codex.listThreads({ cwd: null, limit: 20 });
    }
    let thread = list.find((t) => t.id === arg || t.id.startsWith(arg));
    if (!thread && /^\d+$/.test(arg)) {
      thread = list[Number(arg) - 1];
    }
    if (!thread) return "找不到会话，先 /sessions";
    const threadCwd = thread.cwd || cwd;
    let validatedThreadCwd: string;
    try {
      validatedThreadCwd = resolveCwd(threadCwd, this.config);
    } catch {
      return `该会话 cwd 不在允许范围内:\n${threadCwd}`;
    }
    await this.codex.resumeThread(thread.id, validatedThreadCwd);
    this.state.update({
      threadId: thread.id,
      threadPreview: thread.preview || thread.name,
      cwd: validatedThreadCwd,
    });
    return `✅ 已切换到 ${shortId(thread.id)}\n${clip(thread.preview || "", 80)}\ncwd: ${validatedThreadCwd}`;
  }

  async runPrompt(
    text: string,
    attachments: Attachment[],
    _hooks?: {
      onApproval?: (a: PendingApprovalView) => void | Promise<void>;
    },
  ): Promise<string> {
    // Approvals for local host are handled by ApprovalBridge → WeChat outside this call.
    let s = this.state.load();
    const cwd = this.validatedCwd();
    if (s.cwd !== cwd) s = this.state.load();
    await this.codex.ensureConnected();

    if (!s.threadId) {
      const thread = await this.codex.startThread(cwd);
      s = this.state.update({
        threadId: thread.id,
        threadPreview: clip(text || attachments[0]?.fileName || "media", 40),
      });
    } else {
      try {
        await this.codex.resumeThread(s.threadId, cwd);
      } catch {
        const thread = await this.codex.startThread(cwd);
        s = this.state.update({
          threadId: thread.id,
          threadPreview: clip(text || "media", 40),
        });
      }
    }

    const { text: promptText, imagePaths } = buildAttachmentPrompt(
      text,
      attachments,
    );
    if (this.completionNotificationsEnabled) {
      this.completionStore.markSuppression(
        s.threadId!,
        truncateSummary(
          promptText,
          this.config.completionNotifications.requestSummaryChars,
        ),
        this.config.promptTimeoutMs,
      );
    }
    const answer = await this.codex.runPrompt({
      threadId: s.threadId!,
      text: promptText,
      cwd,
      imagePaths,
      timeoutMs: this.config.promptTimeoutMs,
    });
    this.state.update({ threadPreview: clip(text || promptText, 40) });
    return answer;
  }

  async listApprovalsText(): Promise<string> {
    const list = this.codex.listPendingApprovals();
    if (list.length === 0) return "无待审批项";
    return list
      .map(
        (a) =>
          `· ${a.shortCode}\n${clip(a.summary, 200)}\n/ok ${a.shortCode}  |  /no ${a.shortCode}`,
      )
      .join("\n\n");
  }

  async listPendingApprovals(): Promise<PendingApprovalView[]> {
    return this.codex
      .listPendingApprovals()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => ({ shortCode: a.shortCode, summary: a.summary }));
  }

  async resolveApproval(
    code: string,
    decision: "accept" | "decline",
  ): Promise<string> {
    await this.codex.resolveApproval(code, decision);
    return decision === "accept" ? `✅ 已批准 ${code}` : `🚫 已拒绝 ${code}`;
  }

  async pollCompletions(limit: number): Promise<CompletionEvent[]> {
    return this.completionStore.poll(limit);
  }

  async ackCompletions(ids: string[]): Promise<void> {
    this.completionStore.ack(ids);
  }

  async getFile(
    pathArg: string,
  ): Promise<{ fileName: string; data: Buffer; isImage: boolean }> {
    const s = this.state.load();
    const cwd = resolveCwd(s.cwd, this.config);
    const expanded = expandHome(pathArg, this.config.homeDir);
    const candidate = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(cwd, expanded);
    if (!isUnderDir(candidate, cwd)) {
      throw new Error("/get 仅允许当前 cwd 内的文件");
    }
    const checked = resolveUnderRoot(candidate, cwd);
    if (!checked.ok) throw new Error(checked.reason);
    const abs = checked.abs;
    if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error("只能发送普通文件");
    if (st.size > this.config.maxMediaBytes) {
      throw new Error(`文件过大 (${st.size} bytes)`);
    }
    const fileName = basename(abs);
    return {
      fileName,
      data: readFileSync(abs),
      isImage: isImageFileName(fileName),
    };
  }
}
