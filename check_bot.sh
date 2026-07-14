#!/bin/bash
APP_DIR=~/domains/lucym.indevs.in/public_nodejs/XCloud-Tool
HEARTBEAT_FILE="$APP_DIR/data/heartbeat"
MAX_AGE=180 # giây - lớn hơn 30s (chu kỳ ghi heartbeat) và 60s (POLL_INTERVAL_MS) để tránh false positive

now_ms=$(($(date +%s) * 1000))
hb_ms=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
age_sec=$(( (now_ms - hb_ms) / 1000 ))

is_stale=false
if [ ! -f "$HEARTBEAT_FILE" ] || [ "$age_sec" -gt "$MAX_AGE" ]; then
  is_stale=true
fi

if [ "$is_stale" = true ]; then
  pkill -f "node src/bot.js" 2>/dev/null
  sleep 1
  cd "$APP_DIR" && nohup npm run bot >> bot.log 2>&1 < /dev/null &
  disown
fi
