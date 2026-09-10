import test from 'node:test';
import assert from 'node:assert/strict';
import { watchTick, watchLoop } from '../controller/watch.mjs';
import { seedWindow } from '../controller/cli.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELEASES } from '../sut/telemetry.mjs';

const baseline = 'a'.repeat(40), regression = 'b'.repeat(40), fix = 'c'.repeat(40);
function harness() {
  let state = { watchArm: { repository: '1patch/clerk-demo-09100001', baselineSha: baseline }, deployedSha: baseline, phase: 'baseline', deployedAt: 1000, lastSeededSha: baseline };
  let observed = { sha: regression, phase: 'regression', ancestor: true, files: ['sut/release.json'], pr: { state: 'closed', merged_at: '2026-09-09T00:00:00Z', merge_commit_sha: regression, base: { ref: 'main' }, head: { ref: 'codex/demo-regression', repo: { full_name: '1patch/clerk-demo-09100001' } } } };
  const calls = [];
  const effects = {
    readState: () => structuredClone(state), observe: async () => structuredClone(observed), now: () => 10000,
    sleep: async ms => { calls.push(['sleep', ms]); },
    deploy: async sha => { calls.push(['deploy', sha]); state = { ...state, deployedSha: sha, phase: observed.phase, deployedAt: 9000 }; },
    seed: async () => { calls.push(['seed', state.deployedSha]); state.lastSeededSha = state.deployedSha; },
  };
  return { effects, calls, get state() { return state; }, get observed() { return observed; }, setState: changes => Object.assign(state, changes), setObserved: changes => Object.assign(observed, changes) };
}

test('manual GitHub merge deploys exact main and seeds once across watcher restarts', async () => {
  const box = harness();
  assert.equal((await watchTick(box.effects)).status, 'seeded');
  assert.deepEqual(box.calls, [['deploy', regression], ['sleep', 1100], ['seed', regression]]);
  box.calls.length = 0;
  assert.equal((await watchTick(box.effects)).status, 'watching');
  assert.deepEqual(box.calls, []);
  assert.equal(box.state.lastSeededSha, regression);
});

test('watcher never bootstraps, deploys unrelated commits, skips phases, or accepts fork PRs', async () => {
  for (const mutate of [
    box => box.setState({ watchArm: undefined }),
    box => box.setObserved({ files: ['controller/cli.mjs', 'sut/release.json'] }),
    box => box.setObserved({ ancestor: false }),
    box => box.setObserved({ phase: 'fix' }),
    box => { box.observed.pr.head.repo.full_name = 'someone/fork'; },
    box => { box.observed.pr.merged_at = null; },
    box => { box.observed.pr.merge_commit_sha = fix; },
    box => box.setState({ pendingSeed: { sha: baseline } }),
    box => box.setState({ pendingRecordUnknown: true }),
    box => box.setState({ pendingSha: fix }),
  ]) {
    const box = harness(); mutate(box);
    await assert.rejects(watchTick(box.effects));
    assert.deepEqual(box.calls, []);
  }
});

test('restart after verified deployment resumes only seed; uncertain ingestion refuses replay', async () => {
  const box = harness();
  box.setState({ deployedSha: regression, phase: 'regression' });
  await watchTick(box.effects);
  assert.deepEqual(box.calls, [['sleep', 0], ['seed', regression]]);
  box.calls.length = 0;
  box.setState({ pendingSeed: { sha: regression } });
  await assert.rejects(watchTick(box.effects), /uncertain/);
  assert.deepEqual(box.calls, []);
});

test('failed deployment does not seed and can retry the same pending commit', async () => {
  const box = harness();
  const realDeploy = box.effects.deploy;
  box.effects.deploy = async sha => { box.setState({ pendingSha: sha }); throw new Error('SSH unavailable'); };
  await assert.rejects(watchTick(box.effects), /SSH unavailable/);
  assert.equal(box.state.lastSeededSha, baseline);
  box.effects.deploy = async sha => { await realDeploy(sha); box.setState({ pendingSha: undefined }); };
  await watchTick(box.effects);
  assert.equal(box.state.lastSeededSha, regression);
});

test('poll loop bounds repeated failures and once performs only one tick', async () => {
  const logs = []; let attempts = 0, waits = 0;
  await assert.rejects(watchLoop({ tick: async () => { attempts++; throw new Error('reconcile required'); }, sleep: async () => waits++, log: row => logs.push(row) }));
  assert.equal(attempts, 3); assert.equal(waits, 2); assert.equal(logs.at(-1).failures, 3);
  attempts = 0; waits = 0;
  await watchLoop({ once: true, tick: async () => { attempts++; return { status: 'watching' }; }, sleep: async () => waits++, log: () => {} });
  assert.equal(attempts, 1); assert.equal(waits, 0);
});

test('post-release synthetic windows start after the recorded GitHub deployment boundary', () => {
  const window = seedWindow({ now: 20000, deployedAt: 10000, telemetryNotBefore: 17000, phase: 'regression' });
  assert.equal(window.start, 17000);
  assert.equal(window.end, 19000);
  assert.throws(() => seedWindow({ now: 18500, deployedAt: 10000, telemetryNotBefore: 17000, phase: 'fix' }), /Wait a moment/);
  // Baseline prehistory is a separate population; the current window is post-deploy.
  assert.equal(seedWindow({ now: 400000, deployedAt: 395000, telemetryNotBefore: 397000, phase: 'baseline' }).start, 397000);
});

test('watcher survives long operator lock contention and still stops on real repeated failures', async () => {
  let attempts = 0;
  const logs = [];
  await assert.rejects(watchLoop({
    tick: async () => {
      attempts++;
      if (attempts <= 5) throw Object.assign(new Error('Another controller action is running'), { code: 'DEMO_CONTROLLER_BUSY' });
      throw new Error('SSH unavailable');
    },
    sleep: async () => {}, log: row => logs.push(row),
  }), /SSH unavailable/);
  assert.equal(attempts, 8);
  assert.equal(logs.filter(row => row.status === 'busy').length, 1);
  assert.deepEqual(logs.filter(row => row.status === 'paused').map(row => row.failures), [1, 2, 3]);
});

test('real stacked Git merges preserve watcher code added to baseline after PR branches were prepared', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clerk-demo-stacked-pr-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const commit = message => { git('add', '.'); git('-c', 'user.name=Demo Test', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', message); };
  const release = phase => writeFileSync(join(cwd, 'sut/release.json'), JSON.stringify(RELEASES[phase], null, 2) + '\n');
  try {
    git('init', '-q', '-b', 'main');
    mkdirSync(join(cwd, 'sut')); mkdirSync(join(cwd, 'controller'));
    release('baseline'); writeFileSync(join(cwd, 'controller/cli.mjs'), '// before watcher integration\n'); commit('baseline');
    git('switch', '-c', 'codex/demo-regression'); release('regression'); commit('bad policy');
    git('switch', '-c', 'codex/demo-fix'); release('fix'); commit('fix policy');
    git('switch', 'main');
    const cli = readFileSync(new URL('../controller/cli.mjs', import.meta.url), 'utf8');
    const watcher = readFileSync(new URL('../controller/watch.mjs', import.meta.url), 'utf8');
    writeFileSync(join(cwd, 'controller/cli.mjs'), cli); writeFileSync(join(cwd, 'controller/watch.mjs'), watcher); commit('integrate watcher on baseline');
    for (const [branch, phase] of [['codex/demo-regression', 'regression'], ['codex/demo-fix', 'fix']]) {
      const previous = git('rev-parse', 'HEAD');
      git('-c', 'user.name=Demo Test', '-c', 'user.email=demo@example.invalid', 'merge', '--no-ff', '-m', `Merge ${phase}`, branch);
      assert.equal(git('diff', '--name-only', previous, 'HEAD'), 'sut/release.json');
      assert.equal(readFileSync(join(cwd, 'controller/cli.mjs'), 'utf8'), cli);
      assert.equal(readFileSync(join(cwd, 'controller/watch.mjs'), 'utf8'), watcher);
      assert.equal(JSON.parse(git('show', 'HEAD:sut/release.json')).phase, phase);
      assert.equal(git('status', '--porcelain'), '');
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('idle watcher does not fabricate a refreshed baseline and interrupted arm requires explicit resume', async () => {
  const box = harness();
  box.setState({ lastSeedEnd: -86400000 });
  box.setObserved({ sha: baseline, phase: 'baseline' });
  assert.equal((await watchTick(box.effects)).status, 'watching');
  assert.deepEqual(box.calls, []);
  box.setState({ baselineRefresh: { sha: baseline, stage: 'seed' } });
  await assert.rejects(watchTick(box.effects), /Resume arm/);
  assert.deepEqual(box.calls, []);
});
