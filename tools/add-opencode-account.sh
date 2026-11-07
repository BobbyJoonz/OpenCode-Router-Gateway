#!/bin/bash
# tools/add-opencode-account.sh — add one OpenCode account (key) to the gateway.
# Usage: bash tools/add-opencode-account.sh <slot-number> <oc_sk_...>
set -euo pipefail

SLOT="${1:?usage: add-opencode-account.sh <slot> <oc_sk_key>}"
KEY="${2:?usage: add-opencode-account.sh <slot> <oc_sk_key>}"
APP=/opt/opencode-router-local
ENV="$APP/.env"
B=http://100.91.206.72:3011
MGMT=$(grep -A1 'MANAGEMENT KEY' /root/opencode-router-access.txt | tail -1 | tr -d '[:space:]')
NAME="oc-acct-$SLOT"
VAR="OPENCODE_KEY_$SLOT"
MODEL="${OPENCODE_FREE_MODEL:-deepseek-v4.1-flash-free}"

echo "== env: $VAR =="
grep -vE "^${VAR}=" "$ENV" > "$ENV.tmp" 2>/dev/null || true
echo "${VAR}=${KEY}" >> "$ENV.tmp"
mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"

echo "== provider: $NAME =="
EXISTING=$(curl -s -m 10 "$B/api/providers" -H "authorization: Bearer $MGMT" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=(j.providers||[]).find(x=>x.name===process.argv[1]);console.log(p?p.id:"")})' "$NAME")
if [ -n "$EXISTING" ]; then
  PID="$EXISTING"
  curl -s -m 10 -X PATCH "$B/api/providers/$PID" -H "authorization: Bearer $MGMT" -H 'content-type: application/json' \
    -d "{\"key_env\":\"$VAR\",\"enabled\":true}" >/dev/null
  echo "  updated provider $PID"
else
  PID=$(curl -s -m 10 -X POST "$B/api/providers" -H "authorization: Bearer $MGMT" -H 'content-type: application/json' -d "{
    \"name\":\"$NAME\",\"kind\":\"openai\",\"base_url\":\"https://opencode.ai/zen/v1\",
    \"key_env\":\"$VAR\",\"model\":\"$MODEL\",\"priority\":$SLOT,\"enabled\":true
  }" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.provider?j.provider.id:"")})')
  echo "  created provider $PID"
fi

echo "== route: free -> $PID (priority $SLOT) =="
curl -s -m 10 -X POST "$B/api/models" -H "authorization: Bearer $MGMT" -H 'content-type: application/json' \
  -d "{\"alias\":\"free\",\"providerId\":$PID,\"upstreamModel\":\"$MODEL\",\"priority\":$SLOT,\"enabled\":true}" >/dev/null

echo "== live probe of this account =="
curl -s -m 20 -o /tmp/acct-probe.json -D /tmp/acct-probe.h -X POST "https://opencode.ai/zen/v1/chat/completions" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4}"
STATUS=$(head -1 /tmp/acct-probe.h | awk '{print $2}')
RETRY=$(grep -i '^retry-after:' /tmp/acct-probe.h | tr -d '\r' | awk '{print $2}')
echo "  $NAME -> HTTP $STATUS  retry_after=${RETRY:-none}"
head -c 160 /tmp/acct-probe.json; echo

echo
echo "== restart so the new key env is loaded =="
systemctl restart opencode-router-local
for i in $(seq 1 30); do curl -fsS -m 2 "$B/v1/health" >/dev/null 2>&1 && { echo "READY ${i}s"; break; }; sleep 1; done
echo "done: $NAME (provider $PID)"
