import { it } from "node:test";
import assert from "node:assert/strict";
import { HttpHost } from "../src/hosts/http-host.js";

it("forwards model operations through authenticated Agent routes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${"a".repeat(64)}`,
    );
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ models: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/v1/security")) {
      return new Response(
        JSON.stringify({
          policy: {
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        config: {
          model: "gpt-b",
          reasoningEffort: "high",
          provider: "openai",
          serviceTier: null,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const host = new HttpHost({
      id: "mac",
      label: "Mac",
      url: "http://127.0.0.1:18765",
      token: "a".repeat(64),
      allowInsecureHttp: false,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 10_000,
      maxResponseBytes: 1024 * 1024,
      maxMediaBytes: 1024 * 1024,
      maxAttachmentCount: 8,
      maxAttachmentTotalBytes: 1024 * 1024,
    });
    assert.equal((await host.getModelConfig()).model, "gpt-b");
    await host.listModels();
    await host.setModel("gpt-b");
    await host.setReasoningEffort("high");
    assert.equal(
      (await host.getSecurityPolicy()).sandboxMode,
      "workspace-write",
    );
    await host.setSandboxMode("workspace-write");
    await host.setApprovalPolicy("on-request");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ url, method }) => [new URL(url).pathname, method]),
    [
      ["/v1/config/read", "GET"],
      ["/v1/models", "GET"],
      ["/v1/config/write", "POST"],
      ["/v1/config/write", "POST"],
      ["/v1/security", "GET"],
      ["/v1/security", "POST"],
      ["/v1/security", "POST"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[2]!.body!), {
    keyPath: "model",
    value: "gpt-b",
  });
  assert.deepEqual(JSON.parse(requests[3]!.body!), {
    keyPath: "model_reasoning_effort",
    value: "high",
  });
  assert.deepEqual(JSON.parse(requests[5]!.body!), {
    sandboxMode: "workspace-write",
  });
  assert.deepEqual(JSON.parse(requests[6]!.body!), {
    approvalPolicy: "on-request",
  });
});
