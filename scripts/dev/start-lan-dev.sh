#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/dev/keychain-load.sh"

export CWCOMM_HOST="${CWCOMM_HOST:-0.0.0.0}"
export CWCOMM_PORT="${CWCOMM_PORT:-8080}"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

if command -v mkcert >/dev/null 2>&1; then
  mkdir -p "$ROOT_DIR/server/certs"
  CERT_FILE="$ROOT_DIR/server/certs/dev-cert.pem"
  KEY_FILE="$ROOT_DIR/server/certs/dev-key.pem"

  if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
    mkcert -install >/dev/null 2>&1 || true
    if [[ -n "$LAN_IP" ]]; then
      mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" localhost 127.0.0.1 ::1 "$LAN_IP"
    else
      mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" localhost 127.0.0.1 ::1
    fi
  fi

  export CWCOMM_TLS_CERT_FILE="$CERT_FILE"
  export CWCOMM_TLS_KEY_FILE="$KEY_FILE"
  echo "TLS enabled with mkcert cert: $CERT_FILE"
else
  echo "mkcert not found: starting in HTTP mode"
fi

if [[ -n "$LAN_IP" ]]; then
  echo "LAN URL candidate: http://$LAN_IP:$CWCOMM_PORT (or https if TLS enabled)"
fi

cd "$ROOT_DIR/server"

if [[ -d node_modules ]]; then
  npm run dev
else
  npm install
  npm run dev
fi
