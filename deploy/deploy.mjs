#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();

export function validateTarget(host, revision, dryRun = false) {
  if (typeof host !== 'string' || !(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.exe\.xyz$/.test(host) || (dryRun && host === 'localhost'))) {
    throw new Error('Host must be an explicit VM hostname ending .exe.xyz (localhost is dry-run only)');
  }
  if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('Revision must be a full lowercase Git commit SHA');
}

export function createBundle({ cwd, revision, output }) {
  if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('Full commit SHA required');
  const temp = mkdtempSync(join(tmpdir(), 'clerk-demo-bundle-'));
  try {
    const stagingRepo = join(temp, 'bundle.git');
    run('git', ['init', '--bare', stagingRepo]);
    run('git', ['-C', stagingRepo, 'fetch', resolve(cwd), `${revision}:refs/clerk-demo/deploy`]);
    run('git', ['-C', stagingRepo, 'bundle', 'create', resolve(output), 'refs/clerk-demo/deploy']);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Laptop only: transports committed code, never credentials, and verifies deployed HEAD + health. */
export function deploy({ host, revision, cwd = resolve(here, '..'), dryRun = false }) {
  validateTarget(host, revision, dryRun);
  const actual = run('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd });
  if (actual !== revision) throw new Error('Revision did not resolve exactly');
  run('git', ['cat-file', '-e', `${revision}:sut/server.mjs`], { cwd });
  const plan = { host, revision, directory: '/opt/clerk-demo', health: 'http://127.0.0.1:8080/health', service: 'clerk-demo.service' };
  if (dryRun) return { dryRun: true, ...plan };

  const temp = mkdtempSync(join(tmpdir(), 'clerk-demo-deploy-'));
  const bundle = join(temp, 'repo.bundle');
  const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
  let remoteStage;
  try {
    // A temporary bare repository makes a self-contained bundle without touching local refs.
    createBundle({ cwd, revision, output: bundle });
    remoteStage = run('ssh', [...sshOptions, host, 'mktemp -d /tmp/clerk-demo-deploy.XXXXXXXXXX']);
    if (!/^\/tmp\/clerk-demo-deploy\.[A-Za-z0-9]{10}$/.test(remoteStage)) throw new Error('Unexpected remote staging path');
    run('scp', [...sshOptions, bundle, join(here, 'remote-install.sh'), join(here, 'clerk-demo.service'), `${host}:${remoteStage}/`]);
    const output = run('ssh', [...sshOptions, host, `sudo -n bash ${remoteStage}/remote-install.sh ${revision}`]);
    const result = JSON.parse(output.split('\n').at(-1));
    if (result.deployed !== true || result.head !== revision || result.health?.version !== revision) throw new Error('Remote did not verify expected HEAD and health version');
    return { ...plan, ...result };
  } finally {
    if (remoteStage && /^\/tmp\/clerk-demo-deploy\.[A-Za-z0-9]{10}$/.test(remoteStage)) {
      try { run('ssh', [...sshOptions, host, `rm -rf -- ${remoteStage}`]); } catch { /* installation result remains primary */ }
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  try {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag === '--dry-run') options.dryRun = true;
      else if (['--host', '--revision', '--cwd'].includes(flag) && args[index + 1]) options[flag.slice(2)] = args[++index];
      else throw new Error('Usage: node deploy/deploy.mjs --host VM.exe.xyz --revision FULL_SHA [--dry-run] [--cwd PATH]');
    }
    if (!options.dryRun) throw new Error('Use the guarded laptop controller for real deployments; standalone deployment supports --dry-run only');
    console.log(JSON.stringify(deploy(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
