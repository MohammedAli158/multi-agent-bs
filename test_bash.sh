#!/usr/bin/env bash
# run-agent.sh
trap 'sleep 1' DEBUG   # runs before every command, so each one waits 1s

cd /d/fk_thinkcel/orchestrator
node --watch --env-file=.env main.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

sleep 3   # extra time for the server to boot

SESSION_ID=$(curl -s -X POST http://localhost:3000/api/session \
  | sed -n 's/.*"sessionId" *: *"\([^"]*\)".*/\1/p')
echo "session: $SESSION_ID"

curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"message\":\"list the files here\"}"

curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"message\":\"create hello.js that prints hello, then run it\"}"