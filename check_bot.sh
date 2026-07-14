#!/bin/bash

export PATH=/usr/local/bin:/usr/bin:/bin

APP_DIR="/home/violetcoller/domains/lucym.indevs.in/public_nodejs/XCloud-Tool"
HEARTBEAT_FILE="$APP_DIR/data/heartbeat"
MAX_AGE=180

now_ms=$(($(date +%s) * 1000))
hb_ms=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
age_sec=$(( (now_ms - hb_ms) / 1000 ))

if [ ! -f "$HEARTBEAT_FILE" ] || [ "$age_sec" -gt "$MAX_AGE" ]; then
    pkill -f "node src/bot.js" 2>/dev/null
    sleep 1
    cd "$APP_DIR" || exit 1
    nohup npm run bot >> bot.log 2>&1 < /dev/null &
fi