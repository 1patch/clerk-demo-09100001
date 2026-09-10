import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createBundle, deploy, validateTarget } from '../deploy/deploy.mjs';

const sha = 'a'.repeat(40);
test('deployment rejects shell interpolation, options, other hosts, and moving revisions', () => {
  for (const host of ['-oProxyCommand=evil', 'demo.exe.xyz;touch /tmp/x', 'prod.example.com', 'localhost', 'user@demo.exe.xyz', 'demo.exe.xyz\ntrue']) {
    assert.throws(() => validateTarget(host, sha));
  }
  for (const revision of ['HEAD', 'main', 'abc123', `${sha};evil`]) assert.throws(() => validateTarget('demo.exe.xyz', revision));
  assert.doesNotThrow(() => validateTarget('demo.exe.xyz', sha));
  assert.doesNotThrow(() => validateTarget('localhost', sha, true));
});

test('localhost dry run resolves exact committed SUT without mutating refs or HEAD', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clerk-demo-deploy-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    mkdirSync(join(cwd, 'sut'));
    writeFileSync(join(cwd, 'sut/server.mjs'), 'console.log("test fixture");\n');
    git('add', '.');
    git('-c', 'user.name=Demo Test', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'fixture');
    const revision = git('rev-parse', 'HEAD');
    const refs = git('show-ref');
    const result = deploy({ host: 'localhost', revision, cwd, dryRun: true });
    assert.equal(result.revision, revision);
    assert.equal(result.directory, '/opt/clerk-demo');
    assert.equal(result.dryRun, true);
    assert.equal(git('rev-parse', 'HEAD'), revision);
    assert.equal(git('show-ref'), refs);
    assert.equal(git('status', '--porcelain'), '');
    assert.throws(() => deploy({ host: 'localhost', revision: sha, cwd, dryRun: true }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('remote installer shell syntax is valid', () => {
  execFileSync('bash', ['-n', new URL('../deploy/remote-install.sh', import.meta.url).pathname]);
});

test('self-contained bundles restore real detached HEAD across regression and reset', () => {
  const temp = mkdtempSync(join(tmpdir(), 'clerk-demo-bundle-test-'));
  const source = join(temp, 'source');
  const remote = join(temp, 'remote');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(source); mkdirSync(remote);
    git(source, 'init', '-q'); git(remote, 'init', '-q');
    const commits = [];
    for (const phase of ['healthy', 'regression', 'fixed']) {
      writeFileSync(join(source, 'phase.txt'), phase);
      git(source, 'add', '.');
      git(source, '-c', 'user.name=Demo Test', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', phase);
      commits.push(git(source, 'rev-parse', 'HEAD'));
    }
    for (const revision of [...commits, commits[0]]) {
      const output = join(temp, 'repo.bundle');
      rmSync(output, { force: true });
      createBundle({ cwd: source, revision, output });
      git(remote, 'fetch', '--no-tags', output, '+refs/clerk-demo/deploy:refs/clerk-demo/deploy');
      git(remote, 'checkout', '--detach', revision);
      assert.equal(git(remote, 'rev-parse', 'HEAD'), revision);
      assert.equal(git(remote, 'branch', '--show-current'), '');
      assert.equal(git(remote, 'status', '--porcelain'), '');
    }
    assert.equal(git(source, 'rev-parse', 'HEAD'), commits[2]);
    assert.equal(git(source, 'status', '--porcelain'), '');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// Execute the installer's real shell control flow in a temporary filesystem.
// Only absolute installation/node paths and the root check change in this copy.
// systemctl/curl/id/sleep are harmless process shims; Git/bundles/checkouts are real.
function installerSandbox() {
  const temp = mkdtempSync(join(tmpdir(), 'clerk-demo-installer-test-'));
  const source = join(temp, 'source');
  const stage = join(temp, 'stage');
  const target = join(temp, 'installed');
  const unit = join(temp, 'clerk-demo.service');
  const bin = join(temp, 'bin');
  const log = join(temp, 'systemctl.log');
  for (const path of [source, stage, bin]) mkdirSync(path);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  let script = readFileSync(new URL('../deploy/remote-install.sh', import.meta.url), 'utf8');
  assert.ok(script.includes('readonly target=/opt/clerk-demo'));
  assert.ok(script.includes('readonly unit=/etc/systemd/system/clerk-demo.service'));
  script = script.replace('readonly target=/opt/clerk-demo', `readonly target=${quote(target)}`)
    .replace('readonly unit=/etc/systemd/system/clerk-demo.service', `readonly unit=${quote(unit)}`)
    .replace('[[ $EUID -eq 0 ]]', '[[ 0 -eq 0 ]]')
    .replaceAll('/usr/bin/node', quote(process.execPath));
  writeFileSync(join(stage, 'remote-install.sh'), script);
  writeFileSync(join(stage, 'clerk-demo.service'), readFileSync(new URL('../deploy/clerk-demo.service', import.meta.url)));
  for (const [command, body] of Object.entries({
    systemctl: 'printf "%s\\n" "$*" >> "$INSTALLER_TEST_LOG"',
    curl: 'printf "%s" "$INSTALLER_TEST_HEALTH"',
    id: 'exit 0',
    useradd: 'echo "Unexpected useradd" >&2; exit 1',
    sleep: 'exit 0',
  })) writeFileSync(join(bin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '-q');
  mkdirSync(join(source, 'sut'));
  writeFileSync(join(source, 'sut/server.mjs'), '/* committed SUT fixture */\n');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Demo Test', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'fixture');
  const revision = git(source, 'rev-parse', 'HEAD');
  createBundle({ cwd: source, revision, output: join(stage, 'repo.bundle') });
  const run = (health = { version: revision }) => spawnSync('bash', [join(stage, 'remote-install.sh'), revision], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_SYSTEM: join(temp, 'git-system-config'), INSTALLER_TEST_LOG: log, INSTALLER_TEST_HEALTH: JSON.stringify(health) },
  });
  return { temp, target, unit, log, revision, run, git, clean: () => rmSync(temp, { recursive: true, force: true }) };
}

test('remote installer refuses an unrelated installation before any service action', () => {
  const box = installerSandbox();
  try {
    mkdirSync(box.target);
    writeFileSync(join(box.target, 'keep.txt'), 'unrelated data');
    const result = box.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a managed demo/);
    assert.equal(readFileSync(join(box.target, 'keep.txt'), 'utf8'), 'unrelated data');
    assert.equal(existsSync(box.log), false);
  } finally { box.clean(); }
});

test('remote installer refuses an unrelated service definition without creating checkout', () => {
  const box = installerSandbox();
  try {
    writeFileSync(box.unit, '[Service]\nDescription=unrelated\n');
    const result = box.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unrelated systemd unit/);
    assert.equal(existsSync(box.target), false);
    assert.equal(existsSync(box.log), false);
  } finally { box.clean(); }
});

test('remote installer verifies a real checkout then refuses tracked and untracked modifications', () => {
  const box = installerSandbox();
  try {
    const initial = box.run();
    assert.equal(initial.status, 0, initial.stderr);
    const deployed = JSON.parse(initial.stdout.trim().split('\n').at(-1));
    assert.equal(deployed.head, box.revision);
    assert.equal(deployed.health.version, box.revision);
    assert.equal(box.git(box.target, 'rev-parse', 'HEAD'), box.revision);
    const log = readFileSync(box.log, 'utf8');
    writeFileSync(join(box.target, 'sut/server.mjs'), '/* local change */\n');
    const dirty = box.run();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /checkout is dirty/);
    assert.equal(readFileSync(join(box.target, 'sut/server.mjs'), 'utf8'), '/* local change */\n');
    assert.equal(readFileSync(box.log, 'utf8'), log);
    box.git(box.target, 'restore', 'sut/server.mjs');
    writeFileSync(join(box.target, 'local-note.txt'), 'preserve me');
    const untracked = box.run();
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /checkout is dirty/);
    assert.equal(readFileSync(join(box.target, 'local-note.txt'), 'utf8'), 'preserve me');
    assert.equal(readFileSync(box.log, 'utf8'), log);
  } finally { box.clean(); }
});

test('remote installer never reports success when runtime health has the wrong SHA', () => {
  const box = installerSandbox();
  try {
    const result = box.run({ version: '0'.repeat(40) });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /failed health\/version verification/);
    assert.doesNotMatch(result.stdout, /"deployed":true/);
    assert.equal(box.git(box.target, 'rev-parse', 'HEAD'), box.revision);
    assert.match(readFileSync(box.log, 'utf8'), /restart clerk-demo.service/);
  } finally { box.clean(); }
});
