export type JsonRpcId = string | number;

export type Transport = {
  connect(): Promise<void>;
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose?(handler: () => void): void;
  close?(): Promise<void> | void;
  getStderrTail?(): string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private serverRequestHandler: ((msg: JsonRpcServerRequest) => void) | null =
    null;
  private notificationHandler: ((msg: JsonRpcNotification) => void) | null =
    null;
  private closeHandler: (() => void) | null = null;
  private connected = false;
  private closing = false;

  constructor(
    public readonly transport: Transport,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.transport.connect();
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onClose?.(() => this.handleClose());
    this.connected = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.connect();
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Codex app-server 请求超时: ${method}`));
        }
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.transport.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    );
    return promise;
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.connect();
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  async respondError(
    id: JsonRpcId,
    code: number,
    message: string,
  ): Promise<void> {
    await this.connect();
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      }),
    );
  }

  onServerRequest(handler: (msg: JsonRpcServerRequest) => void): void {
    this.serverRequestHandler = handler;
  }

  onNotification(handler: (msg: JsonRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  private settle(
    id: JsonRpcId,
    apply: (p: {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }) => void,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    apply(pending);
  }

  handleMessage(message: string | object): void {
    let payload: Record<string, unknown>;
    if (typeof message === "string") {
      try {
        payload = JSON.parse(message) as Record<string, unknown>;
      } catch (err) {
        const snippet =
          message.length > 200 ? `${message.slice(0, 200)}…` : message;
        console.warn(
          `忽略非 JSON 行: ${snippet} (${(err as Error).message})`,
        );
        return;
      }
    } else {
      payload = message as Record<string, unknown>;
    }

    if (
      Object.hasOwn(payload, "id") &&
      (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))
    ) {
      this.settle(payload.id as JsonRpcId, (pending) => {
        if (payload.error) {
          const e = payload.error as { message?: string; code?: number };
          const err = new Error(
            e.message ?? "Codex app-server request failed",
          ) as Error & { code?: number };
          if (e.code !== undefined) err.code = e.code;
          pending.reject(err);
        } else {
          pending.resolve(payload.result);
        }
      });
      return;
    }

    if (Object.hasOwn(payload, "id") && payload.method) {
      this.serverRequestHandler?.(payload as unknown as JsonRpcServerRequest);
      return;
    }

    if (payload.method) {
      this.notificationHandler?.(payload as unknown as JsonRpcNotification);
    }
  }

  handleClose(): void {
    if (!this.connected) return;
    this.connected = false;
    const error = new Error("Codex app-server 连接已断开");
    for (const id of [...this.pending.keys()]) {
      this.settle(id, (p) => p.reject(error));
    }
    if (!this.closing) this.closeHandler?.();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.transport.close?.();
    this.connected = false;
  }

  getStderrTail(): string {
    return this.transport.getStderrTail?.() ?? "";
  }
}

export type JsonRpcServerRequest = {
  jsonrpc?: string;
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  jsonrpc?: string;
  method: string;
  params?: Record<string, unknown>;
};
