#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip keychain load: non-macOS"
  return 0 2>/dev/null || exit 0
fi

load_keychain_var() {
  local env_name="$1"
  local service_name="$2"

  if [[ -n "$(printenv "$env_name" 2>/dev/null || true)" ]]; then
    return 0
  fi

  local value
  if value="$(security find-generic-password -a "$USER" -s "$service_name" -w 2>/dev/null)"; then
    export "$env_name=$value"
  fi
}

# Generic fallback
load_keychain_var CWCOMM_API_KEY cwcomm_api_key

# Per-service keys override generic
load_keychain_var CWCOMM_TRANSLATION_API_KEY cwcomm_translation_api_key
load_keychain_var CWCOMM_ASR_API_KEY cwcomm_asr_api_key
load_keychain_var CWCOMM_TTS_API_KEY cwcomm_tts_api_key

# Backward compatible name for current provider modules
load_keychain_var OPENAI_API_KEY cwcomm_openai_api_key

# If OPENAI_API_KEY missing but generic exists, backfill for compatibility
if [[ -z "${OPENAI_API_KEY:-}" && -n "${CWCOMM_API_KEY:-}" ]]; then
  export OPENAI_API_KEY="$CWCOMM_API_KEY"
fi
