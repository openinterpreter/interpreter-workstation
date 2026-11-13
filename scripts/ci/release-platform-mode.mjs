import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

const names = ['Build macos-arm64', 'Build macos-x64', 'Build windows-x64', 'Build linux-x64'];

export function decidePlatformMode(jobs, { runId, sha, attempt, requestedMode = 'all' }) {
  assert.ok(Array.isArray(jobs) && jobs.length <= 100, 'Unexpected release job inventory');
  assert.ok(requestedMode === 'all' || requestedMode === 'windows-linux', 'Unknown requested release mode');
  if (requestedMode === 'windows-linux') {
    assert.equal(jobs.filter(job => names.slice(0, 2).includes(job.name)).length, 0,
      'Windows/Linux release unexpectedly scheduled macOS signing');
  }
  const selected = (requestedMode === 'all' ? names : names.slice(2)).map((name) => {
    const matching = jobs.filter((job) => job.name === name);
    assert.equal(matching.length, 1, `Expected exactly one ${name} job`);
    const [job] = matching;
    assert.equal(job.run_id, Number(runId), `${name} belongs to another run`);
    assert.equal(job.head_sha, sha, `${name} belongs to another commit`);
    assert.equal(job.run_attempt ?? Number(attempt), Number(attempt), `${name} belongs to another attempt`);
    assert.equal(job.status, 'completed', `${name} is not complete`);
    return job;
  });
  const [windows, linux] = selected.slice(-2);
  assert.equal(windows.conclusion, 'success', 'Windows signing/verification job failed');
  assert.equal(linux.conclusion, 'success', 'Linux package verification job failed');
  if (requestedMode === 'windows-linux') return 'windows-linux';
  if (selected[0].conclusion === 'success' && selected[1].conclusion === 'success') return 'all';
  for (const job of selected.slice(0, 2)) {
    assert.equal(job.conclusion, 'failure', 'Unresolved macOS job status');
    assert.equal(job.steps?.filter((step) => step.number === 14).length, 1, 'Unknown macOS package step');
    assert.equal(job.steps.find((step) => step.number === 13)?.conclusion, 'success', 'macOS certificate preparation failed');
    assert.equal(job.steps.find((step) => step.number === 14)?.conclusion, 'failure', 'macOS failure is outside packaging');
  }
  return 'windows-linux';
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha, GITHUB_OUTPUT: output,
    GITHUB_REF: ref, GITHUB_EVENT_NAME: event, GITHUB_ACTOR: actor,
    RELEASE_PLATFORM_REQUEST: requestedMode } = process.env;
  assert.equal(repository, 'openinterpreter/interpreter-workstation');
  assert.equal(ref, 'refs/heads/main');
  assert.equal(event, 'workflow_dispatch');
  assert.equal(actor, 'interpreterwork-automation[bot]');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  assert.match(runId ?? '', /^[1-9]\d*$/);
  assert.match(attempt ?? '', /^[1-9]\d*$/);
  assert.ok(requestedMode === 'all' || requestedMode === 'windows-linux', 'Release selection is unavailable');
  assert.ok(token && output, 'Current-run authority is unavailable');
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, 'Current-run job inventory unavailable');
  const body = await response.json();
  assert.ok(body.total_count <= 100 && body.jobs?.length === body.total_count, 'Paginated job inventory is unsupported');
  const mode = decidePlatformMode(body.jobs, { runId, sha, attempt, requestedMode });
  appendFileSync(output, `mode=${mode}\n`);
  console.log(`Verified release platform mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
