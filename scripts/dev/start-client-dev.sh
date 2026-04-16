#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_PORT="${CLIENT_PORT:-5173}"

cd "$ROOT_DIR/web"

echo "Starting standalone client at http://127.0.0.1:${CLIENT_PORT}"
echo "Admin:  http://127.0.0.1:${CLIENT_PORT}/admin.html"
echo "Client: http://127.0.0.1:${CLIENT_PORT}/client.html"
python3 -m http.server "$CLIENT_PORT" --bind 0.0.0.0
