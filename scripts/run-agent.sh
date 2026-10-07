#!/usr/bin/env bash
# Runs the Academy testing agent against one deployment and applies the release gate.
# Required: BASE_URL. Optional: BUILD_ID, ENVIRONMENT, CHANGED_PATHS, MAX_PAGES, MODEL,
# BASELINE_FILE, FAIL_ON (block|warn), TEST_ACCOUNT (any non-empty value, staging only).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BASE_URL:?set BASE_URL, for example https://academy.yallo.co}"
export BUILD_ID="${BUILD_ID:-local-$(date -u +%Y%m%dT%H%M%SZ)}"
export ENVIRONMENT="${ENVIRONMENT:-production}"   # production = read-only: no form submissions
export MAX_PAGES="${MAX_PAGES:-30}"
MODEL="${MODEL:-sonnet}"
RUN_DIR="reports/${BUILD_ID}"
export WORK_DIR="${RUN_DIR}/work"
export REPORT_PATH="${RUN_DIR}/report.json"
mkdir -p "${WORK_DIR}/scratch"

node scripts/render-prompt.mjs prompts/academy-test-agent.md "${RUN_DIR}/system-prompt.md"

# Fail fast, without spending on the agent, if the deployment cannot be reached from this runner.
BYPASS_HEADER=()
[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ] && BYPASS_HEADER=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
PROBE=$(curl -s -o /dev/null -w '%{http_code}' -m 30 ${BYPASS_HEADER[@]+"${BYPASS_HEADER[@]}"} "${BASE_URL}" || true)
if [ "${PROBE}" != "200" ]; then
  echo "gate: ${BASE_URL} is not reachable from this runner (HTTP ${PROBE:-none}). Not starting the agent." >&2
  echo "If the site's firewall is blocking the runner, set VERCEL_AUTOMATION_BYPASS_SECRET." >&2
  exit 2
fi

echo "Testing ${BASE_URL} (build ${BUILD_ID}, ${ENVIRONMENT}) with model ${MODEL}..."
claude -p "Run the full Yallo AI Academy test suite now for ${BASE_URL}, following your instructions exactly. Write the report to ${REPORT_PATH}." \
  --append-system-prompt-file "${RUN_DIR}/system-prompt.md" \
  --model "${MODEL}" \
  --allowedTools "Bash(node:*)" "Bash(mkdir:*)" "Bash(ls:*)" "Read" "Write" "Edit" "Glob" "Grep" \
  --output-format json > "${RUN_DIR}/agent-result.json" || echo "agent exited non-zero; the gate will decide from what was written"

# Fall back to the final message if the agent printed the report but did not write the file.
if [ ! -s "${REPORT_PATH}" ]; then
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const t = String(r.result || "");
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s >= 0 && e > s) require("fs").writeFileSync(process.argv[2], t.slice(s, e + 1));
  ' "${RUN_DIR}/agent-result.json" "${REPORT_PATH}" || true
fi

node scripts/gate.mjs "${REPORT_PATH}" --summary "${RUN_DIR}/summary.md" --fail-on "${FAIL_ON:-block}"
