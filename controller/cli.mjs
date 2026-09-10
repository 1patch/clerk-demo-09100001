#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, createControllerGuard } from './config.mjs';
import { git, gh, ghPost, execute, REPOSITORY, assertRepository, mainSha, releaseAt, prepare, merge } from './github.mjs';
import { deploy, validateTarget } from '../deploy/deploy.mjs';
import { buildHistoricalTelemetry } from '../sut/telemetry.mjs';
import { watchTick, watchLoop } from './watch.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = resolve(root, '.demo/state.json');
const auditPath = resolve(root, '.demo/actions.jsonl');
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const usage = `Laptop-only demo controller (Node 22+, git, gh, aws, ssh):
  npm run demo -- status
  npm run demo -- prepare regression|fix|baseline
  npm run demo -- apply PR_NUMBER
  npm run demo -- deploy             Deploy current main (also resumes a failed deployment)
  npm run demo -- seed               Seed representative requests (first baseline: 1,000 each side)
  npm run demo -- arm                Explicitly deploy + seed healthy baseline and arm watcher
  npm run demo -- watch [--once]     Follow manual GitHub merges; deploy + seed each SHA once
  npm run demo -- smoke              Verify live sample 11 against the currently deployed policy

Copy demo.config.example.json to .demo/config.json and fill exact target pins.
Set laptop WORKOS_API_KEY for that same environment. Never copy credentials to exe.dev.
prepare creates a draft PR; review and mark ready in GitHub before apply.
No command closes an incident or fabricates agent conclusions. OnePatch verifies recovery.
`;

export function assertRuntime({ expectedSha, localSha, githubSha, health }) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || localSha !== expectedSha || githubSha !== expectedSha || health?.version !== expectedSha)
    throw new Error('Local HEAD, GitHub main, and running SUT must match before telemetry can be emitted');
}

// The tenant compares the hour before a release. Leave at least fifteen
// minutes for presenting and applying the regression after explicitly arming.
export const BASELINE_REFRESH_AFTER_MS = 45 * 60 * 1000;

export function planBaselineArm(state, sha, now) {
  if (state.pendingSeed || state.pendingRecordUnknown || (state.pendingSha && state.pendingSha !== sha))
    throw new Error('Reconcile pending writes before arming');
  if (state.baselineRefresh && state.baselineRefresh.sha !== sha)
    throw new Error('Main changed during baseline refresh; reconcile before arming');
  const observedAt = Math.min(state.lastSeedEnd ?? Infinity, state.telemetryNotBefore ?? state.deployedAt ?? -Infinity);
  const stale = state.deployedSha === sha &&
    ((state.lastSeededSha === sha && !Number.isFinite(state.lastSeedEnd)) ||
      !Number.isFinite(observedAt) || !Number.isFinite(now) || now < observedAt || now - observedAt >= BASELINE_REFRESH_AFTER_MS);
  const beginRefresh = stale && state.baselineRefresh?.stage !== 'deploy';
  return {
    beginRefresh,
    deploy: state.deployedSha !== sha || Boolean(state.pendingSha) || stale || state.baselineRefresh?.stage === 'deploy',
  };
}

export function deploymentRunState(state, sha, phase, newRunId = randomUUID) {
  const refresh = phase === 'baseline' && state.baselineRefresh?.stage === 'deploy';
  const newPass = phase === 'baseline' && (state.phase !== 'baseline' || refresh);
  return {
    runId: newPass ? newRunId() : state.runId,
    ...(newPass ? { lastSeedEnd: undefined, lastSeededSha: undefined, pendingSeed: undefined } : {}),
    ...(refresh ? { baselineRefresh: { sha, stage: 'seed' } } : {}),
  };
}

export function seedWindow({ now, lastEnd, phase, deployedAt, telemetryNotBefore }) {
  if (!Number.isFinite(now) || !Number.isFinite(deployedAt)) throw new Error('Deployment timing is required');
  // Every current-phase population stays after the recorded deployment boundary.
  // buildSeedTelemetry adds a separate complete prehistory population once.
  const end = now - 1000;
  const start = Math.max(lastEnd ?? -Infinity, deployedAt, telemetryNotBefore ?? deployedAt);
  if (end - start < 1000) throw new Error('Wait a moment after deployment/last seed before seeding again');
  return { start, end, intervalMs: (end - start) / 1000 };
}

export function buildSeedTelemetry({ now, lastEnd, phase, deployedAt, telemetryNotBefore, releaseSha, runId }) {
  const post = seedWindow({ now, lastEnd, phase, deployedAt, telemetryNotBefore });
  const windows = [];
  if (phase === 'baseline' && lastEnd == null) {
    const start = deployedAt - 300000;
    const end = deployedAt - 1000;
    windows.push({ kind: 'baseline-prehistory', start, end, intervalMs: (end - start) / 1000 });
  }
  windows.push({ kind: 'post-deployment', ...post });
  const payload = { resourceSpans: windows.flatMap(window => buildHistoricalTelemetry({
    phase, releaseSha, runId, startTimeMs: window.start, sampleCount: 1000, intervalMs: window.intervalMs,
  }).resourceSpans) };
  return { payload, window: { ...post, windows, requests: windows.length * 1000 } };
}

export function readRuntime(host, sha) {
  validateTarget(host, sha);
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host];
  const head = execute('ssh', [...options, 'git -C /opt/clerk-demo rev-parse HEAD']);
  const health = JSON.parse(execute('ssh', [...options, 'curl --fail --silent --max-time 5 http://127.0.0.1:8080/health']));
  if (head !== sha || health.version !== sha) throw new Error('Remote checkout and process do not match expected deployment');
  return health;
}

async function run(args) {
  const [command, argument] = args;
  if (!command || command === '--help') { console.log(usage); return; }
  if (!['status', 'prepare', 'apply', 'deploy', 'seed', 'arm', 'watch', 'smoke'].includes(command)) throw new Error(usage);
  const config = loadConfig(resolve(root, '.demo/config.json'));
  const audit = (action, fields = {}) => appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), organizationId: config.organizationId, action, ...fields }) + '\n', { mode: 0o600 });
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { organizationId: config.organizationId, runId: randomUUID() };
  if (state.organizationId !== config.organizationId) throw new Error('Local demo state belongs to another organization');
  assertRepository(root);
  if (command === 'watch') {
    if (argument && argument !== '--once') throw new Error('Usage: watch [--once]');
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      await watchLoop({ once: argument === '--once', sleep, stopped: () => stopped, log: result => console.log(JSON.stringify(result)),
        tick: () => withLock(() => watchTick({
          readState: () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {},
          observe: current => {
            assertRepository(root);
            git(root, 'fetch', 'origin', 'main');
            const sha = mainSha();
            const phase = releaseAt(root, sha).phase;
            if (current.deployedSha && git(root, 'rev-parse', 'HEAD') !== current.deployedSha && !current.pendingSha)
              throw new Error('Local HEAD moved away from the verified deployment; reconcile before watching');
            if (sha === current.deployedSha) return { sha, phase };
            let ancestor = false;
            if (current.deployedSha) {
              try { git(root, 'merge-base', '--is-ancestor', current.deployedSha, sha); ancestor = true; } catch { /* refused below */ }
            }
            const files = current.deployedSha ? git(root, 'diff', '--name-only', current.deployedSha, sha).split('\n').filter(Boolean) : [];
            const prs = JSON.parse(gh('api', `repos/${REPOSITORY}/commits/${sha}/pulls`));
            return { sha, phase, ancestor, files, pr: prs.find(pr => pr.merge_commit_sha === sha && pr.merged_at) };
          },
          deploy: sha => run(['deploy', sha]), seed: () => run(['seed']), now: Date.now, sleep,
        })),
      });
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify({ repository: REPOSITORY, organizationId: config.organizationId, localHead: git(root, 'rev-parse', 'HEAD'), githubMain: mainSha(), state }, null, 2));
    return;
  }
  const guard = createControllerGuard(config);
  const mutate = (effect) => guard.mutate(config, effect);
  if (command === 'arm') {
    git(root, 'fetch', 'origin', 'main');
    const sha = mainSha();
    if (releaseAt(root, sha).phase !== 'baseline') throw new Error('Arm requires the healthy baseline on GitHub main');
    const armPlan = planBaselineArm(state, sha, Date.now());
    if (armPlan.beginRefresh) {
      state.baselineRefresh = { sha, stage: 'deploy' };
      save(state);
    }
    if (armPlan.deploy) await run(['deploy', sha]);
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.lastSeededSha !== sha) {
      await sleep(Math.max(0, (state.telemetryNotBefore ?? state.deployedAt) + 2100 - Date.now()));
      await run(['seed']);
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    }
    readRuntime(config.sshHost, sha);
    assertRuntime({ expectedSha: sha, localSha: git(root, 'rev-parse', 'HEAD'), githubSha: mainSha(), health: { version: state.deployedSha } });
    state.watchArm = { repository: REPOSITORY, baselineSha: sha, armedAt: Date.now() };
    delete state.baselineRefresh;
    save(state); audit('watcher_armed', { sha });
    console.log(JSON.stringify({ armed: true, sha }));
    return;
  }
  if (state.pendingSeed && command !== 'seed') throw new Error('Reconcile the uncertain telemetry write before changing the scenario');
  if (state.pendingSha && ['prepare', 'apply'].includes(command)) throw new Error('Resume the pending deployment before preparing or merging another release');
  if (command === 'smoke') {
    if (!state.deployedSha || state.pendingSha) throw new Error('Complete a verified deployment before the live smoke check');
    const health = readRuntime(config.sshHost, state.deployedSha);
    assertRuntime({ expectedSha: state.deployedSha, localSha: git(root, 'rev-parse', 'HEAD'), githubSha: mainSha(), health });
    const release = releaseAt(root, state.deployedSha);
    if (health.phase !== release.phase) throw new Error('Runtime phase does not match its commit');
    const sample = { sampleIndex: 11, runId: `smoke-${randomUUID()}` };
    const raw = await mutate(() => execute('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', config.sshHost,
      `curl --silent --show-error --max-time 5 --write-out '\\n%{http_code}' -H 'content-type: application/json' --data '${JSON.stringify(sample)}' http://127.0.0.1:8080/oauth/callback`]));
    const lines = raw.split('\n');
    const statusCode = Number(lines.pop());
    const response = JSON.parse(lines.join('\n'));
    const expectedStatus = release.phase === 'regression' ? 503 : 200;
    if (statusCode !== expectedStatus || response.releaseSha !== state.deployedSha || response.phase !== release.phase || (statusCode === 503 && response.error !== 'IP_VERIFIER_TIMEOUT'))
      throw new Error('Live sample 11 did not match the committed release behavior');
    const result = { sampleIndex: 11, statusCode, expectedStatus, phase: release.phase, sha: state.deployedSha, response, synthetic: true, telemetryIngested: false };
    audit('live_smoke_verified', { sha: state.deployedSha, phase: release.phase, statusCode, traceId: response.traceId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'prepare') {
    const result = await prepare(root, argument, mutate);
    audit('pr_prepared', result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'apply') {
    const result = await merge(root, argument, mutate);
    audit('pr_merged', result);
    state = { ...state, pendingSha: result.sha, pendingPhase: result.phase, pr: result.pr };
    save(state); // A deployment failure can resume without merging twice.
  }
  if (command === 'apply' || command === 'deploy') {
    git(root, 'fetch', 'origin', 'main');
    const sha = mainSha();
    if (command === 'deploy' && argument && argument !== sha) throw new Error('Main changed since watcher observation; stop before deployment');
    if (state.pendingSha && state.pendingSha !== sha) throw new Error('Main changed since the pending deployment; reconcile explicitly before continuing');
    const release = releaseAt(root, sha);
    git(root, 'switch', '--detach', sha);
    state.pendingSha = sha;
    save(state);
    if (!state.verifiedPending) {
      const result = await mutate(() => {
        if (mainSha() !== sha) throw new Error('Main changed before deployment');
        return deploy({ host: config.sshHost, revision: sha, cwd: root });
      });
      if (mainSha() !== sha) throw new Error('Main changed during deployment; reconcile before continuing');
      state.verifiedPending = { result, deployedAt: Date.now() };
      save(state);
    }
    readRuntime(config.sshHost, sha);
    const { result, deployedAt } = state.verifiedPending;
    // A real GitHub deployment object; status success only follows remote verification.
    if (state.pendingRecordUnknown) throw new Error('GitHub deployment creation had an uncertain outcome; inspect and reconcile it before retrying');
    if (!state.pendingDeploymentId) await mutate(() => {
      state.pendingRecordUnknown = true; save(state);
      const deployment = ghPost(`repos/${REPOSITORY}/deployments`, {
        ref: sha, environment: 'demo', auto_merge: false, required_contexts: [],
        description: 'Laptop controller verified exe.dev Git HEAD and runtime version',
        payload: { demo: true, service: 'auth-service', organizationId: config.organizationId, revision: sha },
      });
      if (!Number.isSafeInteger(deployment.id)) throw new Error('GitHub did not create a deployment record');
      state.pendingDeploymentId = deployment.id; delete state.pendingRecordUnknown; save(state);
    });
    const deploymentId = state.pendingDeploymentId;
    const statuses = JSON.parse(gh('api', `repos/${REPOSITORY}/deployments/${deploymentId}/statuses`));
    const successStatus = statuses.find((status) => status.state === 'success') ?? await mutate(() => ghPost(`repos/${REPOSITORY}/deployments/${deploymentId}/statuses`, {
        state: 'success', environment: 'demo', environment_url: config.sutOrigin,
        description: 'Verified exact Git HEAD and running service version', auto_inactive: true,
      }));
    // Keep post-release evidence after the real GitHub event/status, even when
    // recording that event took longer than switching and verifying the process.
    const telemetryNotBefore = Math.max(deployedAt, Date.now(), Date.parse(successStatus.created_at) || 0);
    state = { ...state, deployedSha: sha, phase: release.phase, deployedAt, telemetryNotBefore, deploymentId,
      ...deploymentRunState(state, sha, release.phase) };
    delete state.pendingSha; delete state.pendingPhase; delete state.verifiedPending; delete state.pendingDeploymentId;
    save(state);
    audit('deployed', { sha, phase: release.phase, deploymentId });
    console.log(JSON.stringify({ ...result, deploymentId }, null, 2));
    return;
  }
  if (command === 'seed') {
    if (!state.deployedSha) throw new Error('Deploy and verify the SUT before seeding');
    const health = readRuntime(config.sshHost, state.deployedSha);
    assertRuntime({ expectedSha: state.deployedSha, localSha: git(root, 'rev-parse', 'HEAD'), githubSha: mainSha(), health });
    const release = releaseAt(root, state.deployedSha);
    if (health.phase !== release.phase) throw new Error('Runtime phase does not match the commit');
    const { payload, window } = buildSeedTelemetry({ now: Date.now(), lastEnd: state.lastSeedEnd, phase: release.phase, deployedAt: state.deployedAt, telemetryNotBefore: state.telemetryNotBefore, releaseSha: state.deployedSha, runId: state.runId });
    // Save intent before the append-only write. An uncertain response must be
    // inspected, not blindly retried into duplicate evidence.
    if (state.pendingSeed) throw new Error('An earlier seed has an uncertain outcome; inspect it before retrying');
    await mutate(async ({ ingestUrl, ingestToken }) => {
      state.pendingSeed = { ...window, sha: state.deployedSha };
      save(state);
      const res = await fetch(`${ingestUrl}/v1/traces`, { method: 'POST', headers: { authorization: `Bearer ${ingestToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`OTLP ingestion failed (${res.status}); inspect pending seed before retrying`);
      const accepted = await res.json();
      if (Number(accepted.partialSuccess?.rejectedSpans ?? 0) !== 0) throw new Error('OTLP rejected spans; pending seed needs inspection');
    });
    state.lastSeedEnd = window.end;
    state.lastSeededSha = state.deployedSha;
    delete state.pendingSeed;
    save(state);
    audit('synthetic_window_ingested', { ...window, sha: state.deployedSha, phase: release.phase, runId: state.runId });
    console.log(JSON.stringify({ phase: release.phase, runId: state.runId, sha: state.deployedSha, ...window }, null, 2));
  }
}

async function withLock(effect) {
  const lock = resolve(root, '.demo/lock');
  let locked = false;
  try {
    mkdirSync(resolve(root, '.demo'), { recursive: true, mode: 0o700 });
    try { mkdirSync(lock); }
    catch (error) {
      if (error.code === 'EEXIST') {
        const busy = new Error('Another controller action is running; inspect .demo/lock if a prior process crashed.');
        busy.code = 'DEMO_CONTROLLER_BUSY';
        throw busy;
      }
      throw error;
    }
    locked = true;
    return await effect();
  } finally { if (locked) rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'watch') await run(process.argv.slice(2));
    else await withLock(() => run(process.argv.slice(2)));
  } catch (error) {
    // Child-process messages can include stderr or environment details. Keep
    // those out of logs; the operator can run read-only status commands directly.
    console.error(error?.stderr ? 'External command failed; inspect GitHub/AWS/SSH access and retry status.' : error.message);
    process.exitCode = 1;
  }
}
