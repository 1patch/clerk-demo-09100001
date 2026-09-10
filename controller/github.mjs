import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASES } from '../sut/telemetry.mjs';

export const REPOSITORY = '1patch/clerk-demo-09100001';
export const execute = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
export const git = (cwd, ...args) => execute('git', args, cwd);
export const gh = (...args) => execute('gh', args);
export const ghPost = (path, body) => JSON.parse(execFileSync('gh', ['api', path, '--method', 'POST', '--input', '-'], {
  input: JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
}));
export function assertRepository(cwd) {
  const allowed = ['https://github.com/1patch/clerk-demo-09100001.git', 'git@github.com:1patch/clerk-demo-09100001.git'];
  if (!allowed.includes(git(cwd, 'remote', 'get-url', 'origin')) ||
      git(cwd, 'remote', 'get-url', '--push', '--all', 'origin').split('\n').some((url) => !allowed.includes(url)))
    throw new Error('Local origin is not the dedicated demo repository');
  if (git(cwd, 'status', '--porcelain')) throw new Error('Commit or stash local changes before a demo action');
}
export const mainSha = () => JSON.parse(gh('api', `repos/${REPOSITORY}/git/ref/heads/main`)).object.sha;
export function releaseAt(cwd, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full commit SHA');
  const release = JSON.parse(git(cwd, 'show', `${sha}:sut/release.json`));
  if (JSON.stringify(release) !== JSON.stringify(RELEASES[release.phase])) throw new Error('Commit does not contain a recognized demo release');
  return release;
}
export function assertTransition(from, to) {
  if (!((from === 'baseline' && to === 'regression') || (from === 'regression' && to === 'fix') || (['regression', 'fix'].includes(from) && to === 'baseline')))
    throw new Error(`Unsupported demo transition: ${from} -> ${to}`);
}
export function assertPullRequest(pr, { expectedPhase }) {
  // GitHub may retain the base OID from PR creation even after main advances.
  // Pin current main through its branch ref and recheck it immediately at merge.
  if (pr.baseRefName !== 'main' || pr.state !== 'OPEN' || pr.isDraft || pr.headRepository?.nameWithOwner !== REPOSITORY)
    throw new Error('PR must be ready for review, open, and target the demo main');
  if (!/^codex\/demo-[a-z0-9-]+$/.test(pr.headRefName)) throw new Error('PR is not a prepared demo branch');
  if (pr.files?.length !== 1 || pr.files[0].path !== 'sut/release.json') throw new Error('Demo PR may only change sut/release.json');
  if (!RELEASES[expectedPhase]) throw new Error('Unrecognized release phase');
}

/** Prepare only. Human reviews and marks the PR ready before `apply`. */
export async function prepare(cwd, phase, mutate) {
  assertRepository(cwd);
  if (!RELEASES[phase]) throw new Error('Phase must be baseline, regression, or fix');
  git(cwd, 'fetch', 'origin', 'main');
  const before = mainSha();
  const from = releaseAt(cwd, before);
  assertTransition(from.phase, phase);
  const directory = mkdtempSync(join(tmpdir(), 'clerk-demo-pr-'));
  const branch = `codex/demo-${phase}-${Date.now()}`;
  try {
    git(cwd, 'worktree', 'add', '--detach', directory, before);
    writeFileSync(join(directory, 'sut/release.json'), `${JSON.stringify(RELEASES[phase], null, 2)}\n`);
    git(directory, 'add', 'sut/release.json');
    git(directory, 'commit', '-m', phase === 'regression' ? 'Reduce verification latency during session creation' : phase === 'fix' ? 'Restore verifier timeout budget and advisory fallback' : 'Restore healthy baseline for a new demo pass');
    const head = git(directory, 'rev-parse', 'HEAD');
    await mutate(() => execute('git', ['push', 'origin', `${head}:refs/heads/${branch}`], cwd));
    const bodyPath = join(directory, 'pr-body.md');
    writeFileSync(bodyPath, phase === 'regression'
      ? 'Reduce the verifier timeout budget during session creation.\n\nValidation: request behavior is covered by the service tests.\n'
      : phase === 'fix'
        ? 'Restore the verifier timeout budget and advisory fallback for session creation.\n\nValidation: request behavior is covered by the service tests.\n'
        : 'Restore the baseline verifier policy.\n');
    const url = await mutate(() => gh('pr', 'create', '--repo', REPOSITORY, '--base', 'main', '--head', branch, '--draft', '--title', phase === 'regression' ? 'Reduce verifier latency during session creation' : phase === 'fix' ? 'Restore verifier timeout budget and advisory fallback' : 'Restore baseline verifier policy', '--body-file', bodyPath));
    return { url, phase, head, base: before };
  } finally {
    try { git(cwd, 'worktree', 'remove', '--force', directory); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

export async function merge(cwd, number, mutate) {
  assertRepository(cwd);
  if (!/^[1-9][0-9]*$/.test(String(number))) throw new Error('Expected PR number');
  git(cwd, 'fetch', 'origin');
  const before = mainSha();
  const pr = JSON.parse(gh('pr', 'view', String(number), '--repo', REPOSITORY, '--json', 'baseRefName,baseRefOid,headRefName,headRefOid,headRepository,state,isDraft,files'));
  const phase = releaseAt(cwd, pr.headRefOid).phase;
  assertPullRequest(pr, { expectedPhase: phase });
  assertTransition(releaseAt(cwd, before).phase, phase);
  await mutate(() => {
    if (mainSha() !== before) throw new Error('Main changed before merge; re-review');
    return gh('pr', 'merge', String(number), '--repo', REPOSITORY, '--merge', '--match-head-commit', pr.headRefOid);
  });
  const merged = JSON.parse(gh('pr', 'view', String(number), '--repo', REPOSITORY, '--json', 'mergeCommit,state'));
  if (merged.state !== 'MERGED' || merged.mergeCommit?.oid !== mainSha()) throw new Error('Merged commit is not current main; stop before deployment');
  git(cwd, 'fetch', 'origin', 'main');
  git(cwd, 'switch', '--detach', merged.mergeCommit.oid);
  return { sha: merged.mergeCommit.oid, phase, pr: Number(number) };
}
