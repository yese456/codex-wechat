# codex-wechat

[![CI](https://github.com/YOUR_USER/codex-wechat/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USER/codex-wechat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

**WeChat remote control for Codex** on your own machine or VPS.

Messages use Tencent **iLink** ([`@wechatbot/wechatbot`](https://github.com/corespeed-io/wechatbot)); work runs via **`codex app-server`** (stdio JSON-RPC).

- **Single machine** (default): one process = WeChat + local Codex
- **Multi machine, one WeChat**: one **gateway** (WeChat) + many **agents** (HTTP); switch with `/m`
- Single-user bind + approvals; no public chat webhook

> **Certified against Codex CLI 0.144.x+.** After upgrading Codex, run `npx tsx src/cli.ts doctor`.

---

## Disclaimer

- Uses the **iLink bot API** (not WeChat Web reverse-engineering). Terms and availability may change; **you** are responsible for compliance.
- Per [openclaw-weixin](https://github.com/Tencent/openclaw-weixin): **the same WeChat user keeps only the latest bot login** — do not QR-login the same WeChat on two machines as full daemons.
- A bound WeChat account can drive Codex (files + commands). **Only bind your own account.**
- Provided **as-is** under MIT — no warranty. Not affiliated with Tencent or OpenAI.

See [SECURITY.md](./SECURITY.md).

---

## Architecture

### Single machine (default)

```text
Phone (WeChat)
      │  iLink long-poll
      ▼
codex-wechat start   (gateway)
  ├─ auth / commands
  └─ local codex app-server
```

### Multi machine, one WeChat (recommended for laptop + VPS)

```text
Phone (WeChat)  ──扫码仅一次──►  gateway (VPS, always on)
                                    │  /m local | /m vps2
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              agent (Mac)     agent (VPS)    agent (VPS2)
              HTTP + token    local Codex    local Codex
```

| Role | Command | WeChat QR? |
|------|---------|------------|
| **Gateway** | `npx tsx src/cli.ts start` | **Yes** (only here) |
| **Agent** | `codex-wechat agent` | **No** |

### Multi machine matrix

| Setup | How |
|-------|-----|
| One laptop only | `start` only — no `hosts` config |
| One VPS only | `start` on VPS |
| Many hosts, **one WeChat** | One gateway + agents; `/m <id>` |
| Many hosts, **many WeChat** | Each full `start` with its own QR (official multi-account) |
| Same machine, many terminals | **One** `start`/`agent` process only |

## Requirements

| Component | Notes |
|-----------|--------|
| Node.js | **≥ 22** (macOS / Linux / **Windows**) |
| [Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` then `codex login` |
| WeChat | QR login for iLink — **gateway only** |

## Quick start

```bash
git clone https://github.com/YOUR_USER/codex-wechat.git
cd codex-wechat
npm install
npm run typecheck

# optional config
npx tsx src/cli.ts init
# edit ~/.codex-wechat/config.yaml

# terminal 1 — daemon (prints QR URL on first login)
npm start

# terminal 2 — bind code
npx tsx src/cli.ts bind
# in WeChat: /bind <code>
```

Then:

```text
/help
/status
/cwd ~/code/my-app
/new fix the flaky test
/sessions
/use 1
```

Approvals look like:

```text
/ok local:a1
/no local:a1
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Help |
| `/status` | Machine, cwd, thread, Codex status |
| `/bind <code>` | Bind this WeChat user |
| `/cwd [path]` | Show or change working directory |
| `/new [prompt]` | New thread (optional first message) |
| `/sessions` | List recent threads |
| `/use <n\|id>` | Switch thread |
| `/ok <code>` / `/no <code>` | Approve / deny |
| `/approvals` | Pending approvals |
| `/get <path>` | Send a local file/image to WeChat (under cwd / allowed roots) |
| `/usage` | Codex account / rate limits (`/useage` alias) |
| `/model` | Show the current host's model, reasoning effort, provider and service tier |
| `/model <id>` | Switch the current host's machine-wide Codex model |
| `/think <level>` | Switch reasoning effort after validating it against the current model |
| `/models` | List available models and each model's supported reasoning efforts |
| `/hosts` | List execution hosts |
| `/m <id>` | Switch host (`/m local`, `/m vps`) |
| plain text | Sent to the **current** host’s Codex |
| **image** | Downloaded → `localImage` for Codex |
| **file / video** | Saved under `{cwd}/.codex-wechat-inbox/`；路径写入 prompt 供 Codex 读取 |

### Model selection

Model commands act on the host currently selected by `/m`, so Mac and VPS
settings remain independent:

```text
/m mac
/model
/models
/model gpt-5.1-codex
/think high
```

The change is written through Codex `config/value/write` and is therefore
**machine-wide**, not per thread. It applies to subsequent turns on that
machine. Model IDs are validated with `model/list`; `/think` only accepts an
effort reported by the selected model. If a newly selected model does not
support the previous effort, codex-wechat switches it to that model's default
effort (or its first supported effort).

## Multi-host setup (one WeChat)

### 1. On each agent machine (no WeChat)

```bash
# config.yaml (or env)
# Generate once: codex-wechat agent-token
# agent:
#   host: 127.0.0.1        # recommended: connect through SSH -L
#   port: 18765
#   token: "<generated 64-character token>"

codex-wechat agent
# systemd user unit: deploy/codex-wechat-agent.service
```

Reachability options:

- **Tailscale / WireGuard** between gateway and agents (set both sides' `allow_insecure_http: true`)
- **SSH tunnel** on gateway: `ssh -N -L 18766:127.0.0.1:18765 user@agent-host`
- Do **not** expose agent port to the open internet without TLS + strong token

### 2. On the gateway (WeChat entry)

```yaml
# ~/.codex-wechat/config.yaml
machine_name: gateway-vps
default_host: local   # or vps

hosts:
  - id: local
    type: local
    label: this-vps-codex
  - id: mac
    type: http
    label: home-mac
    url: http://100.x.x.x:18765
    token: "<same generated 64-character token>"
    allow_insecure_http: true # only on a trusted encrypted private network
```

```bash
npx tsx src/cli.ts start    # scan WeChat QR once
npx tsx src/cli.ts bind
```

In WeChat:

```text
/hosts
/m mac
/status
/usage
hello from phone
/m local
```

### 3. What not to do

- Run `start` (WeChat) on two machines with the **same** WeChat — second QR **rebinds** and drops the first ([openclaw-weixin](https://github.com/Tencent/openclaw-weixin) clears stale accounts for the same `userId`).
- Run two pollers with the **same** bot credentials.

## Windows

```powershell
# PowerShell
cd codex-wechat
.\scripts\install-windows.ps1
codex login
npx tsx src/cli.ts start
# other window:
npx tsx src/cli.ts bind
```

- Config: `%USERPROFILE%\.codex-wechat\config.yaml`
- Agent: `node dist/src/cli.js agent`
- Autostart: Task Scheduler (At log on) or [NSSM](https://nssm.cc/)
- Paths: use `C:\Users\you\code` or `~/code`

## Switch Codex account (same machine)

Codex auth lives under **`$CODEX_HOME`** (default `~/.codex`). The daemon uses whatever account that profile is logged into.

```bash
# A) Replace the default account
codex logout
codex login          # scan / device code for the new account
# restart codex-wechat

# B) Keep two profiles side by side
export CODEX_HOME=~/.codex-work     # or ~/.codex-personal
codex login                         # login under this home
# start daemon with the same env:
CODEX_HOME=~/.codex-work npm start
```

In `~/.codex-wechat/config.yaml` you can document which machine/profile you use via `machine_name` (e.g. `mac-work`). Optional: set `CODEX_HOME` in systemd / launchd for that service only.

WeChat bind is **independent** of the Codex account — after switching Codex login you usually **do not** need to re-bind WeChat, but you must **restart the daemon** so it respawns `codex app-server` with the new credentials.

## Two machines (laptop + VPS)

| Host | Tip |
|------|-----|
| Laptop | `machine_name: macbook` (or similar) |
| VPS | `machine_name: vps`, separate QR login |

**Do not** copy the same iLink credentials to two hosts and poll both — cursors will fight.

On a headless VPS:

1. Install Node 22+, Codex CLI, and this repo
2. As the **same Linux user** that will run the service: `codex login` (device code / API key) — this is the **VPS Codex account** (can differ from your laptop)
3. `npx tsx src/cli.ts start` (or systemd) → scan **another** iLink QR for that host
4. `npx tsx src/cli.ts bind` → bind your WeChat to the VPS bot

Use different `machine_name` (`mac-mini` vs `vps`) so `/status` and `/usage` are unambiguous.

Template: [deploy/codex-wechat.service](./deploy/codex-wechat.service).

```bash
export CODEX_WECHAT_MACHINE=vps
export CODEX_WECHAT_CWD=/home/you/app
npx tsx src/cli.ts start
```

## CLI

```bash
npx tsx src/cli.ts start     # daemon (default)
npx tsx src/cli.ts doctor    # health check
npx tsx src/cli.ts bind      # print bind code
npx tsx src/cli.ts unbind
npx tsx src/cli.ts init      # write example config
npx tsx src/cli.ts agent-token # generate a 256-bit Agent token
npx tsx scripts/probe-codex.ts
```

## Configuration

Priority: **environment variables > `config.yaml` > defaults**.

| Variable | Meaning |
|----------|---------|
| `CODEX_WECHAT_MACHINE` | Display name in `/status` |
| `CODEX_WECHAT_CWD` | Default cwd (else `~/code`) |
| `CODEX_WECHAT_CODEX_PATH` | Path to `codex` binary |
| `CODEX_WECHAT_CODEX_SANDBOX` | Codex sandbox: `read-only` (default), `workspace-write`, or `danger-full-access` |
| `CODEX_WECHAT_CODEX_APPROVAL_POLICY` | Approval policy: `on-request` (default), `untrusted`, or `never` |
| `CODEX_WECHAT_CONFIG` | Config file path |
| `CODEX_WECHAT_STATE` | State file path |
| `CODEX_WECHAT_WECHAT_DIR` | iLink credential storage |
| `CODEX_WECHAT_APPROVAL_TIMEOUT` | Approval timeout (seconds) |
| `CODEX_WECHAT_MAX_REPLY_CHARS` | Max chars per WeChat bubble |
| `CODEX_WECHAT_MAX_MEDIA_BYTES` | Max inbound media size |
| `CODEX_WECHAT_MAX_ATTACHMENT_COUNT` | Max attachments per message |
| `CODEX_WECHAT_MAX_ATTACHMENT_TOTAL_BYTES` | Max aggregate attachment bytes |
| `CODEX_WECHAT_INBOX_MAX_BYTES` | Per-workspace inbox disk quota |
| `CODEX_WECHAT_BIND_TTL_SEC` | Bind code TTL (default 300) |
| `CODEX_WECHAT_BIND_MAX_FAILS` | Failed binds before void (default 5) |
| `CODEX_WECHAT_AGENT_HOST` / `PORT` / `TOKEN` | Agent listener and 256-bit token |
| `CODEX_WECHAT_AGENT_ALLOW_INSECURE_HTTP` | Explicitly permit non-loopback HTTP on a trusted private network |
| `CODEX_WECHAT_AGENT_MAX_BODY_BYTES` | Agent request-body limit |
| `CODEX_WECHAT_HTTP_TIMEOUT_MS` | Gateway control-request timeout |
| `CODEX_WECHAT_PROMPT_TIMEOUT_MS` | Remote prompt timeout |
| `CODEX_WECHAT_MAX_HTTP_RESPONSE_BYTES` | Gateway response-body limit |

Default data dir: `~/.codex-wechat/` (`state.json`, `wechat/`, optional `config.yaml`).
Example: [config.example.yaml](./config.example.yaml).

### Path policy (security)

| Action | Scope |
|--------|--------|
| `/cwd` | `allowed_roots`, or `default_cwd` tree if roots unset |
| `/get` | **Current session cwd only** (realpath; blocks symlink escape) |
| Default cwd | `~/code` if unset — **not** `$HOME` |

Directory roots and selected cwd values are canonicalized with `realpath`; a
symlink inside an allowed root cannot redirect `/cwd`, `/get`, Codex, or the
attachment inbox outside that root.

### Sandbox and write approvals

WeChat-driven threads default to `codex_sandbox_mode: read-only` and
`codex_approval_policy: on-request`. codex-wechat reapplies these settings when
starting or resuming a thread. A requested write, command escalation, or extra
permission is sent to WeChat and remains blocked until `/ok <host>:<code>`;
`/no` and approval timeout deny it. Modern permission grants are limited to the
requested profile for the current turn.

`allowed_roots` controls cwd selection, `/get`, and attachment placement. It is
not a confidentiality boundary for files that the Codex process's OS account
can read: the standard read-only sandbox may still read host files. For strict
read isolation, run the service as a dedicated non-root user or in a container
with only the required project directories mounted.

## Version matrix

| codex-wechat | Node | Codex CLI (tested) |
|--------------|------|---------------------|
| 0.1.x | ≥ 22 | 0.144.x |

`codex app-server` is experimental; pin Codex if upgrades break the protocol.

## Project layout

```text
src/
  main.ts / cli.ts
  config.ts / state.ts / handler.ts / approvals.ts
  codex/          app-server client
  rpc/            JSON-RPC + stdio transport
  wechat/         iLink bot wrapper
deploy/codex-wechat.service
```

## Compared to related projects

| Project | Relation |
|---------|----------|
| [wechatbot](https://github.com/corespeed-io/wechatbot) | iLink **SDK** we depend on |
| [Comote](https://github.com/GavinYangAI/Comote) | Fuller multi-IM product |
| [Codex_iLink](https://github.com/Obito-404/Codex_iLink) | Windows Desktop–oriented bridge |

This repo aims to stay a **minimal, auditable per-host daemon**.

## Acknowledgements

- [@wechatbot/wechatbot](https://github.com/corespeed-io/wechatbot) — iLink client
- [OpenAI Codex](https://github.com/openai/codex) — `app-server` protocol
- Public docs/implementations of iLink and app-server patterns in the community

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please read [SECURITY.md](./SECURITY.md) before reporting sensitive issues.

## License

[MIT](./LICENSE) © 2026 ericheung
