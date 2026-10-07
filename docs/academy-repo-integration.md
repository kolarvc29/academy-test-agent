# Wiring the agent into the Academy site's pipeline

The Academy site deploys to Vercel. Vercel reports each deployment to GitHub as a
`deployment_status` event. Add this workflow to the **Academy site repo** so every
successful preview deployment is tested before it can be promoted.

`.github/workflows/test-agent.yml` in the Academy repo:

```yaml
name: Pre-release test agent
on:
  deployment_status:
jobs:
  test:
    if: github.event.deployment_status.state == 'success'
    uses: kolarvc29/academy-test-agent/.github/workflows/academy-test.yml@main
    with:
      base_url: ${{ github.event.deployment_status.environment_url || github.event.deployment_status.target_url }}
      build_id: ${{ github.event.deployment.sha }}
      environment: ${{ github.event.deployment.environment == 'Production' && 'production' || 'preview' }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      TEST_AGENT_REPO_TOKEN: ${{ secrets.TEST_AGENT_REPO_TOKEN }}  # read access to the test-agent repo
      VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

Then, in the Academy repo's branch protection for `main`, make the
**Pre-release test agent / test** check required. A `block` verdict fails the check,
so the pull request cannot merge and the preview cannot be promoted.

Notes:
- The test-agent repo must be readable from the Academy repo: allow it under the test-agent
  repo's Settings → Actions → General → Access, and give `TEST_AGENT_REPO_TOKEN` a
  fine-grained token with read-only Contents access to the test-agent repo.
- **Vercel bypass (needed):** the site's firewall blocked a test machine after a few hundred
  requests in one session. In the Academy project on Vercel, open Settings → Deployment Protection →
  Protection Bypass for Automation, generate a secret, and store it as
  `VERCEL_AUTOMATION_BYPASS_SECRET` in the Academy repo. The agent sends it as the
  `x-vercel-protection-bypass` header on every request. Without it, runs may be blocked and the
  gate will fail fast with "not reachable".
- Production runs are read-only: the agent never submits forms in production.
