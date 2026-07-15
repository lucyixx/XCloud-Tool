#!/bin/bash
export PATH=/usr/local/bin:/usr/bin:/bin

APP_DIR="/home/violetcoller/domains/lucym.indevs.in/public_nodejs/XCloud-Tool"
HEARTBEAT_FILE="$APP_DIR/data/heartbeat"
MAX_AGE=180

PIDS=($(pgrep -f "node src/bot.js"))
COUNT=${#PIDS[@]}

now_ms=$(($(date +%s) * 1000))
hb_ms=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
age_sec=$(( (now_ms - hb_ms) / 1000 ))

needs_restart=false

if [ "$COUNT" -eq 0 ]; then
  needs_restart=true
elif [ "$COUNT" -gt 1 ]; then
  # nhiều hơn 1 tiến trình cùng lúc - kill hết, restart lại đúng 1
  needs_restart=true
elif [ ! -f "$HEARTBEAT_FILE" ] || [ "$age_sec" -gt "$MAX_AGE" ]; then
  # đúng 1 tiến trình nhưng heartbeat cũ - tiến trình bị treo
  needs_restart=true
fi

if [ "$needs_restart" = true ]; then
  pkill -9 -f "npm run bot" 2>/dev/null
  pkill -9 -f "node src/bot.js" 2>/dev/null
  sleep 1
  cd "$APP_DIR" || exit 1
  nohup node src/bot.js >> bot.log 2>&1 < /dev/null &
fi
