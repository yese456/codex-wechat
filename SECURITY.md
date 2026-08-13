# Security Policy

## What this tool can do

`codex-wechat` lets a **single bound WeChat identity** drive **Codex on the machine where the daemon runs**. That is effectively remote control of a coding agent that can read/write files and run commands (subject to Codex sandbox and your approval settings).

Treat a successful bind like giving that phone access to your development workspace.

## Built-in controls

- Only the WeChat user who completes `/bind <code>` is accepted; everyone else is ignored.
- Bind codes are high-entropy (128-bit hex), short-lived (default 5 minutes), and **invalidated after too many failed attempts** (default 5).
- Dangerous Codex actions surface as WeChat approvals (`/ok` / `/no`); approvals time out to **deny**.
- WeChat-driven Codex threads explicitly default to `read-only` plus `on-request`; the policy is reapplied on thread start/resume. Modern permission approvals grant only the requested profile for the current turn.
- The bound user can query and change the selected host's machine-wide policy with `/permissions`, `/sandbox`, and `/approval`. Any change that reduces protection requires a second matching `confirm` command within 60 seconds; the effective policy is persisted across service restarts.
- **`/get` only sends files under the current session `cwd`** (realpath-checked; no home-wide read).
- **`/cwd` is limited to `allowed_roots`**, or if unset, only the `default_cwd` tree (never the entire `$HOME` by default).
- Default workspace is `~/code` when `default_cwd` is not configured — not `$HOME`.
- The WeChat gateway does **not** open a public inbound port for chat (iLink long-poll is outbound).
- **Agent HTTP** uses constant-time Bearer-token comparison and authenticated health checks. Tokens shorter than 32 characters and known placeholders are rejected.
- Agent defaults to loopback. Plain HTTP on a non-loopback address is rejected unless `allow_insecure_http` is explicitly enabled for a trusted encrypted private network such as Tailscale/WireGuard. Prefer loopback plus SSH tunneling or TLS.
- Agent and gateway enforce request, response, attachment-count, aggregate-size, per-file, timeout, and inbox-quota limits.
- State writes use a lock plus atomic rename; data/state/config permissions are tightened on POSIX systems.
- **One WeChat user ≈ one iLink bot session** (Tencent openclaw-weixin clears older accounts for the same `userId`). Multi-machine: one gateway + agents, not multiple WeChat logins.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports (token leaks, auth bypass, RCE via message handling, etc.).

Prefer:

1. GitHub **Private vulnerability reporting** on this repository (if enabled), or
2. Contact the maintainer via their GitHub profile.

Include: affected version/commit, reproduction steps, impact, and whether credentials were exposed.

## If credentials may be leaked

1. Stop the daemon.
2. Run `codex-wechat unbind` (or delete `~/.codex-wechat/state.json`).
3. Delete WeChat storage under `~/.codex-wechat/wechat/` and re-login with a fresh QR scan.
4. Review Codex auth under `~/.codex` if you suspect broader compromise.
5. Rotate any secrets that may have appeared in chat logs or screenshots.

## Out of scope / user responsibility

- Misconfiguration (binding a shared phone, always approving dangerous commands).
- Deliberately confirming `danger-full-access`, `approval=never`, or another less restrictive remote policy.
- Pointing `default_cwd` / `allowed_roots` at directories that contain secrets.
- Upstream changes to Tencent iLink or OpenAI Codex app-server protocol.
- Running the process as root.

`allowed_roots` is an application navigation/export boundary, not a complete
read ACL for the Codex child process. The read-only sandbox blocks writes but
may read files visible to its OS user. Use a dedicated non-root account,
container mounts, or OS ACLs when projects must be isolated from other host
data. An approved elevation while running as root has root-level impact.

The supplied systemd Agent template deliberately uses `YOUR_USER`, loopback,
an external mode-0600 token file, and process hardening. Replace placeholders;
do not remove the non-root `User=`/`Group=` directives.
