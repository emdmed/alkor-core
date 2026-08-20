#!/usr/bin/env bash
# Start a llama-server for one profile.
#
# The harness never starts a server itself: the two profiles need different models, and a
# server outlives many eval runs. This script only removes the flags that are easy to get
# wrong and expensive to notice.
#
#   LLAMA_PORT=8081 LLAMA_MODEL=~/models/gemma-3-4b-it-Q4_K_M.gguf scripts/llama-server.sh -ngl 99
#   LLAMA_PORT=8080 LLAMA_HF=ggml-org/gemma-3-4b-it-GGUF          scripts/llama-server.sh -ngl 99
#
# Anything after the script name is passed through to llama-server verbatim.
set -euo pipefail

PORT="${LLAMA_PORT:-8080}"
CTX="${LLAMA_CTX:-32768}"

# A model is named either as a local .gguf (LLAMA_MODEL) or as a Hugging Face repo
# (LLAMA_HF), which llama-server downloads and caches itself. Both are supported because
# both are how these models actually arrive on a machine.
if [[ -n "${LLAMA_HF:-}" ]]; then
  MODEL_ARGS=(-hf "$LLAMA_HF")
else
  MODEL="${LLAMA_MODEL:?set LLAMA_MODEL to a .gguf path, or LLAMA_HF to a repo}"
  if [[ ! -f "$MODEL" ]]; then
    echo "no such model: $MODEL" >&2
    exit 1
  fi
  MODEL_ARGS=(--model "$MODEL")
fi

# --jinja applies the model's own chat template, which is what makes llama-server parse
# tool calls back out of the completion. Without it the `tools` field is silently ignored
# and an agentic profile gets prose instead of tool_calls — so it is on for every profile
# rather than only the one that currently needs it.
exec llama-server \
  "${MODEL_ARGS[@]}" \
  --port "$PORT" \
  --ctx-size "$CTX" \
  --jinja \
  "$@"
