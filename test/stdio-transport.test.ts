import { it } from "node:test";
import assert from "node:assert/strict";
import { StdioTransport } from "../src/rpc/stdio-transport.js";

it("diagnoses unsupported Content-Length framing", () => {
  const transport = new StdioTransport("codex");
  transport.feed("Content-Length: 42\r\n\r\n");
  assert.match(transport.getStderrTail(), /只支持.*NDJSON/);
});
