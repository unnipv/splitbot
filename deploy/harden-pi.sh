#!/usr/bin/env bash
# Run ON the Pi (install-pi.sh calls it). Makes an unattended Pi recover by itself:
#  - persistent journal, so the cause of a crash survives the reboot
#  - hardware watchdog: a frozen system is rebooted by the SoC
#  - Wi-Fi power saving off (a common cause of Pi Wi-Fi dropouts)
#  - network watchdog: restart Wi-Fi after ~6 min without the router, reboot after ~20 min
set -euo pipefail

echo "→ Persistent journal (capped at 200 MB)"
sudo mkdir -p /var/log/journal /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' | sudo tee /etc/systemd/journald.conf.d/splitbot.conf >/dev/null
sudo systemd-tmpfiles --create --prefix /var/log/journal
sudo systemctl restart systemd-journald

echo "→ Hardware watchdog"
sudo mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nRuntimeWatchdogSec=15\nRebootWatchdogSec=2min\n' | sudo tee /etc/systemd/system.conf.d/watchdog.conf >/dev/null
sudo systemctl daemon-reexec

if [ -d /etc/NetworkManager/conf.d ]; then
  echo "→ Wi-Fi power saving off (applies on next Wi-Fi connect)"
  printf '[connection]\nwifi.powersave = 2\n' | sudo tee /etc/NetworkManager/conf.d/wifi-powersave-off.conf >/dev/null
fi

echo "→ Network watchdog"
sudo tee /usr/local/bin/net-watchdog >/dev/null <<'EOF'
#!/usr/bin/env bash
# Called every 2 minutes. Counts consecutive failures to reach the default gateway.
STATE=/run/net-watchdog.fails
GW=$(ip route | awk '/^default/ {print $3; exit}')
if [ -n "$GW" ] && ping -c 2 -W 3 "$GW" >/dev/null 2>&1; then
  rm -f "$STATE"; exit 0
fi
FAILS=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILS" > "$STATE"
logger -t net-watchdog "gateway ${GW:-none} unreachable (${FAILS} checks in a row)"
if [ "$FAILS" -ge 10 ]; then
  logger -t net-watchdog "rebooting"; systemctl reboot
elif [ "$FAILS" -eq 3 ] || [ "$FAILS" -eq 6 ]; then
  logger -t net-watchdog "restarting Wi-Fi"
  nmcli radio wifi off; sleep 5; nmcli radio wifi on
fi
EOF
sudo chmod 755 /usr/local/bin/net-watchdog
sudo tee /etc/systemd/system/net-watchdog.service >/dev/null <<'EOF'
[Unit]
Description=Recover lost network connectivity
[Service]
Type=oneshot
ExecStart=/usr/local/bin/net-watchdog
EOF
sudo tee /etc/systemd/system/net-watchdog.timer >/dev/null <<'EOF'
[Unit]
Description=Check network connectivity every 2 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now net-watchdog.timer >/dev/null
echo "✅ Hardened"
