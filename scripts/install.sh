#!/usr/bin/env bash
# Install pi-subagents into the user's pi agent directory by symlinking.
# Usage: ./scripts/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/agents"

ln -sfn "$REPO_DIR" "$AGENT_DIR/extensions/pi-subagents"
for f in "$REPO_DIR"/agents/*.md; do
  ln -sf "$f" "$AGENT_DIR/agents/$(basename "$f")"
done

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "node_modules missing — run: (cd '$REPO_DIR' && npm install)"
fi

cat <<EOF

Installed:
  extension : $AGENT_DIR/extensions/pi-subagents -> $REPO_DIR
  roles     : $AGENT_DIR/agents/{scout,planner,worker,reviewer}.md (symlinked)

Next steps:
  1. cp $REPO_DIR/examples/pi-subagents.json $AGENT_DIR/pi-subagents.json
  2. Edit roles' fallback lists, proxies and providers.
  3. Start pi and run /roles to verify.
EOF
