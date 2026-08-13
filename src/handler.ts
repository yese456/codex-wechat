import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  resolveCwd,
  type AppConfig,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./config.js";
import type { StateStore } from "./state.js";
import type { HostRegistry } from "./hosts/registry.js";
import type { LocalHost } from "./hosts/local-host.js";
import type {
  CodexHost,
  ProjectInfo,
  SecurityPolicySnapshot,
} from "./hosts/types.js";
import type { Attachment, IncomingPayload, ReplyChannel } from "./media/types.js";
import type { CodexModelInfo, ModelConfigSnapshot } from "./models.js";
import { clip } from "./text.js";

const HELP = `codex-wechat 命令
/help              帮助
/status            状态（当前 host）
/hosts             列出可切换的机器
/m <id>            切换执行机（如 /m local /m vps）
/bind <码>         绑定本微信（仅入口机）
/cwd [路径]        查看/切换工作目录
/projects          列出可选项目
/project <选择>    按序号、名称或短 ID 切换项目
/new [标题提示]    新建 thread
/sessions          最近会话
/use <n|id>        切换会话
/ok               批准当前待审批（多个时用 /ok <码>）
/no               拒绝当前待审批
/approvals         待审批列表
/get <路径>        发送当前 host cwd 内的文件
/usage             Codex 用量（当前 host）
/model [id]        查询/切换当前 host 模型（机器全局）
/think <level>     切换当前模型的推理强度
/models            可选模型及支持的推理强度
/permissions       查询当前 host 的 sandbox / approval
/sandbox [mode]    查询/切换 sandbox 模式（机器全局）
/approval [policy] 查询/切换 approval 策略（机器全局）

同一微信请只在一台机器扫 iLink（入口）。多机执行用 /m 切换。
普通文本/图片/文件发给当前 host 的 Codex。`;

export class MessageHandler {
  private readonly busyHosts = new Set<string>();
  private readonly securityConfirmations = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly hosts: HostRegistry,
  ) {}

  isAllowed(userId: string): boolean {
    const s = this.state.load();
    return Boolean(s.allowUserId && s.allowUserId === userId);
  }

  /** For media download path on local host. */
  inboxRoot(): string {
    const local = this.hosts.localHost();
    if (local) return local.inboxRoot();
    // fallback: first local-like cwd on gateway
    const cwd = resolveCwd(this.state.load().cwd, this.config);
    return `${cwd}/.codex-wechat-inbox`;
  }

  async handle(
    userId: string,
    payload: IncomingPayload,
    reply: ReplyChannel,
  ): Promise<void> {
    const raw = (payload.text ?? "").trim();
    const attachments = payload.attachments ?? [];

    if (raw.startsWith("/bind")) {
      await this.cmdBind(userId, raw, reply);
      return;
    }

    if (!this.isAllowed(userId)) {
      await reply.text(
        `未授权。\n1) 入口机运行: codex-wechat bind\n2) 微信发送: /bind <码>`,
      );
      return;
    }

    if (raw.startsWith("/")) {
      await this.dispatchCommand(raw, reply);
      return;
    }

    if (!raw && attachments.length === 0) return;
    await this.runPrompt(raw, attachments, reply);
  }

  private async dispatchCommand(
    raw: string,
    reply: ReplyChannel,
  ): Promise<void> {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    const c = cmd.toLowerCase();

    switch (c) {
      case "/help":
      case "/h":
      case "/?":
        await reply.text(HELP);
        return;
      case "/hosts":
      case "/machines":
        await this.cmdHosts(reply);
        return;
      case "/m":
      case "/host":
      case "/machine":
        await this.cmdSwitchHost(arg, reply);
        return;
      case "/status":
        await this.cmdStatus(reply);
        return;
      case "/cwd":
        await this.cmdCwd(arg, reply);
        return;
      case "/projects":
        await this.cmdProjects(reply);
        return;
      case "/project":
        await this.cmdProject(arg, reply);
        return;
      case "/new":
        await this.cmdNew(arg, reply);
        return;
      case "/sessions":
      case "/s":
        await reply.text(await this.hosts.current().listSessions());
        return;
      case "/use":
        await this.cmdUseSession(arg, reply);
        return;
      case "/ok":
      case "/approve":
        await this.cmdApproval(arg, "accept", reply);
        return;
      case "/no":
      case "/deny":
        await this.cmdApproval(arg, "decline", reply);
        return;
      case "/approvals":
        await this.cmdApprovals(reply);
        return;
      case "/get":
      case "/file":
      case "/send":
        await this.cmdGet(arg, reply);
        return;
      case "/usage":
      case "/useage":
      case "/limit":
      case "/quota":
        await this.cmdUsage(reply);
        return;
      case "/model":
        await this.cmdModel(arg, reply);
        return;
      case "/think":
      case "/reasoning":
        await this.cmdThink(arg, reply);
        return;
      case "/models":
        await this.cmdModels(reply);
        return;
      case "/permissions":
      case "/policy":
        await this.cmdSecurityPolicy(reply);
        return;
      case "/sandbox":
        await this.cmdSandbox(arg, reply);
        return;
      case "/approval":
        await this.cmdApprovalPolicy(arg, reply);
        return;
      default:
        await reply.text(`未知命令: ${cmd}\n发 /help 查看帮助`);
    }
  }

  private async cmdHosts(reply: ReplyChannel): Promise<void> {
    const cur = this.hosts.current().id;
    const lines = this.hosts.list().map((h) => {
      const mark = h.id === cur ? "→" : " ";
      return `${mark} ${h.id}  [${h.kind}]  ${h.label}`;
    });
    if (lines.length === 0) {
      await reply.text("未配置 hosts（默认 local）");
      return;
    }
    await reply.text(
      `执行机列表（当前 →）\n${lines.join("\n")}\n\n切换: /m <id>`,
    );
  }

  private async cmdSwitchHost(
    arg: string,
    reply: ReplyChannel,
  ): Promise<void> {
    if (!arg) {
      await this.cmdHosts(reply);
      return;
    }
    try {
      const host = this.hosts.setCurrent(arg);
      const ok = await host.ping();
      await reply.text(
        `✅ 已切换到 host=${host.id} (${host.kind}) ${host.label}\n连通: ${ok ? "OK" : "失败/离线"}`,
      );
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdBind(
    userId: string,
    raw: string,
    reply: ReplyChannel,
  ): Promise<void> {
    const code = raw.replace(/^\/bind\s*/i, "").trim();
    if (!code) {
      await reply.text("用法: /bind <入口机终端显示的绑定码>");
      return;
    }
    const result = this.state.tryBind(userId, code, this.config.bindMaxFails);
    if (!result.ok) {
      await reply.text(`绑定失败: ${result.reason}`);
      return;
    }
    await reply.text(
      `✅ 已绑定入口「${this.config.machineName}」\n用 /hosts /m 切换执行机；发 /help 开始`,
    );
  }

  private async cmdStatus(reply: ReplyChannel): Promise<void> {
    try {
      const host = this.hosts.current();
      const text = await host.statusText();
      await reply.text(
        `入口: ${this.config.machineName}\n当前 host: ${host.id}\n\n${text}`,
      );
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdCwd(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    try {
      if (!arg) {
        await reply.text(`当前 cwd (${host.id}):\n${await host.getCwd()}`);
        return;
      }
      if (this.busyHosts.has(host.id)) {
        await reply.text(`host=${host.id} 正在执行任务，暂不能切换 cwd`);
        return;
      }
      await reply.text(await host.setCwd(arg));
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdProjects(reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    try {
      const projects = await host.listProjects();
      await reply.text(formatProjectList(host.id, projects));
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdProject(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    if (!arg) {
      await this.cmdProjects(reply);
      return;
    }
    if (this.busyHosts.has(host.id)) {
      await reply.text(`host=${host.id} 正在执行任务，暂不能切换项目`);
      return;
    }
    try {
      await reply.text(await host.selectProject(arg));
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdNew(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    await this.runExclusive(host, reply, async () => {
      await reply.text("正在创建 thread…");
      const msg = await host.newThread(arg || undefined);
      await reply.text(msg);
      if (arg) await this.runPromptOnHost(host, arg, [], reply);
    });
  }

  private async cmdUseSession(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    if (this.busyHosts.has(host.id)) {
      await reply.text(`host=${host.id} 正在执行任务，暂不能切换会话`);
      return;
    }
    await reply.text(await host.useSession(arg));
  }

  private async cmdApprovals(reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    const text = await host.listApprovalsText();
    const scoped = text.replace(
      /\/(ok|no)\s+([a-zA-Z]\w*)/g,
      (_all, command: string, code: string) =>
        `/${command} ${host.id}:${code}`,
    );
    await reply.text(`[host=${host.id}]\n${scoped}`);
  }

  private async cmdApproval(
    code: string,
    decision: "accept" | "decline",
    reply: ReplyChannel,
  ): Promise<void> {
    const trimmed = code.trim();
    try {
      let host = this.hosts.current();
      let rawCode = trimmed;

      // host-scoped: "mac:a1"
      const colon = trimmed.indexOf(":");
      if (colon > 0) {
        const hostId = trimmed.slice(0, colon);
        const selected = this.hosts.get(hostId);
        if (!selected) throw new Error(`未知审批 host: ${hostId}`);
        host = selected;
        rawCode = trimmed.slice(colon + 1).trim();
      }

      // Bare /ok or /no → resolve current host's latest pending approval.
      // Eric: approvals are always for the connected host/agent, no need for codes.
      if (!rawCode) {
        const pending = await host.listPendingApprovals();
        if (pending.length === 0) {
          await reply.text(`host=${host.id} 当前无待审批项`);
          return;
        }
        if (pending.length > 1) {
          await reply.text(
            `host=${host.id} 有 ${pending.length} 个待审批项，回复 /ok <码> 指定:\n` +
              pending
                .map((p, i) => `${i + 1}. ${p.shortCode}\n${clip(p.summary, 120)}`)
                .join("\n\n"),
          );
          return;
        }
        rawCode = pending[0]!.shortCode;
      } else if (/^\d+$/.test(rawCode)) {
        // numeric index → Nth pending on current host
        const pending = await host.listPendingApprovals();
        const idx = Number(rawCode) - 1;
        if (idx < 0 || idx >= pending.length) {
          throw new Error(
            `序号 ${rawCode} 超出范围（共 ${pending.length} 个待审批项）`,
          );
        }
        rawCode = pending[idx]!.shortCode;
      }

      await reply.text(await host.resolveApproval(rawCode, decision));
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdGet(arg: string, reply: ReplyChannel): Promise<void> {
    if (!arg) {
      await reply.text("用法: /get <路径>（当前 host 的 cwd 内）");
      return;
    }
    try {
      const file = await this.hosts.current().getFile(arg);
      if (file.isImage) {
        await reply.image(file.data, file.fileName);
      } else {
        await reply.file(file.data, file.fileName);
      }
      await reply.text(
        `📤 已发送: ${file.fileName} (${file.data.length} bytes)`,
      );
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdUsage(reply: ReplyChannel): Promise<void> {
    try {
      await reply.text("查询用量中…");
      const host = this.hosts.current();
      const text = await host.usageText();
      await reply.text(`[${host.id}]\n${text}`);
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdModel(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    if (!arg) {
      try {
        await reply.text(formatModelConfig(host.id, await host.getModelConfig()));
      } catch (err) {
        await reply.text(`❌ ${(err as Error).message}`);
      }
      return;
    }
    await this.runExclusive(host, reply, async () => {
      const config = await host.setModel(arg);
      await reply.text(
        `✅ 已切换当前机器的全局模型\n${formatModelConfig(host.id, config)}`,
      );
    });
  }

  private async cmdThink(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    if (!arg) {
      try {
        const config = await host.getModelConfig();
        await reply.text(
          `${formatModelConfig(host.id, config)}\n\n用法: /think <level>\n用 /models 查看当前模型支持的 level`,
        );
      } catch (err) {
        await reply.text(`❌ ${(err as Error).message}`);
      }
      return;
    }
    await this.runExclusive(host, reply, async () => {
      const config = await host.setReasoningEffort(arg);
      await reply.text(
        `✅ 已切换当前机器的全局推理强度\n${formatModelConfig(host.id, config)}`,
      );
    });
  }

  private async cmdModels(reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    try {
      const [config, models] = await Promise.all([
        host.getModelConfig(),
        host.listModels(),
      ]);
      await reply.text(formatModelList(host.id, config, models));
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdSecurityPolicy(reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    try {
      await reply.text(
        formatSecurityPolicy(host.id, await host.getSecurityPolicy()),
      );
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdSandbox(arg: string, reply: ReplyChannel): Promise<void> {
    const host = this.hosts.current();
    if (!arg) {
      await this.cmdSecurityPolicy(reply);
      return;
    }
    const parsed = parseSandboxArg(arg);
    if (!parsed) {
      await reply.text(
        `用法: /sandbox <mode>\n可选: ${CODEX_SANDBOX_MODES.join(" | ")}`,
      );
      return;
    }
    try {
      const current = await host.getSecurityPolicy();
      if (current.sandboxMode === parsed.value) {
        await reply.text(
          `sandbox 已是 ${parsed.value}\n${formatSecurityPolicy(host.id, current)}`,
        );
        return;
      }
      const relaxation =
        sandboxRisk(parsed.value) > sandboxRisk(current.sandboxMode);
      if (
        relaxation &&
        !(await this.confirmSecurityChange(
          host,
          "sandbox",
          parsed.value,
          parsed.confirmed,
          `/sandbox ${parsed.value} confirm`,
          reply,
        ))
      ) {
        return;
      }
      await this.runExclusive(host, reply, async () => {
        const policy = await host.setSandboxMode(parsed.value);
        this.clearSecurityConfirmation(host.id, "sandbox");
        await reply.text(
          `✅ 已切换当前机器的全局 sandbox\n${formatSecurityPolicy(host.id, policy)}`,
        );
      });
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async cmdApprovalPolicy(
    arg: string,
    reply: ReplyChannel,
  ): Promise<void> {
    const host = this.hosts.current();
    if (!arg) {
      await this.cmdSecurityPolicy(reply);
      return;
    }
    const parsed = parseApprovalArg(arg);
    if (!parsed) {
      await reply.text(
        `用法: /approval <policy>\n可选: ${CODEX_APPROVAL_POLICIES.join(" | ")}`,
      );
      return;
    }
    try {
      const current = await host.getSecurityPolicy();
      if (current.approvalPolicy === parsed.value) {
        await reply.text(
          `approval 已是 ${parsed.value}\n${formatSecurityPolicy(host.id, current)}`,
        );
        return;
      }
      const relaxation =
        approvalRisk(parsed.value) > approvalRisk(current.approvalPolicy);
      if (
        relaxation &&
        !(await this.confirmSecurityChange(
          host,
          "approval",
          parsed.value,
          parsed.confirmed,
          `/approval ${parsed.value} confirm`,
          reply,
        ))
      ) {
        return;
      }
      await this.runExclusive(host, reply, async () => {
        const policy = await host.setApprovalPolicy(parsed.value);
        this.clearSecurityConfirmation(host.id, "approval");
        await reply.text(
          `✅ 已切换当前机器的全局 approval\n${formatSecurityPolicy(host.id, policy)}`,
        );
      });
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    }
  }

  private async confirmSecurityChange(
    host: CodexHost,
    field: "sandbox" | "approval",
    value: string,
    confirmed: boolean,
    confirmationCommand: string,
    reply: ReplyChannel,
  ): Promise<boolean> {
    const key = `${host.id}:${field}`;
    const pending = this.securityConfirmations.get(key);
    if (
      confirmed &&
      pending?.value === value &&
      pending.expiresAt >= Date.now()
    ) {
      return true;
    }
    this.securityConfirmations.set(key, {
      value,
      expiresAt: Date.now() + SECURITY_CONFIRM_TTL_MS,
    });
    await reply.text(
      [
        `⚠️ 这会降低 host=${host.id} 的安全限制，并写入该机器的 Codex 全局配置。`,
        `当前请求: ${field}=${value}`,
        "60 秒内发送以下命令确认:",
        confirmationCommand,
      ].join("\n"),
    );
    return false;
  }

  private clearSecurityConfirmation(
    hostId: string,
    field: "sandbox" | "approval",
  ): void {
    this.securityConfirmations.delete(`${hostId}:${field}`);
  }

  private async runPrompt(
    text: string,
    attachments: Attachment[],
    reply: ReplyChannel,
  ): Promise<void> {
    const host = this.hosts.current();
    await this.runExclusive(host, reply, () =>
      this.runPromptOnHost(host, text, attachments, reply),
    );
  }

  private async runExclusive(
    host: CodexHost,
    reply: ReplyChannel,
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.busyHosts.has(host.id)) {
      await reply.text(`host=${host.id} 上一任务还在进行中，请稍候`);
      return;
    }
    this.busyHosts.add(host.id);
    try {
      await action();
    } catch (err) {
      await reply.text(`❌ ${(err as Error).message}`);
    } finally {
      this.busyHosts.delete(host.id);
    }
  }

  private async runPromptOnHost(
    host: CodexHost,
    text: string,
    attachments: Attachment[],
    reply: ReplyChannel,
  ): Promise<void> {
    const mediaHint =
      attachments.length > 0
        ? `附件 ${attachments.length} 个 → ${attachments.map((a) => a.fileName).join(", ")}\n`
        : "";
    await reply.text(`[${host.id}] ${mediaHint}⏳ Codex 处理中…`);

    const answer = await host.runPrompt(text, attachments, {
      onApproval: async (a) => {
        await reply.text(
          [
            `⏳ 需要审批 (host=${host.id})`,
            a.summary,
            "",
            `回复 /ok 同意，/no 拒绝`,
          ].join("\n"),
        );
      },
    });

    // Split long replies is done by ReplyChannel in wechat bot for text()
    // but we pass one big string - reply.text already splits
    const { splitText } = await import("./text.js");
    const chunks = splitText(answer, this.config.maxReplyChars);
    if (chunks.length === 0) {
      await reply.text("(空回复)");
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
      await reply.text(prefix + chunks[i]!);
    }
  }
}

// re-export for wechat media path
export type { LocalHost };

const SECURITY_CONFIRM_TTL_MS = 60_000;

function parseSandboxArg(
  arg: string,
): { value: CodexSandboxMode; confirmed: boolean } | null {
  const tokens = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (
    tokens.length < 1 ||
    tokens.length > 2 ||
    (tokens[1] && tokens[1] !== "confirm")
  ) {
    return null;
  }
  const aliases: Record<string, CodexSandboxMode> = {
    ro: "read-only",
    read: "read-only",
    readonly: "read-only",
    workspace: "workspace-write",
    write: "workspace-write",
    auto: "workspace-write",
    danger: "danger-full-access",
    full: "danger-full-access",
    yolo: "danger-full-access",
  };
  const raw = tokens[0]!;
  const value = CODEX_SANDBOX_MODES.includes(raw as CodexSandboxMode)
    ? (raw as CodexSandboxMode)
    : aliases[raw];
  return value ? { value, confirmed: tokens[1] === "confirm" } : null;
}

function parseApprovalArg(
  arg: string,
): { value: CodexApprovalPolicy; confirmed: boolean } | null {
  const tokens = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (
    tokens.length < 1 ||
    tokens.length > 2 ||
    (tokens[1] && tokens[1] !== "confirm")
  ) {
    return null;
  }
  const aliases: Record<string, CodexApprovalPolicy> = {
    strict: "untrusted",
    ask: "on-request",
    request: "on-request",
    onrequest: "on-request",
    none: "never",
    off: "never",
  };
  const raw = tokens[0]!;
  const value = CODEX_APPROVAL_POLICIES.includes(raw as CodexApprovalPolicy)
    ? (raw as CodexApprovalPolicy)
    : aliases[raw];
  return value ? { value, confirmed: tokens[1] === "confirm" } : null;
}

function sandboxRisk(mode: CodexSandboxMode): number {
  return CODEX_SANDBOX_MODES.indexOf(mode);
}

function approvalRisk(policy: CodexApprovalPolicy): number {
  return CODEX_APPROVAL_POLICIES.indexOf(policy);
}

function formatProjectList(hostId: string, projects: ProjectInfo[]): string {
  if (projects.length === 0) {
    return `[host=${hostId}] 未发现可选项目`;
  }
  const lines = projects.map((project, index) =>
    `${project.current ? "→" : " "} ${index + 1}. ${project.name}  [${project.id}]\n   ${project.path}`,
  );
  return [
    `项目列表 [host=${hostId}]（当前 →）`,
    ...lines,
    "",
    "切换: /project <序号|名称|ID>",
  ].join("\n");
}

function formatSecurityPolicy(
  hostId: string,
  policy: SecurityPolicySnapshot,
): string {
  return [
    `host: ${hostId}`,
    `sandbox: ${policy.sandboxMode}`,
    `approval: ${policy.approvalPolicy}`,
    "作用域: 当前机器全局配置（后续 turn 生效，重启后保留）",
    policy.sandboxMode === "danger-full-access" ||
    policy.approvalPolicy === "never"
      ? "⚠️ 当前策略包含高风险设置"
      : "",
    "sandbox: /sandbox <mode>",
    "approval: /approval <policy>",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatModelConfig(
  hostId: string,
  config: ModelConfigSnapshot,
): string {
  return [
    `host: ${hostId}`,
    `model: ${config.model ?? "(未设置)"}`,
    `think: ${config.reasoningEffort ?? "(默认)"}`,
    config.provider ? `provider: ${config.provider}` : "",
    config.serviceTier ? `service tier: ${config.serviceTier}` : "",
    "作用域: 当前机器全局配置（后续 turn 生效）",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatModelList(
  hostId: string,
  config: ModelConfigSnapshot,
  models: CodexModelInfo[],
): string {
  if (models.length === 0) return `[host=${hostId}] Codex 未返回可选模型`;
  const current = config.model?.toLowerCase() ?? "";
  const lines = models.map((model) => {
    const selected = model.id.toLowerCase() === current;
    const efforts = model.supportedReasoningEfforts.join(" | ") || "未报告";
    const defaultEffort = model.defaultReasoningEffort
      ? `，默认 ${model.defaultReasoningEffort}`
      : "";
    return `${selected ? "→" : "·"} ${model.id}\n  think: ${efforts}${defaultEffort}`;
  });
  return [
    `可选模型 [host=${hostId}]（当前 →）`,
    ...lines,
    "",
    "切换: /model <id>",
    "推理强度: /think <level>",
  ].join("\n");
}
