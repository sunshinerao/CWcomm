#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script currently supports macOS Keychain only."
  exit 1
fi

service="${1:-cwcomm_api_key}"

if [[ -t 0 ]]; then
  read -r -s -p "Enter secret for ${service}: " secret
  echo
else
  secret="$(cat)"
fi

if [[ -z "${secret}" ]]; then
  echo "No secret provided"
  exit 1
fi

security delete-generic-password -a "$USER" -s "$service" >/dev/null 2>&1 || true
security add-generic-password -a "$USER" -s "$service" -w "$secret" >/dev/null

echo "Stored secret in Keychain service: ${service}"
