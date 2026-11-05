#!/usr/bin/env bash
# Installs the Server tab's collector on the VPS. Run once, with sudo:
#
#   sudo bash ~/nexus-backend-prod/scripts/server-collector/install.sh
#
# Safe to re-run: it updates the script and skips anything already in place.
#
# What it does:
#   1. Copies nexus-collect.py to /usr/local/lib/nexus-server/ (root-owned, so
#      no app account can change what root runs).
#   2. Adds an nginx log that records the site name of every request
#      (/var/log/nginx/traffic.log). The stock access.log has no site name, so
#      traffic could not be split by app. The existing logs are left as they are.
#   3. Runs the collector every minute from /etc/cron.d/nexus-server.
#   4. Runs it once now and prints what it saw.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB=/usr/local/lib/nexus-server
OUT=/var/lib/nexus-server

echo "1/4 collector script"
install -d -m 755 -o root -g root "$LIB"
install -m 755 -o root -g root "$HERE/nexus-collect.py" "$LIB/nexus-collect.py"

echo "2/4 nginx traffic log"
CONF=/etc/nginx/conf.d/nexus-traffic.conf
LINE='access_log /var/log/nginx/traffic.log nexus_traffic;'
cat > "$CONF" <<'NGINX'
# Added by nexus-backend/scripts/server-collector/install.sh for the Nexus Server tab.
# One tab-separated line per request with the site name ($host), so traffic can
# be counted per app. Read by /usr/local/lib/nexus-server/nexus-collect.py.
log_format nexus_traffic '$time_iso8601\t$host\t$status\t$request_time\t$remote_addr\t$body_bytes_sent';
access_log /var/log/nginx/traffic.log nexus_traffic;
NGINX
if ! grep -qE '^\s*include\s+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf; then
  echo "   nginx.conf does not include conf.d/*.conf; add the two lines in $CONF to its http block by hand." >&2
fi
# A server block with its own access_log stops inheriting the http-level one,
# so those sites need the line too. Only sites that already set access_log are touched.
for f in /etc/nginx/sites-enabled/*; do
  real="$(readlink -f "$f")"
  if grep -qE '^\s*access_log\s' "$real" && ! grep -q 'nexus_traffic' "$real"; then
    cp -a "$real" "$real.bak-nexus-$(date +%Y%m%d%H%M%S)"
    # After each access_log inside a server block, add ours with the same indent.
    sed -i -E "/^\s*access_log\s/{p;s#access_log.*#$LINE#}" "$real"
    echo "   added to $(basename "$real") (backup kept next to it)"
  fi
done
if nginx -t 2>/tmp/nexus-nginx-test; then
  systemctl reload nginx
  echo "   nginx reloaded"
else
  cat /tmp/nexus-nginx-test >&2
  echo "   nginx test failed: removing $CONF and restoring backups." >&2
  rm -f "$CONF"
  for b in /etc/nginx/sites-available/*.bak-nexus-*; do [[ -e "$b" ]] && mv -f "$b" "${b%.bak-nexus-*}"; done
  exit 1
fi

echo "3/4 cron"
cat > /etc/cron.d/nexus-server <<CRON
# Nexus Server tab: collect server and app stats every minute (read-only).
* * * * * root /usr/bin/python3 $LIB/nexus-collect.py >>/var/log/nexus-collect.log 2>&1
CRON
chmod 644 /etc/cron.d/nexus-server

echo "4/4 first run"
/usr/bin/python3 "$LIB/nexus-collect.py"
python3 - "$OUT/snapshot.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print(f"   pm2 processes: {len(s['pm2'])}, containers: {len(s['docker'])}, databases: {len(s['databases'])}")
print(f"   traffic log: {'yes' if s['trafficLog'] else 'not written yet (fills in as requests arrive)'}")
PY
echo "Done. Nexus reads $OUT; open Dashboard → All apps → Server."
