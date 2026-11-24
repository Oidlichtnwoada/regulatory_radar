#!/usr/bin/env sh
# Scores the radar against data/eval/labels.json and data/eval/labels.extended.json.
#   scripts/eval.sh offline   deterministic pipeline (LLM_PROVIDER=none), no key, no network
#   scripts/eval.sh online    LLM pipeline (LLM_PROVIDER from .env, mistral if unset; API keys from .env)
#   scripts/eval.sh both
# Each run uses its own compose project and a fresh database; results go to docs/eval/<mode>.json.
set -eu
cd "$(dirname "$0")/.."
mkdir -p docs/eval

run() {
  mode=$1
  provider=$2
  project="radar-eval-${mode}"
  data_dir="./.pgdata-eval/${mode}"
  rm -rf "$data_dir"
  export COMPOSE_PROJECT_NAME="$project" POSTGRES_DATA_DIR="$data_dir" SOURCE_FILE_PATH=items.json LLM_PROVIDER="$provider"
  echo "== ${mode}: starting a fresh stack (LLM_PROVIDER=${provider})"
  out="docs/eval/${mode}.json"
  status=0
  docker compose up -d --build --wait db api worker || status=$?
  if [ "$status" -eq 0 ]; then
    docker compose run --rm -T eval --wait-seconds 3600 > "${out}.tmp" || status=$?
  fi
  # Never replace the committed results with something that is not the eval's JSON.
  if [ "$status" -eq 0 ] && ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).results.length || process.exit(1)' "${out}.tmp" 2>/dev/null; then
    status=3
  fi
  # Tear down even when a step failed, so no eval stack is left running.
  docker compose down
  rm -rf "$data_dir"
  if [ "$status" -ne 0 ]; then
    echo "== ${mode}: failed (exit ${status}); ${out} left unchanged, partial output in ${out}.tmp" >&2
    return "$status"
  fi
  mv "${out}.tmp" "$out"
}

# LLM_PROVIDER from .env (last assignment wins, quotes stripped); mistral when unset or empty.
online_provider() {
  p=$(sed -n 's/^LLM_PROVIDER=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'" | tr -d '[:space:]')
  echo "${p:-mistral}"
}

case "${1:-offline}" in
  offline) run offline none ;;
  online) run online "$(online_provider)" ;;
  both) run offline none && run online "$(online_provider)" ;;
  *) echo "usage: $0 offline|online|both" >&2; exit 1 ;;
esac
