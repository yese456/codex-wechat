#!/usr/bin/env bash
# One-shot install for Linux VPS (Ubuntu/Debian/RHEL-ish).
# Run as the user that will own Codex + the daemon (NOT necessarily root for runtime).
#
#   curl -fsSL ... | bash   # or:
#   bash scripts/install-vps.sh
#
# Env overrides:
#   CODEX_WECHAT_MACHINE=vps
#   CODEX_WECHAT_CWD=$HOME/code
#   INSTALL_DIR=$HOME/apps/codex-wechat
#   NODE_MAJOR=22

set -euo pipefail

MACHINE="${CODEX_WECHAT_MACHINE:-vps}"
# Expand ~ if caller passed a tilde path in quotes
_expand() {
  local p="$1"
  if [[ "$p" == ~* ]]; then
    p="${p/#\~/$HOME}"
  fi
  # shellcheck disable=SC2088
  printf '%s' "$p"
}
INSTALL_DIR="$(_expand "${INSTALL_DIR:-$HOME/apps/codex-wechat}")"
CWD_DEFAULT="$(_expand "${CODEX_WECHAT_CWD:-$HOME/code}")"
NODE_MAJOR="${NODE_MAJOR:-22}"
REPO_URL="${REPO_URL:-}"  # optional git clone URL; empty = use existing tree

echo "==> codex-wechat VPS install"
echo "    user=$(whoami)  home=$HOME"
echo "    install_dir=$INSTALL_DIR"
echo "    machine=$MACHINE  cwd=$CWD_DEFAULT"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --- Node 22 ---
if need_cmd node; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR_HAVE="${NODE_VER%%.*}"
  echo "    node v$NODE_VER"
  if [[ "$NODE_MAJOR_HAVE" -lt "$NODE_MAJOR" ]]; then
    echo "!! Node $NODE_VER < $NODE_MAJOR — please upgrade (nvm/nodesource) and re-run."
    exit 1
  fi
else
  echo "!! node not found. Install Node $NODE_MAJOR+ first, e.g.:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  echo "   # or: nvm install $NODE_MAJOR"
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$(dirname "$CWD_DEFAULT")"
mkdir -p "$CWD_DEFAULT"

# --- Source tree ---
if [[ -n "$REPO_URL" ]]; then
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
elif [[ ! -f "$INSTALL_DIR/package.json" ]]; then
  echo "!! No package.json in $INSTALL_DIR and REPO_URL empty."
  echo "   rsync the project here first, or set REPO_URL=https://github.com/YOU/codex-wechat.git"
  exit 1
fi

cd "$INSTALL_DIR"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run typecheck
npm test
npm run build

# --- Codex CLI ---
if ! need_cmd codex; then
  echo "==> Installing @openai/codex globally"
  npm install -g @openai/codex
fi
echo "    codex: $(command -v codex)  $(codex --version 2>/dev/null || true)"

# --- config ---
CFG_DIR="${XDG_CONFIG_HOME:-$HOME}/.codex-wechat"
# default data dir is ~/.codex-wechat
CFG_DIR="$HOME/.codex-wechat"
mkdir -p "$CFG_DIR"
if [[ ! -f "$CFG_DIR/config.yaml" ]]; then
  AGENT_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  cat >"$CFG_DIR/config.yaml" <<YAML
machine_name: ${MACHINE}
default_cwd: ${CWD_DEFAULT}
# allowed_roots:
#   - ${CWD_DEFAULT}
# codex_bin: $(command -v codex)
approval_timeout_sec: 300
max_reply_chars: 3500
max_media_bytes: 26214400
bind_ttl_sec: 300
bind_max_fails: 5
agent:
  host: 127.0.0.1
  port: 18765
  token: ${AGENT_TOKEN}
YAML
  chmod 600 "$CFG_DIR/config.yaml"
  echo "==> wrote $CFG_DIR/config.yaml"
else
  echo "==> keep existing $CFG_DIR/config.yaml"
fi

# --- systemd user unit (or system unit template) ---
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex)"
PATH_EXTRA="$(dirname "$NODE_BIN"):$(dirname "$CODEX_BIN"):/usr/local/bin:/usr/bin"

cat >"$UNIT_DIR/codex-wechat.service" <<UNIT
[Unit]
Description=codex-wechat (WeChat remote for Codex)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=PATH=${PATH_EXTRA}
Environment=CODEX_WECHAT_MACHINE=${MACHINE}
Environment=CODEX_WECHAT_CWD=${CWD_DEFAULT}
Environment=HOME=${HOME}
# Environment=CODEX_HOME=${HOME}/.codex
ExecStart=${NODE_BIN} ${INSTALL_DIR}/dist/src/cli.js start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

echo "==> wrote $UNIT_DIR/codex-wechat.service"

if need_cmd systemctl; then
  systemctl --user daemon-reload || true
  # linger so user services survive logout
  if need_cmd loginctl; then
    loginctl enable-linger "$(whoami)" 2>/dev/null || \
      echo "   (optional) sudo loginctl enable-linger $(whoami)"
  fi
  systemctl --user enable codex-wechat.service || true
  echo ""
  echo "==> Next steps on this VPS:"
  echo "   1) codex login          # MUST succeed before start"
  echo "   2) systemctl --user start codex-wechat"
  echo "   3) journalctl --user -u codex-wechat -f   # scan QR URL"
  echo "   4) npx tsx src/cli.ts bind               # then /bind <code> in WeChat"
else
  echo "==> No systemctl — start manually:"
  echo "   cd $INSTALL_DIR && npx tsx src/cli.ts start"
fi

echo "Done."
