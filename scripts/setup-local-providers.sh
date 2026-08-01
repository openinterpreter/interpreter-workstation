#!/bin/bash
set -euo pipefail

# Setup Ollama and LM Studio for local provider integration/live tests.
# Usage:
#   ./scripts/setup-local-providers.sh              # both providers
#   ./scripts/setup-local-providers.sh ollama        # Ollama only
#   ./scripts/setup-local-providers.sh lmstudio      # LM Studio only

OLLAMA_TEST_MODEL="${OLLAMA_TEST_MODEL:-qwen2.5:0.5b}"
LMSTUDIO_TEST_MODEL="${LMSTUDIO_TEST_MODEL:-qwen/qwen3-0.6b}"
PROVIDER="${1:-both}"

PIDS_TO_CLEANUP=()
cleanup() {
  for pid in "${PIDS_TO_CLEANUP[@]+"${PIDS_TO_CLEANUP[@]}"}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

wait_for_endpoint() {
  local url="$1"
  local label="$2"
  local max_attempts="${3:-30}"
  shift; shift; shift 2>/dev/null || true
  # Remaining args are passed directly to curl (e.g. -H "Authorization: Bearer lm-studio")
  local curl_args=("$@")
  for i in $(seq 1 "$max_attempts"); do
    if curl -sf "${curl_args[@]}" "$url" >/dev/null 2>&1; then
      echo "$label is ready"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: $label failed to start after ${max_attempts}s" >&2
  return 1
}

retry_command() {
  local max_attempts="$1"
  local label="$2"
  local delay_seconds="${3:-2}"
  shift 3

  local attempt=1
  local exit_code=0
  while true; do
    if "$@"; then
      return 0
    else
      exit_code=$?
    fi
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      echo "ERROR: $label failed after ${attempt} attempts (last exit: ${exit_code})" >&2
      return "$exit_code"
    fi

    echo "WARN: $label failed (attempt ${attempt}/${max_attempts}, exit ${exit_code}); retrying in ${delay_seconds}s..." >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
    delay_seconds=$((delay_seconds * 2))
  done
}

setup_ollama() {
  echo "==> Installing Ollama"
  if ! command -v ollama >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      brew install ollama
    else
      curl -fsSL https://ollama.com/install.sh | sh
    fi
  fi

  export OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/.ollama/models}"
  mkdir -p "$OLLAMA_MODELS"

  echo "==> Starting Ollama server"
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    ollama serve &
    PIDS_TO_CLEANUP+=($!)
    wait_for_endpoint "http://localhost:11434/api/tags" "Ollama"
  else
    echo "Ollama already running"
  fi

  echo "==> Pulling model: $OLLAMA_TEST_MODEL"
  ollama pull "$OLLAMA_TEST_MODEL"
  ollama list
}

setup_lmstudio() {
  echo "==> Installing LM Studio (headless)"
  if ! command -v lms >/dev/null 2>&1; then
    curl -fsSL https://lmstudio.ai/install.sh | bash
    export PATH="$HOME/.lmstudio/bin:$HOME/.cache/lm-studio/bin:$PATH"
  fi

  mkdir -p "$HOME/.lmstudio/models"

  echo "==> Starting LM Studio daemon"
  lms daemon up

  echo "==> Downloading model: $LMSTUDIO_TEST_MODEL"
  retry_command "${LMSTUDIO_DOWNLOAD_RETRIES:-5}" \
    "LM Studio model download ($LMSTUDIO_TEST_MODEL)" \
    "${LMSTUDIO_DOWNLOAD_RETRY_DELAY_SECONDS:-5}" \
    lms get "$LMSTUDIO_TEST_MODEL" --gguf --yes

  echo "==> Starting LM Studio server"
  lms server start --port 1234
  wait_for_endpoint "http://localhost:1234/v1/models" "LM Studio" 30 -H "Authorization: Bearer lm-studio"

  echo "==> Loading model"
  retry_command "${LMSTUDIO_LOAD_RETRIES:-3}" \
    "LM Studio model load ($LMSTUDIO_TEST_MODEL)" \
    2 \
    lms load "$LMSTUDIO_TEST_MODEL" --yes -c "${LMSTUDIO_CONTEXT_LENGTH:-32768}"
  lms ps
}

case "$PROVIDER" in
  ollama)
    setup_ollama
    ;;
  lmstudio)
    setup_lmstudio
    ;;
  both)
    setup_ollama
    setup_lmstudio
    ;;
  *)
    echo "Usage: $0 [ollama|lmstudio|both]" >&2
    exit 1
    ;;
esac

echo "==> Local provider setup complete"
