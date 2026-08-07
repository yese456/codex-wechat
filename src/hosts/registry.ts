import type { AppConfig, HostConfigEntry } from "../config.js";
import type { StateStore } from "../state.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexHost } from "./types.js";
import { LocalHost } from "./local-host.js";
import { HttpHost } from "./http-host.js";

export class HostRegistry {
  private hosts = new Map<string, CodexHost>();
  private order: string[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly localCodex: CodexClient,
  ) {
    this.rebuild();
  }

  rebuild(): void {
    this.hosts.clear();
    this.order = [];
    const entries = this.config.hosts;

    if (entries.length === 0) {
      // Single-machine default: local only
      const local = new LocalHost(
        "local",
        this.config.machineName || "local",
        this.config,
        this.state,
        this.localCodex,
      );
      this.hosts.set("local", local);
      this.order.push("local");
      return;
    }

    for (const e of entries) {
      const host = this.buildHost(e);
      this.hosts.set(host.id, host);
      this.order.push(host.id);
    }
  }

  private buildHost(e: HostConfigEntry): CodexHost {
    if (e.type === "local") {
      return new LocalHost(
        e.id,
        e.label || e.id,
        this.config,
        this.state,
        this.localCodex,
      );
    }
    if (e.type === "http") {
      if (!e.url || !e.token) {
        throw new Error(`host ${e.id}: http type requires url and token`);
      }
      return new HttpHost({
        id: e.id,
        label: e.label || e.id,
        url: e.url,
        token: e.token,
        allowInsecureHttp: e.allowInsecureHttp ?? false,
        requestTimeoutMs: this.config.httpRequestTimeoutMs,
        promptTimeoutMs: this.config.promptTimeoutMs,
        maxResponseBytes: this.config.maxHttpResponseBytes,
        maxMediaBytes: this.config.maxMediaBytes,
        maxAttachmentCount: this.config.maxAttachmentCount,
        maxAttachmentTotalBytes: this.config.maxAttachmentTotalBytes,
      });
    }
    throw new Error(`host ${e.id}: unknown type`);
  }

  list(): CodexHost[] {
    return this.order.map((id) => this.hosts.get(id)!).filter(Boolean);
  }

  get(id: string): CodexHost | undefined {
    return this.hosts.get(id);
  }

  /** Current host from state, falling back to default_host / first. */
  current(): CodexHost {
    const s = this.state.load();
    const preferred =
      s.currentHostId ||
      this.config.defaultHostId ||
      this.order[0] ||
      "local";
    const host = this.hosts.get(preferred) || this.hosts.get(this.order[0]!);
    if (!host) {
      throw new Error("没有配置任何 host");
    }
    return host;
  }

  setCurrent(id: string): CodexHost {
    const host = this.hosts.get(id);
    if (!host) {
      throw new Error(
        `未知 host: ${id}\n可用: ${this.order.join(", ") || "(无)"}`,
      );
    }
    this.state.update({ currentHostId: id });
    return host;
  }

  /** Local host client for ApprovalBridge (if any local host exists). */
  localCodexClient(): CodexClient | null {
    for (const h of this.list()) {
      if (h.kind === "local") {
        return (h as LocalHost).getCodex();
      }
    }
    return null;
  }

  localHost(): LocalHost | null {
    for (const h of this.list()) {
      if (h.kind === "local") return h as LocalHost;
    }
    return null;
  }
}
