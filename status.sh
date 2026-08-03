#!/usr/bin/env bash
set -uo pipefail

SF_HOST="${SF_HOST:-satisfactory}"
SF_PORT="${SF_PORT:-7777}"
SF_TOKEN="${SF_TOKEN:?SF_TOKEN manquant}"
WEBHOOK="${DISCORD_WEBHOOK:?DISCORD_WEBHOOK manquant}"
ID_FILE="/state/msg_id"

query() {
  curl -sk --max-time 10 -X POST "https://$SF_HOST:$SF_PORT/api/v1" \
    -H "Authorization: Bearer $SF_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"function":"QueryServerState","data":{}}'
}

build_offline() {
  jq -n '{embeds:[{title:"🔴 Serveur Satisfactory hors ligne",
                   description:"API HTTPS injoignable.",
                   color:15158332,
                   timestamp:(now|todateiso8601)}]}'
}

build_online() {
  local s="$1" dur uptime
  dur=$(jq -r '.totalGameDuration // 0' <<<"$s")
  uptime=$(printf '%dj %02dh %02dm' $((dur/86400)) $((dur%86400/3600)) $((dur%3600/60)))
  jq -n --argjson s "$s" --arg uptime "$uptime" '
  {
    embeds: [{
      title: "🏭 " + ($s.activeSessionName // "Satisfactory"),
      color: (if $s.numConnectedPlayers > 0 then 3066993 else 9807270 end),
      fields: [
        {name:"Pionniers", value:"\($s.numConnectedPlayers)/\($s.playerLimit)", inline:true},
        {name:"Palier",    value:"\($s.techTier)", inline:true},
        {name:"Phase",     value:($s.gamePhase // "—" | split(".") | last), inline:true},
        {name:"Durée",     value:$uptime, inline:true},
        {name:"Tick rate", value:"\($s.averageTickRate // 0 | floor) Hz", inline:true},
        {name:"État",      value:(if $s.isGamePaused then "⏸ en pause" else "▶️ en cours" end), inline:true}
      ],
      footer: {text: "Mis à jour"},
      timestamp: (now | todateiso8601)
    }]
  }'
}

# Édite le message existant, en repost si l'ID n'est plus valide
publish() {
  local payload="$1" id http
  if [[ -s "$ID_FILE" ]]; then
    id=$(<"$ID_FILE")
    http=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$WEBHOOK/messages/$id" \
             -H 'Content-Type: application/json' -d "$payload")
    [[ "$http" == "200" ]] && return 0
    echo "PATCH a renvoyé $http, republication" >&2
    rm -f "$ID_FILE"
  fi
  id=$(curl -sS -X POST "$WEBHOOK?wait=true" \
         -H 'Content-Type: application/json' -d "$payload" | jq -r '.id // empty')
  [[ -n "$id" ]] && printf '%s' "$id" > "$ID_FILE"
}

resp=$(query)
if jq -e '.data.serverGameState' >/dev/null 2>&1 <<<"$resp"; then
  publish "$(build_online "$(jq -c '.data.serverGameState' <<<"$resp")")"
else
  publish "$(build_offline)"
fi
