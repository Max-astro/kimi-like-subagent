#!/usr/bin/env bash
# Dump pi's effective (fully chained) system prompt to ./pi-system-prompt.md.
# The dump extension runs on agent_start, after before_agent_start handlers
# (e.g. kimi-like-subagent's delegation injection) have been applied.
# Costs one minimal LLM round-trip ("hi"). Extra args are passed to pi.
# Usage: ./dump-system-prompt.sh [--model provider/model-id ...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$PWD/pi-system-prompt.md"

command -v pi >/dev/null 2>&1 || { echo "error: pi not found on PATH" >&2; exit 1; }

pi -e "$SCRIPT_DIR/dump-system-prompt.extension.ts" --no-session -p "hi" "$@" >/dev/null

echo "System prompt written to $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
