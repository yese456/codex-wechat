# codex-wechat

[![CI](https://github.com/yese456/codex-wechat/actions/workflows/ci.yml/badge.svg)](https://github.com/yese456/codex-wechat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

[中文介绍](./README.zh-CN.md) · English

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
git clone https://github.com/yese456/codex-wechat.git
cd codex-wechat
npm install
npm run typecheck

# 首次运行会进入交互向导：
# 1) Host / Gateway 或 Agent
# 2) 默认项目路径
# 3) Codex 沙箱权限
npm start

# 也可提前配置；重新配置使用 init --force
npx tsx src/cli.ts init

# Gateway 首次启动会打印微信二维码；另开终端生成绑定码
npx tsx src/cli.ts bind
# in WeChat: /bind <code>
```

Then:

```text
/help
/status
/projects
/project 1
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
| `/projects` | List first-level projects under `allowed_roots` |
| `/project <n\|name\|id>` | Switch project by sequence, unique name, or short ID |
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
| `/permissions` | Show the current host's sandbox and approval policy |
| `/sandbox [mode]` | Show or switch the current host's machine-wide sandbox mode |
| `/approval [policy]` | Show or switch the current host's machine-wide approval policy |
| `/hosts` | List execution hosts |
| `/m <id>` | Switch host using an exact ID from `/hosts` (for example, `/m local` or `/m mac`) |
| plain text | Sent to the **current** host’s Codex; busy hosts queue requests in FIFO order |
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

### Sandbox and approval switching

Security policy commands also act on the host selected by `/m`:

```text
/permissions
/sandbox read-only
/sandbox workspace-write
/sandbox danger-full-access
/approval untrusted
/approval on-request
/approval never
```

Supported sandbox modes are `read-only`, `workspace-write`, and
`danger-full-access`. Supported approval policies are `untrusted`,
`on-request`, and `never`. The selected values are written to that machine's
Codex global config, applied to the next turn (including resumed threads), and
stored as a codex-wechat runtime override so they survive service restarts.

Any change that reduces protection requires a second command within 60
seconds, for example:

```text
/sandbox workspace-write
/sandbox workspace-write confirm
```

Switching back to a more restrictive value applies immediately. Treat
`danger-full-access` or `never` as high risk, especially when the service runs
as root.

### Codex task completion notifications

Codex can call codex-wechat after an `agent-turn-complete` event so a task
started outside WeChat still produces a WeChat completion message. Enable the
persistent outbox on the Agent/local Codex machine:

```yaml
# ~/.codex-wechat/config.yaml
completion_notifications:
  enabled: true
  queue_path: ~/.codex-wechat/completions/outbox.json
  delivery_path: ~/.codex-wechat/completions/delivery.json
  poll_interval_ms: 5000
  batch_size: 20
  callbacks:
    # Optional: preserve an existing Computer Use notify callback.
    - argv: ["/absolute/path/to/existing-computer-use-notify"]
      timeout_ms: 10000
```

Then point Codex's global notify command at the installed CLI in
`~/.codex/config.toml`:

```toml
notify = ["codex-wechat", "notify-dispatch"]
```

For a source checkout without a globally installed CLI, use absolute paths:

```toml
notify = ["/absolute/path/to/node", "/absolute/path/to/codex-wechat/dist/src/cli.js", "notify-dispatch"]
```

The dispatcher deliberately loads only `CODEX_WECHAT_CONFIG` (when explicitly
set) or `~/.codex-wechat/config.yaml`; it never trusts a repository-local
`config.yaml` for executable callbacks.

Restart the Agent/Gateway after changing YAML. Only the Gateway sends WeChat;
remote Agents expose an authenticated completion poll/ACK API. Synchronous
prompts initiated from WeChat are suppressed once, preventing a normal reply
and a second completion bubble for the same turn. Delivery records are written
before Agent ACK, so an ACK retry does not resend the same WeChat message.

Do not configure `queue_path` and `delivery_path` to the same file. They also
must not overlap `state_path` or the YAML config file. The implementation
preserves corrupted JSON files and reports an error instead of silently
resetting them.

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
- **Reverse SSH tunnel** from a Mac/agent to the gateway:
  `ssh -NT -R 127.0.0.1:18765:127.0.0.1:18765 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 user@gateway`
- Do **not** expose agent port to the open internet without TLS + strong token

Run a long-lived reverse tunnel under `launchd` or `autossh` so it restarts
after Mac sleep, a network change, or a dead SSH session. Verify it from the
gateway in three layers:

```bash
# 1. The SSH listener exists.
ss -ltnp | rg 18765

# 2. The tunnel reaches a running Agent.
curl -fsS --max-time 5 http://127.0.0.1:18765/health
```

Then verify the configured token and Codex app-server in WeChat:

```text
/m mac
/status
```

`ECONNREFUSED` means the tunnel listener is absent. A listener with a failing
`/health` means the tunnel cannot reach the Agent. A successful `/health` but
failing `/status` points to gateway token/configuration or the Agent's Codex
app-server.

A listening port can still be a half-dead tunnel. If WeChat remains at
`Codex 处理中…`, `/health` times out, and `ss -tanp | rg 18765` shows many
`CLOSE-WAIT` or `FIN-WAIT-2` sockets, the request is not evidence that Codex is
still computing. The gateway waits up to `CODEX_WECHAT_PROMPT_TIMEOUT_MS`
(default: 900000 ms), so the visible failure may be delayed for 15 minutes.

Recover in this order:

1. Send `/m local` so new requests use the gateway while Mac is unavailable.
2. On the Mac, call `curl -fsS --max-time 5 http://127.0.0.1:18765/health`.
3. If the Mac-local check fails, restart the Agent. If it succeeds, restart
   only the reverse SSH tunnel.
4. Repeat the gateway `/health` and WeChat `/status` checks, then resend the
   original task. An already-hung remote prompt does not recover its response.

### 2. On the gateway (WeChat entry)

```yaml
# ~/.codex-wechat/config.yaml
machine_name: gateway-vps
default_host: local   # must match an id under hosts

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

`machine_name` is only the display name shown by `/status`; it is not
automatically a host ID. If `/m <name>` reports `未知 host`, run `/hosts` and
use one of the exact IDs listed there. The selected host is persisted in
`state.json`, so it can remain `mac` after a restart even when
`default_host: local`; switch back with `/m local` when the Mac Agent or its
tunnel is offline.

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

When deploying from a Mac with `scripts/deploy-from-mac.sh`, the script mirrors
the repository into `REMOTE_DIR` (default: `$HOME/apps/codex-wechat`) using
`rsync --delete`. This overwrites or removes VPS-only changes inside that
project directory. Runtime data is separate: the script does not sync
`$HOME/.codex-wechat/`, and `install-vps.sh` preserves an existing
`config.yaml`, so `config.yaml`, `state.json`, and WeChat credentials survive a
code deployment. Never set `REMOTE_DIR` to `$HOME` or `$HOME/.codex-wechat`.

There is no bundled VPS-to-Mac sync script. Prefer Git for that direction. If
you use `rsync --delete` manually, target only the Mac project directory and
exclude `config.yaml`, `config.local.yaml`, `*.local.yaml`, `state.json`, and
`.codex-wechat/`. Otherwise rsync can overwrite/delete a project-local config;
if it creates one, that file also takes precedence over the Mac user's
`~/.codex-wechat/config.yaml`.

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
npx tsx src/cli.ts init      # run the first-use setup wizard
npx tsx src/cli.ts notify-dispatch '<codex-notify-json>' # Codex notify target
npx tsx src/cli.ts agent-token # generate a 256-bit Agent token
npx tsx scripts/probe-codex.ts
```

## Configuration

Config-file priority is **`CODEX_WECHAT_CONFIG` > project `config.yaml` >
project `config.local.yaml` > `~/.codex-wechat/config.yaml` > defaults**.
Individual environment variables override the values loaded from that file.

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
| `/cwd`, `/projects`, `/project` | `allowed_roots`, or `default_cwd` tree if roots unset |
| `/get` | **Current session cwd only** (realpath; blocks symlink escape) |
| Default cwd | `~/code` if unset — **not** `$HOME` |

Directory roots and selected cwd values are canonicalized with `realpath`; a
symlink inside an allowed root cannot redirect `/cwd`, `/get`, Codex, or the
attachment inbox outside that root.

### Sandbox and write approvals

WeChat-driven threads default to `codex_sandbox_mode: read-only` and
`codex_approval_policy: on-request`. codex-wechat reapplies these settings when
starting or resuming a thread. `/sandbox` and `/approval` can change the
selected machine's effective global policy; less restrictive changes require a
second `confirm` command and are persisted for restart. A requested write,
command escalation, or extra
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
  completions/    notify dispatcher, persistent outbox and delivery worker
  hosts/          local/HTTP execution hosts and project selection
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
