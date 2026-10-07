# Yallo AI Academy test agent

An AI testing agent that checks a Yallo AI Academy deployment on desktop and mobile
browsers and decides whether it is fit to release. It runs locally or in a pipeline,
writes a JSON report with screenshots, and fails the build when it finds a release-blocking issue.

## What it checks

| Area | Examples |
|---|---|
| Functional | Broken links, catalogue filters, menus, form validation |
| Content | Course counts and facts that contradict each other across pages |
| SEO and sharing | Titles, descriptions, canonical, Open Graph and Twitter tags, slugs, sitemap |
| Accessibility | axe-core serious and critical issues, alt text, headings, duplicate screen-reader text, touch targets |
| Layout | Sideways scrolling, overlapping text, very long mobile pages |
| Performance | LCP, CLS, page weight on mobile |
| Brand | "Yallo AI Academy" naming, no "YALLO", no em dashes, UK English, unsupported "only" claims |
| Regression | The 15 known issues from the October 2026 audit (KI-01 to KI-15) |

Devices: desktop Chromium, desktop WebKit (Safari), iPhone 14 (WebKit), Pixel 7 (Chromium), tablet.

## How it works

```
run-agent.sh ──► fills the prompt (prompts/academy-test-agent.md) with the build details
            ──► Claude Code (headless) follows the prompt, using:
                  tools/crawl.mjs   crawl + status of every link + robots/sitemap
                  tools/audit.mjs   one page × device profiles: tags, axe, layout, vitals, screenshot
                  ad-hoc Playwright scripts for judgment checks (filters, counts, copy)
            ──► reports/<build>/report.json   (findings, regression checks, metrics)
gate.mjs   ──► recomputes pass / warn / block from the findings, writes summary.md, sets the exit code
```

The gate never trusts the agent's own verdict to be lenient: if the findings say "block", the build is blocked.

| Verdict | Rule | Exit code |
|---|---|---|
| block | Any blocker or high finding at moderate or high confidence | 1 (fails the build) |
| warn | Worst finding is medium, or a core check did not run | 0 (1 with `FAIL_ON=warn`) |
| pass | Nothing above low | 0 |

## Run it locally

Prerequisites: Node 22+, and either a Claude Code login (`claude` on your PATH) or `ANTHROPIC_API_KEY`.

```bash
npm ci
npx playwright install chromium webkit
npm install -g @anthropic-ai/claude-code   # if claude is not installed

BASE_URL=https://academy.yallo.co ENVIRONMENT=production npm run agent
```

Results: `reports/<build>/summary.md`, `report.json` and `work/screens/*.png`.

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | required | Deployment to test |
| `ENVIRONMENT` | `production` | `production` is read-only: no form submissions |
| `BUILD_ID` | `local-<timestamp>` | Label for the run and report folder |
| `MAX_PAGES` | `30` | Crawl limit |
| `MODEL` | `sonnet` | Claude model alias for the agent |
| `FAIL_ON` | `block` | Set to `warn` to also fail on medium findings |
| `CHANGED_PATHS` | empty | Paths changed in the build, so the agent looks there first |
| `BASELINE_FILE` | `baseline/baseline-report.json` | Last accepted report, used to label findings new, existing or fixed |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | empty | Vercel automation bypass, sent as a header so the firewall does not block runs |
| `TEST_ACCOUNT` | empty | Set (with `TEST_ACCOUNT_EMAIL` and `TEST_ACCOUNT_PASSWORD`) on staging only, to allow form submissions |

The tools also run on their own, without the agent:

```bash
node tools/crawl.mjs --base https://academy.yallo.co --max 30
node tools/audit.mjs --url https://academy.yallo.co/courses --profiles all
npm test   # gate unit tests
```

## Run it in the pipeline

`.github/workflows/academy-test.yml` runs it three ways: called from the Academy site's
pipeline after each Vercel deployment, by hand from the Actions tab, and nightly against production.
Setup for the Academy repo: [docs/academy-repo-integration.md](docs/academy-repo-integration.md).

Secrets: `ANTHROPIC_API_KEY` (required); `VERCEL_AUTOMATION_BYPASS_SECRET` (strongly recommended: stops the site's firewall blocking test runs); `TEST_AGENT_REPO_TOKEN` (when called from another repo);
`TEST_ACCOUNT_EMAIL` and `TEST_ACCOUNT_PASSWORD` (optional, staging only).

## Maintaining it

- **New known issue or a fix landed:** edit `<known_issues>` in the prompt. When a run's report is
  accepted, copy it to `baseline/baseline-report.json` so later runs label findings new or existing.
- **New page or journey:** add it to `<site_map>` in the prompt.
- **Gate policy:** change `computeGate` in `scripts/gate.mjs` and its tests together.
- **Cost and time:** a full run takes about 20 to 40 minutes. Lower `MAX_PAGES` or use a
  smaller model for faster runs. Each run's cost is in `reports/<build>/agent-result.json`.

## Limits

- The site's firewall can block a machine that sends many requests. The crawler paces itself
  (300 ms between requests to the site, `--pause` to change), and the runner stops before starting
  the agent if the site is unreachable. Use the Vercel bypass secret in the pipeline.

- It is an AI agent: two runs can word or rank findings differently. Hard checks
  (links, tags, axe) come from the deterministic tools; judgment calls carry a confidence level.
- It cannot see pages behind sign-in unless a staging test account is provided.
- WebKit does not report LCP; the report says "not measured" rather than passing it.
