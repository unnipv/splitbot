#!/usr/bin/env bash
# Run ON the Raspberry Pi, from the splitbot folder: ./deploy/install-pi.sh
# Installs Node 24 (if needed) and dependencies, and sets splitbot up as an always-on systemd service.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(id -un)"

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }

if [ "$(node_major)" -lt 24 ]; then
  echo "→ Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "→ Node $(node -v)"

cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data && chmod 700 data  # WhatsApp session + Splitwise token live here
[ -f .env ] || { cp .env.example .env; echo "⚠️  Created .env from .env.example — fill it in."; }
chmod 600 .env

echo "→ Installing systemd service"
sudo tee /etc/systemd/system/splitbot.service >/dev/null <<EOF
[Unit]
Description=Splitbot (WhatsApp → Splitwise)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) src/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# Keep memory in check on small Pis
Environment=NODE_OPTIONS=--max-old-space-size=256

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable splitbot
sudo systemctl restart splitbot
sleep 2
systemctl --no-pager status splitbot | head -5
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-3000}

# Private HTTPS URL on the tailnet (Serve, not Funnel: only your own devices can reach it).
TS_URL=""
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  echo "→ Exposing the dashboard on your tailnet with Tailscale Serve"
  # `serve` blocks waiting for the admin to enable Serve on the tailnet, so cap it and surface the link instead.
  OUT=$(sudo timeout 15 tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}" 2>&1 || true)
  if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then
    TS_URL="https://$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
  else
    echo "⚠️  Tailscale Serve isn't enabled on your tailnet yet. Enable it here, then rerun this script:"
    echo "$OUT" | grep -o 'https://login.tailscale.com[^ ]*' | head -1 | sed 's/^/     /'
    echo "   Meanwhile the dashboard is reachable on the tailnet at http://$(tailscale ip -4 | head -1):${PORT}"
  fi
fi

echo
echo "✅ Running."
echo "   LAN:       http://$(hostname -I | awk '{print $1}'):${PORT}"
[ -n "$TS_URL" ] && echo "   Tailscale: ${TS_URL}"
echo "   Logs:      journalctl -u splitbot -f"
