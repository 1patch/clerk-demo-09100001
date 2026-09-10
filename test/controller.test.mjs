import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, createControllerGuard } from '../controller/config.mjs';
import { assertPullRequest, assertTransition } from '../controller/github.mjs';
import { assertRuntime, seedWindow, buildSeedTelemetry, BASELINE_REFRESH_AFTER_MS, planBaselineArm, deploymentRunState } from '../controller/cli.mjs';

const config = { organizationId: 'org_DemoOnly', onepatchOrigin: 'https://app.staging.onepatch.dev', githubRepository: '1patch/clerk-demo-09100001', awsProfile: 'staging', awsRegion: 'us-east-1', tenantRegistryTable: 'onepatch-staging-tenant-registry', sshHost: 'clerk-demo.exe.xyz', sutOrigin: 'https://clerk-demo.exe.xyz' };
const sha = 'a'.repeat(40);
test('environment bindings cannot silently cross accounts, hosts, or repositories', () => {
  assert.equal(validateConfig(config).account, '017535066453');
  for (const change of [{ onepatchOrigin: 'https://attacker.example' }, { tenantRegistryTable: 'onepatch-prod-tenant-registry' }, { awsRegion: 'us-west-2' }, { githubRepository: '1patch/onep-internal' }, { sshHost: 'victim.exe.xyz' }])
    assert.throws(() => validateConfig({ ...config, ...change }));
});
test('wrong AWS account stops before a registry lookup or mutation', async () => {
  const calls = [];
  const guard = createControllerGuard(config, { apiKey: 'test-key',
    fetchImpl: async () => Response.json({ id: config.organizationId, metadata: { demo_instance: 'true' } }),
    execute: (_command, args) => { calls.push(args); return JSON.stringify({ Account: '012751250431' }); },
  });
  let writes = 0;
  await assert.rejects(guard.mutate(config, () => writes++));
  assert.equal(writes, 0); assert.equal(calls.length, 1);
});
test('only reviewed same-repo release-only PRs are applicable', () => {
  const pr = { baseRefName: 'main', baseRefOid: sha, state: 'OPEN', isDraft: false, headRepository: { nameWithOwner: '1patch/clerk-demo-09100001' }, headRefName: 'codex/demo-regression-123', files: [{ path: 'sut/release.json' }] };
  const expected = { expectedPhase: 'regression' };
  assert.doesNotThrow(() => assertPullRequest(pr, expected));
  assert.doesNotThrow(() => assertPullRequest({ ...pr, baseRefOid: 'b'.repeat(40) }, expected));
  for (const change of [{ isDraft: true }, { files: [{ path: 'controller/guard.mjs' }] }, { headRepository: { nameWithOwner: 'other/fork' } }, { baseRefName: 'prod' }])
    assert.throws(() => assertPullRequest({ ...pr, ...change }, expected));
  assert.doesNotThrow(() => assertTransition('baseline', 'regression'));
  assert.doesNotThrow(() => assertTransition('regression', 'fix'));
  assert.doesNotThrow(() => assertTransition('fix', 'baseline'));
  assert.throws(() => assertTransition('baseline', 'fix'));
});
test('seed refuses inconsistent revisions and future/overlapping observations', () => {
  const runtime = { expectedSha: sha, localSha: sha, githubSha: sha, health: { version: sha } };
  assert.doesNotThrow(() => assertRuntime(runtime));
  for (const key of ['localSha', 'githubSha']) assert.throws(() => assertRuntime({ ...runtime, [key]: 'b'.repeat(40) }));
  assert.throws(() => assertRuntime({ ...runtime, health: { version: 'b'.repeat(40) } }));
  assert.deepEqual(seedWindow({ now: 1000000, phase: 'regression', deployedAt: 990000 }), { start: 990000, end: 999000, intervalMs: 9 });
  assert.equal(seedWindow({ now: 1000000, lastEnd: 995000, phase: 'fix', deployedAt: 990000 }).start, 995000);
  assert.throws(() => seedWindow({ now: 1000000, phase: 'fix', deployedAt: 1000000 }));
});

test('initial baseline supplies complete healthy populations on both sides of its deployment', () => {
  const options = { now: 1_000_000, deployedAt: 990_000, telemetryNotBefore: 995_000, phase: 'baseline', releaseSha: sha, runId: 'two-sided-baseline' };
  const { payload, window } = buildSeedTelemetry(options);
  const spans = payload.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
  const roots = spans.filter(span => !span.parentSpanId);
  const start = span => Number(BigInt(span.startTimeUnixNano) / 1_000_000n);
  const pre = roots.filter(span => start(span) < options.deployedAt);
  const post = roots.filter(span => start(span) >= options.telemetryNotBefore);
  assert.equal(window.requests, 2000);
  assert.equal(roots.length, 2000);
  assert.equal(pre.length, 1000); assert.equal(post.length, 1000);
  assert.equal(pre.filter(span => span.status.code === 2).length, 4);
  assert.equal(post.filter(span => span.status.code === 2).length, 4);
  assert.equal(new Set(roots.map(span => span.traceId)).size, 2000);
  assert.ok(pre.every(span => Number(BigInt(span.endTimeUnixNano) / 1_000_000n) < options.deployedAt));
  assert.ok(spans.every(span => Number(BigInt(span.endTimeUnixNano) / 1_000_000n) <= options.now));
  assert.equal(window.windows[0].start, options.deployedAt - 300000);
  assert.equal(window.windows[0].end, options.deployedAt - 1000);
});

test('repeat baseline and all changed releases seed one complete post-deployment population only', () => {
  for (const [phase, lastEnd, expectedErrors] of [['baseline', 995000, 4], ['regression', undefined, 187], ['fix', undefined, 4]]) {
    const { payload, window } = buildSeedTelemetry({ now: 1000000, deployedAt: 990000, telemetryNotBefore: 995000, lastEnd, phase, releaseSha: sha, runId: `post-${phase}` });
    const spans = payload.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
    const roots = spans.filter(span => !span.parentSpanId);
    assert.equal(window.requests, 1000); assert.equal(window.windows.length, 1);
    assert.equal(roots.length, 1000);
    assert.equal(roots.filter(span => span.status.code === 2).length, expectedErrors);
    assert.ok(spans.every(span => Number(BigInt(span.startTimeUnixNano) / 1_000_000n) >= 995000));
    assert.ok(spans.every(span => Number(BigInt(span.endTimeUnixNano) / 1_000_000n) <= 1000000));
  }
});

test('arm refreshes stale baseline evidence even when GitHub and deployed SHA are unchanged', () => {
  const now = 1800000000000;
  const healthy = { deployedSha: sha, phase: 'baseline', runId: 'old-run', lastSeededSha: sha, lastSeedEnd: now - 10000, deployedAt: now - 20000 };
  assert.deepEqual(planBaselineArm(healthy, sha, now), { beginRefresh: false, deploy: false });
  assert.deepEqual(planBaselineArm({ ...healthy, lastSeedEnd: now - BASELINE_REFRESH_AFTER_MS }, sha, now), { beginRefresh: true, deploy: true });
  assert.deepEqual(planBaselineArm({ ...healthy, lastSeedEnd: undefined }, sha, now), { beginRefresh: true, deploy: true });
  assert.deepEqual(planBaselineArm({ ...healthy, deployedAt: now - 86400000 }, sha, now), { beginRefresh: true, deploy: true });
});

test('refresh records a new run and two complete populations, and resumed seed does not redeploy', () => {
  const now = 1800000000000;
  const prior = { phase: 'baseline', deployedSha: sha, runId: 'old-run', lastSeededSha: sha, lastSeedEnd: now - 86400000,
    baselineRefresh: { sha, stage: 'deploy' } };
  assert.deepEqual(planBaselineArm(prior, sha, now), { beginRefresh: false, deploy: true });
  const state = { ...prior, ...deploymentRunState(prior, sha, 'baseline', () => 'fresh-run'), deployedAt: now, telemetryNotBefore: now };
  assert.equal(state.runId, 'fresh-run');
  assert.equal(state.lastSeededSha, undefined);
  assert.equal(state.lastSeedEnd, undefined);
  assert.equal(state.baselineRefresh.stage, 'seed');
  assert.deepEqual(planBaselineArm(state, sha, now + 3000), { beginRefresh: false, deploy: false });
  const seeded = buildSeedTelemetry({ ...state, releaseSha: sha, now: now + 3000 });
  assert.equal(seeded.window.requests, 2000);
  assert.equal(seeded.window.windows[0].kind, 'baseline-prehistory');
  assert.ok(seeded.window.windows[0].end < now);
  assert.ok(seeded.window.windows[1].start >= now);
  assert.ok(seeded.payload.resourceSpans.every(resource => resource.resource.attributes.some(attr => attr.key === 'demo.run_id' && attr.value.stringValue === 'fresh-run')));
});

test('arm never replays uncertain writes or resumes a different pending SHA', () => {
  for (const pending of [{ pendingSeed: {} }, { pendingRecordUnknown: true }, { pendingSha: 'b'.repeat(40) }, { baselineRefresh: { sha: 'b'.repeat(40), stage: 'deploy' } }]) {
    assert.throws(() => planBaselineArm({ deployedSha: sha, lastSeedEnd: 0, ...pending }, sha, Date.now()), /reconcile/i);
  }
});

test('normal deploys preserve run identity; healthy reset also clears the same-SHA seed receipt', () => {
  const old = { phase: 'regression', runId: 'original', lastSeededSha: sha, lastSeedEnd: 1000 };
  assert.deepEqual(deploymentRunState(old, sha, 'fix', () => 'unexpected'), { runId: 'original' });
  const reset = deploymentRunState(old, sha, 'baseline', () => 'reset-run');
  assert.equal(reset.runId, 'reset-run');
  assert.equal(reset.lastSeededSha, undefined);
  assert.equal(reset.lastSeedEnd, undefined);
});
