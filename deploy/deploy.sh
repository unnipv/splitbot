#!/usr/bin/env bash
# Run FROM your laptop: ./deploy/deploy.sh pi@raspberrypi.local [remote_dir]
# Syncs the code to the Pi and restarts the service. On the first run it also copies .env and the
# Splitwise token (never the WhatsApp session — link WhatsApp from the Pi's dashboard).
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [remote_dir]}"
DIR="${2:-splitbot}"
cd "$(dirname "$0")/.."

ssh "$HOST" "mkdir -p $DIR/data"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env --exclude .git --exclude .claude \
  ./ "$HOST:$DIR/"

# Secrets: copy only if missing on the Pi so remote edits aren't clobbered.
if ! ssh "$HOST" "test -f $DIR/.env"; then
  echo "→ Copying .env (first deploy)"
  scp -q .env "$HOST:$DIR/.env"
fi
if [ -f data/splitwise-token.json ] && ! ssh "$HOST" "test -f $DIR/data/splitwise-token.json"; then
  echo "→ Copying Splitwise token (first deploy)"
  scp -q data/splitwise-token.json "$HOST:$DIR/data/splitwise-token.json"
fi

if ssh "$HOST" "systemctl list-unit-files splitbot.service >/dev/null 2>&1 && systemctl is-enabled splitbot >/dev/null 2>&1"; then
  ssh "$HOST" "cd $DIR && npm ci --omit=dev --no-audit --no-fund && sudo systemctl restart splitbot"
  echo "✅ Deployed and restarted"
else
  echo "→ First install"
  ssh "$HOST" "cd $DIR && ./deploy/install-pi.sh"
fi
