/**
 * Patch @wechatbot/wechatbot so QR status polling can long-wait.
 * Run via postinstall — safe to re-run (idempotent markers).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = join(
  root,
  "node_modules/@wechatbot/wechatbot/package.json",
);
const apiJs = join(
  root,
  "node_modules/@wechatbot/wechatbot/dist/protocol/api.js",
);
const httpJs = join(
  root,
  "node_modules/@wechatbot/wechatbot/dist/transport/http.js",
);

if (!existsSync(packageJson) || !existsSync(apiJs) || !existsSync(httpJs)) {
  throw new Error("[patch-wechatbot] @wechatbot/wechatbot 2.2.0 is not fully installed");
}

const installed = JSON.parse(readFileSync(packageJson, "utf8"));
if (installed.version !== "2.2.0") {
  throw new Error(
    `[patch-wechatbot] unsupported SDK version ${String(installed.version)}; expected 2.2.0`,
  );
}

const failures = [];

let api = readFileSync(apiJs, "utf8");
if (!api.includes("timeoutMs: 90_000") && !api.includes("timeoutMs: 90000")) {
  const old = `return this.http.apiGet(baseUrl, path, buildCommonHeaders());`;
  const neu = `return this.http.apiGet(baseUrl, path, buildCommonHeaders(), { timeoutMs: 90_000 });`;
  if (!api.includes(old)) {
    failures.push("api.js pollQrStatus pattern not found");
  } else {
    api = api.replace(old, neu);
    writeFileSync(apiJs, api);
    console.log("[patch-wechatbot] patched pollQrStatus timeout");
  }
} else {
  console.log("[patch-wechatbot] api.js already patched");
}

let http = readFileSync(httpJs, "utf8");
if (!http.includes("async apiGet(baseUrl, path, headers, options)")) {
  const old = `async apiGet(baseUrl, path, headers) {
        const url = new URL(path, normalizeBaseUrl(baseUrl)).toString();
        const response = await this.request({
            method: 'GET',
            url,
            headers,
            timeoutMs: 15_000,
        });
        return response.data;
    }`;
  const neu = `async apiGet(baseUrl, path, headers, options) {
        const url = new URL(path, normalizeBaseUrl(baseUrl)).toString();
        const response = await this.request({
            method: 'GET',
            url,
            headers,
            timeoutMs: options?.timeoutMs ?? 15_000,
            signal: options?.signal,
        });
        return response.data;
    }`;
  if (!http.includes("timeoutMs: 15_000")) {
    failures.push("http.js apiGet timeout pattern not found");
  } else if (http.includes(old)) {
    http = http.replace(old, neu);
    writeFileSync(httpJs, http);
    console.log("[patch-wechatbot] patched apiGet options");
  } else {
    // looser replace
    const patched = http.replace(
      /async apiGet\(baseUrl, path, headers\) \{[\s\S]*?return response\.data;\n    \}/,
      neu.trim(),
    );
    if (patched === http) {
      failures.push("http.js apiGet method pattern not found");
    } else {
      writeFileSync(httpJs, patched);
      console.log("[patch-wechatbot] patched apiGet (loose)");
    }
  }
} else {
  console.log("[patch-wechatbot] http.js already patched");
}

const authJs = join(
  root,
  "node_modules/@wechatbot/wechatbot/dist/auth/authenticator.js",
);
if (existsSync(authJs)) {
  let auth = readFileSync(authJs, "utf8");
  if (auth.includes("MAX_QR_REFRESH_COUNT = 3")) {
    auth = auth.replace(
      "MAX_QR_REFRESH_COUNT = 3",
      "MAX_QR_REFRESH_COUNT = 30",
    );
    writeFileSync(authJs, auth);
    console.log("[patch-wechatbot] raised MAX_QR_REFRESH_COUNT to 30");
  } else {
    if (auth.includes("MAX_QR_REFRESH_COUNT = 30")) {
      console.log("[patch-wechatbot] authenticator.js refresh count ok");
    } else {
      failures.push("authenticator.js refresh-count pattern not found");
    }
  }
} else {
  failures.push("authenticator.js not found");
}

if (failures.length > 0) {
  throw new Error(`[patch-wechatbot] patch incomplete: ${failures.join("; ")}`);
}
