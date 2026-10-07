// Fills the {{placeholders}} in the system prompt from environment variables.
// Usage: node scripts/render-prompt.mjs <template> <output>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , template, output] = process.argv;
const env = process.env;
const baselineFile = env.BASELINE_FILE || 'baseline/baseline-report.json';
const values = {
  base_url: env.BASE_URL,
  build_id: env.BUILD_ID,
  environment: env.ENVIRONMENT,
  changed_paths: env.CHANGED_PATHS || '(not provided: run the full suite)',
  test_account: env.TEST_ACCOUNT ? '(provided via TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD environment variables; never print them)' : '(none)',
  max_pages: env.MAX_PAGES,
  report_path: env.REPORT_PATH,
  work_dir: env.WORK_DIR,
  baseline_report: existsSync(baselineFile) ? readFileSync(baselineFile, 'utf8') : '(none)',
};
for (const [k, v] of Object.entries(values)) {
  if (v === undefined || v === '') throw new Error(`missing value for {{${k}}}`);
}
const out = readFileSync(template, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));
const left = out.match(/\{\{\w+\}\}/g);
if (left) throw new Error(`unfilled placeholders: ${[...new Set(left)].join(', ')}`);
writeFileSync(output, out);
