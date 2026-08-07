import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { expandHome, resolveCwd } from "../config.js";
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
import { isUnderDir, resolveUnderRoot } from "../path-safety.js";
import type { CodexHost, PendingApprovalView } from "./types.js";
import {
  findModel,
  reasoningEffortFor,
  type CodexModelInfo,
  type ModelConfigSnapshot,
} from "../models.js";

export class LocalHost implements CodexHost {
  readonly kind = "local" as const;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly codex: CodexClient,
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
    const roots =
      this.config.allowedRoots.length > 0
        ? this.config.allowedRoots.join("\n  ")
        : `${this.config.defaultCwd} (default_cwd only)`;
    return [
      `host: ${this.id} (local)`,
      `label: ${this.label}`,
      `Codex: ${cs.state} (${cs.command})`,
      `sandbox: ${this.config.codexSandboxMode} / approval: ${this.config.codexApprovalPolicy}`,
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
      throw new Error(`未知模型: ${modelId}\n请用 /models 查看可选模型`);
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
      throw new Error(
        `模型 ${model.id} 不支持 think=${effort}\n可选: ${model.supportedReasoningEfforts.join(" | ") || "(未报告)"}`,
      );
    }
    return this.codex.setModelConfig("model_reasoning_effort", selected);
  }

  async getCwd(): Promise<string> {
    return this.validatedCwd();
  }

  async setCwd(path: string): Promise<string> {
    const cwd = resolveCwd(path, this.config);
    this.state.update({ cwd, threadId: null, threadPreview: null });
    return `✅ cwd 已切换为:\n${cwd}\n(已清空当前 thread，请 /new 或 /use)`;
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

  async resolveApproval(
    code: string,
    decision: "accept" | "decline",
  ): Promise<string> {
    await this.codex.resolveApproval(code, decision);
    return decision === "accept" ? `✅ 已批准 ${code}` : `🚫 已拒绝 ${code}`;
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
