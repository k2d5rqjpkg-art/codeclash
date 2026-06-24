#!/bin/bash
# CodeClash startup: server + Cloudflare tunnel
echo "Starting CodeClash..."
npx tsx src/server.ts &
sleep 2
~/cloudflared.exe tunnel --url http://localhost:3100 2>&1 | grep -E "trycloudflare\.com|error|INF"
