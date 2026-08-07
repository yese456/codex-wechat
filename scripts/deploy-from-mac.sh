#!/usr/bin/env bash
# Deploy codex-wechat from this Mac to a remote VPS via rsync + remote install.
#
# Usage:
#   bash scripts/deploy-from-mac.sh root@1.2.3.4
#   bash scripts/deploy-from-mac.sh -i ~/.ssh/id_ed25519 ubuntu@1.2.3.4
#
# Env:
#   REMOTE_DIR=~/apps/codex-wechat
#   CODEX_WECHAT_MACHINE=vps
#   CODEX_WECHAT_CWD=~/code

set -euo pipefail

SSH_OPTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i)
      SSH_OPTS+=(-i "$2")
      shift 2
      ;;
    -o)
      SSH_OPTS+=(-o "$2")
      shift 2
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 [-i key] user@host" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Use absolute-style remote path with $HOME so tilde is never left literal.
REMOTE_DIR="${REMOTE_DIR:-\$HOME/apps/codex-wechat}"
MACHINE="${CODEX_WECHAT_MACHINE:-vps}"
CWD_DEFAULT="${CODEX_WECHAT_CWD:-\$HOME/code}"

echo "==> Deploy $ROOT -> $TARGET:$REMOTE_DIR"

# Resolve remote home once so rsync and install use the same path
REMOTE_HOME="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'printf %s "$HOME"')"
REMOTE_DIR_EXPANDED="${REMOTE_DIR//\$HOME/$REMOTE_HOME}"
REMOTE_DIR_EXPANDED="${REMOTE_DIR_EXPANDED/#\~/$REMOTE_HOME}"
CWD_EXPANDED="${CWD_DEFAULT//\$HOME/$REMOTE_HOME}"
CWD_EXPANDED="${CWD_EXPANDED/#\~/$REMOTE_HOME}"

echo "    remote_home=$REMOTE_HOME"
echo "    remote_dir=$REMOTE_DIR_EXPANDED"

ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR_EXPANDED'"

RSYNC_SSH="ssh"
for o in "${SSH_OPTS[@]}"; do
  RSYNC_SSH+=" $(printf '%q' "$o")"
done

rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude '.codex-wechat-inbox' \
  --exclude '._*' \
  -e "$RSYNC_SSH" \
  "$ROOT/" "$TARGET:$REMOTE_DIR_EXPANDED/"

ssh "${SSH_OPTS[@]}" "$TARGET" \
  "export CODEX_WECHAT_MACHINE='$MACHINE' CODEX_WECHAT_CWD='$CWD_EXPANDED' INSTALL_DIR='$REMOTE_DIR_EXPANDED'; bash '$REMOTE_DIR_EXPANDED/scripts/install-vps.sh'"

echo ""
echo "==> Remote install finished."
echo "    SSH in and run:"
echo "      ssh ${SSH_OPTS[*]} $TARGET"
echo "      codex login"
echo "      systemctl --user start codex-wechat"
echo "      journalctl --user -u codex-wechat -f"
