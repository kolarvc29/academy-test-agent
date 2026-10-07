// Release gate: validates the agent's report, recomputes the verdict from the findings,
// writes a Markdown summary and sets the exit code the pipeline acts on.
// Exit codes: 0 pass (or warn when --fail-on block), 1 blocked, 2 report missing or invalid.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const CONFIDENCES = ['high', 'moderate', 'low'];
const GATES = ['pass', 'warn', 'block'];
const CORE_CHECKS = /smoke|functional|link|seo|accessib/i;

export function validate(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return ['report is not a JSON object'];
  for (const k of ['build_id', 'base_url', 'gate', 'findings', 'coverage', 'regression_checks']) {
    if (!(k in report)) errors.push(`missing field: ${k}`);
  }
  if (report.gate && !GATES.includes(report.gate)) errors.push(`invalid gate: ${report.gate}`);
  if (Array.isArray(report.findings)) {
    report.findings.forEach((f, i) => {
      if (!SEVERITIES.includes(f.severity)) errors.push(`finding ${i}: invalid severity ${f.severity}`);
      if (!CONFIDENCES.includes(f.confidence)) errors.push(`finding ${i}: invalid confidence ${f.confidence}`);
      if (!f.title || !f.evidence) errors.push(`finding ${i}: missing title or evidence`);
    });
  } else if ('findings' in report) {
    errors.push('findings is not an array');
  }
  return errors;
}

// The same rule the prompt gives the agent, applied independently.
export function computeGate(report) {
  const live = (report.findings || []).filter((f) => f.status !== 'fixed');
  const blocking = live.filter((f) => ['blocker', 'high'].includes(f.severity) && ['high', 'moderate'].includes(f.confidence));
  if (blocking.length) return { gate: 'block', reason: `${blocking.length} blocker/high finding(s) at moderate or high confidence` };
  const notRun = (report.coverage?.checks_not_run || []).filter((c) => CORE_CHECKS.test(c.check || ''));
  if (live.some((f) => f.severity === 'medium')) return { gate: 'warn', reason: 'worst finding is medium' };
  if (notRun.length) return { gate: 'warn', reason: `core checks not run: ${notRun.map((c) => c.check).join(', ')}` };
  return { gate: 'pass', reason: 'no medium, high or blocker findings and all core checks ran' };
}

// Never let the agent's own verdict be more lenient than the recomputed one.
export function finalGate(report) {
  const computed = computeGate(report);
  const rank = (g) => GATES.indexOf(g);
  const agent = GATES.includes(report.gate) ? report.gate : 'block';
  return rank(agent) >= rank(computed.gate)
    ? { gate: agent, reason: report.gate_reason || computed.reason, computed: computed.gate }
    : { gate: computed.gate, reason: `${computed.reason} (agent said ${agent}; overridden)`, computed: computed.gate };
}

export function summarise(report, verdict) {
  const icon = { pass: '🟢', warn: '🟡', block: '🔴' }[verdict.gate];
  const count = (s) => (report.findings || []).filter((f) => f.severity === s && f.status !== 'fixed').length;
  const lines = [
    `## ${icon} Academy release gate: ${verdict.gate.toUpperCase()}`,
    '',
    `${verdict.reason}`,
    '',
    `Build \`${report.build_id}\` · ${report.base_url} · ${report.coverage?.pages_tested ?? '?'} pages · ${(report.coverage?.profiles || []).join(', ')}`,
    '',
    `| Blocker | High | Medium | Low |`,
    `|---|---|---|---|`,
    `| ${count('blocker')} | ${count('high')} | ${count('medium')} | ${count('low')} |`,
    '',
  ];
  const top = (report.findings || []).filter((f) => f.status !== 'fixed').slice(0, 15);
  if (top.length) {
    lines.push('| Severity | Finding | Where |', '|---|---|---|');
    for (const f of top) lines.push(`| ${f.severity} (${f.confidence}) | ${String(f.title).replace(/\|/g, '/')} | ${(f.urls || [])[0] || ''} |`);
    lines.push('');
  }
  const notRun = report.coverage?.checks_not_run || [];
  if (notRun.length) lines.push(`**Not run:** ${notRun.map((c) => `${c.check} (${c.reason})`).join('; ')}`, '');
  return lines.join('\n');
}

function main() {
  const [, , file, ...rest] = process.argv;
  const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
  const failOn = opt('fail-on', 'block');
  const summaryPath = opt('summary', null);

  if (!file || !existsSync(file)) {
    console.error(`gate: report not found at ${file}`);
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`gate: report is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const errors = validate(report);
  if (errors.length) {
    console.error(`gate: invalid report:\n- ${errors.join('\n- ')}`);
    process.exit(2);
  }
  const verdict = finalGate(report);
  const md = summarise(report, verdict);
  if (summaryPath) writeFileSync(summaryPath, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  const fail = verdict.gate === 'block' || (failOn === 'warn' && verdict.gate === 'warn');
  process.exit(fail ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
