import { assertTransition, REPOSITORY } from './github.mjs';

export function assertObservedRelease(observed, state) {
  if (state.watchArm?.repository !== REPOSITORY || !/^[a-f0-9]{40}$/.test(state.watchArm?.baselineSha ?? ''))
    throw new Error('Watcher is not armed. Run arm explicitly on the healthy baseline first.');
  if (!state.deployedSha || !/^[a-f0-9]{40}$/.test(observed.sha ?? '')) throw new Error('Verified deployment and exact main SHA required');
  if (state.pendingSeed || state.pendingRecordUnknown) throw new Error('An earlier write is uncertain; reconcile before watching');
  if (state.baselineRefresh) throw new Error('Resume arm to finish the explicit baseline refresh before watching');
  if (state.pendingSha && state.pendingSha !== observed.sha) throw new Error('Main moved past a pending deployment; reconcile explicitly');
  if (observed.sha === state.deployedSha) return;
  if (!observed.ancestor || observed.files?.length !== 1 || observed.files[0] !== 'sut/release.json')
    throw new Error('Watcher only deploys forward, release-policy-only changes from the verified revision');
  const pr = observed.pr;
  if (!pr || pr.state !== 'closed' || !pr.merged_at || pr.merge_commit_sha !== observed.sha || pr.base?.ref !== 'main' || pr.head?.repo?.full_name !== REPOSITORY || !/^codex\/demo-[a-z0-9-]+$/.test(pr.head?.ref ?? ''))
    throw new Error('New main must be a merged demo PR in the pinned GitHub repository');
  assertTransition(state.phase, observed.phase);
}

/** Each tick runs inside the caller's local lock. Effects use the normal guarded commands. */
export async function watchTick(effects) {
  let state = effects.readState();
  if (!state.watchArm) throw new Error('Watcher is not armed. Run arm explicitly on the healthy baseline first.');
  const observed = await effects.observe(state);
  assertObservedRelease(observed, state);
  let deployed = false;
  if (state.deployedSha !== observed.sha || state.pendingSha) {
    await effects.deploy(observed.sha);
    state = effects.readState();
    if (state.deployedSha !== observed.sha || state.pendingSha) throw new Error('Deployment did not finish at the observed SHA');
    deployed = true;
  }
  if (state.lastSeededSha !== observed.sha) {
    await effects.sleep(Math.max(0, (state.telemetryNotBefore ?? state.deployedAt) + 2100 - effects.now()));
    await effects.seed();
    state = effects.readState();
    if (state.lastSeededSha !== observed.sha || state.pendingSeed) throw new Error('Seed did not produce a durable receipt for the observed SHA');
    return { status: 'seeded', sha: observed.sha, phase: state.phase, deployed };
  }
  return { status: 'watching', sha: observed.sha, phase: state.phase };
}

export async function watchLoop({ tick, once = false, sleep, log, stopped = () => false, intervalMs = 3000, maxFailures = 3 }) {
  let failures = 0;
  let lastStatus;
  while (!stopped()) {
    try {
      const result = await tick();
      const status = JSON.stringify(result);
      if (status !== lastStatus) { log(result); lastStatus = status; }
      failures = 0;
      if (once) return result;
    } catch (error) {
      if (error?.code === 'DEMO_CONTROLLER_BUSY' && !once) {
        if (lastStatus !== 'busy') log({ status: 'busy', message: error.message });
        lastStatus = 'busy';
        await sleep(intervalMs);
        continue;
      }
      failures++;
      log({ status: 'paused', failures, message: error?.stderr ? 'External command failed; check GitHub/AWS/SSH access.' : error.message });
      if (once || failures >= maxFailures) throw error;
    }
    await sleep(intervalMs);
  }
}
