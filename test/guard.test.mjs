import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDemoGuard, createWorkosAuthorityReader, PROTECTED_ORGANIZATIONS } from '../controller/guard.mjs';

const pins = Object.freeze({ organizationId: 'org_demo123', onepatchOrigin: 'https://app.staging.onepatch.dev', githubRepository: '1patch/clerk-demo-09100001' });
const token = 'op_test_demo_token';
function authority() {
  return {
    onepatchOrigin: pins.onepatchOrigin,
    organization: { id: pins.organizationId, metadata: { demo_instance: 'true', github_repos: JSON.stringify([pins.githubRepository]), otel_ingest_token: token } },
    tenant: { orgId: pins.organizationId, status: 'active', dataLayerMode: 'hosted', ingestUrl: 'https://demo.logger.staging.onepatch.dev', chIngestTokenSha256: createHash('sha256').update(token).digest('hex') },
  };
}

for (const [name, modify] of [
  ['missing demo marker', (a) => delete a.organization.metadata.demo_instance],
  ['false demo marker', (a) => { a.organization.metadata.demo_instance = 'false'; }],
  ['boolean demo marker', (a) => { a.organization.metadata.demo_instance = true; }],
  ['wrong organization', (a) => { a.organization.id = 'org_other'; }],
  ['wrong authority origin', (a) => { a.onepatchOrigin = 'https://app.onepatch.dev'; }],
  ['wrong repository', (a) => { a.organization.metadata.github_repos = '["1patch/onep-internal"]'; }],
  ['malformed repository metadata', (a) => { a.organization.metadata.github_repos = '1patch/clerk-demo-09100001'; }],
  ['wrong registry org', (a) => { a.tenant.orgId = 'org_other'; }],
  ['inactive registry', (a) => { a.tenant.status = 'creating'; }],
  ['different ingest token', (a) => { a.organization.metadata.otel_ingest_token = 'op_another'; }],
  ['missing token hash', (a) => delete a.tenant.chIngestTokenSha256],
  ['external data layer', (a) => { a.tenant.dataLayerMode = 'external'; }],
  ['HTTP ingest override', (a) => { a.tenant.ingestUrl = 'http://localhost:4318'; }],
  ['URL credentials', (a) => { a.tenant.ingestUrl = 'https://user:pass@demo.example'; }],
]) {
  test(`refuses ${name} before any side effect`, async () => {
    const value = authority(); modify(value);
    let effects = 0;
    const guard = createDemoGuard({ pins, readAuthority: async () => value });
    await assert.rejects(guard.mutate(pins, () => effects++), /Demo mutation refused/);
    assert.equal(effects, 0);
  });
}

test('pins reject wrong org, origin and repository before authority or side effects', async () => {
  let reads = 0; let effects = 0;
  const guard = createDemoGuard({ pins, readAuthority: async () => { reads++; return authority(); } });
  for (const target of [{ ...pins, organizationId: 'org_other' }, { ...pins, onepatchOrigin: 'https://app.onepatch.dev' }, { ...pins, githubRepository: '1patch/onep-internal' }]) {
    await assert.rejects(guard.mutate(target, () => effects++));
  }
  assert.equal(reads, 0); assert.equal(effects, 0);
});

test('protected orgs cannot be pinned even if labeled demo', () => {
  for (const organizationId of PROTECTED_ORGANIZATIONS) {
    assert.throws(() => createDemoGuard({ pins: { ...pins, organizationId }, readAuthority: async () => authority() }), /protected/);
  }
});

test('every mutation revalidates authority and cannot reuse prior success', async () => {
  let reads = 0; let effects = 0;
  const guard = createDemoGuard({ pins, readAuthority: async () => {
    const value = authority(); if (++reads > 1) value.organization.metadata.demo_instance = 'false'; return value;
  } });
  await guard.mutate(pins, (binding) => { effects++; assert.equal(binding.ingestToken, token); assert.equal(binding.ingestUrl, authority().tenant.ingestUrl); assert.ok(Object.isFrozen(binding)); });
  await assert.rejects(guard.mutate(pins, () => effects++));
  assert.equal(reads, 2); assert.equal(effects, 1);
});

test('stale authority and authority errors refuse with zero effects', async () => {
  let clock = 0; let effects = 0;
  const stale = createDemoGuard({ pins, now: () => clock, readAuthority: async () => { clock = 5001; return authority(); } });
  await assert.rejects(stale.mutate(pins, () => effects++), /stale/);
  const failed = createDemoGuard({ pins, readAuthority: async () => { throw new Error('private-secret'); } });
  await assert.rejects(failed.mutate(pins, () => effects++), (error) => !error.message.includes('private-secret'));
  assert.equal(effects, 0);
});

test('local config cannot inject a demo marker, token or ingest endpoint', async () => {
  const guard = createDemoGuard({ pins, readAuthority: async () => authority() });
  await guard.mutate({ ...pins, demo_instance: 'true', ingestUrl: 'http://localhost:4318', ingestToken: 'op_wrong' }, (binding) => {
    assert.equal(binding.ingestUrl, authority().tenant.ingestUrl); assert.equal(binding.ingestToken, token); assert.equal(binding.demo_instance, undefined);
  });
});

test('WorkOS reader uses fresh fixed-origin GET and registry lookup for every call', async () => {
  let reads = 0; let registryReads = 0;
  const reader = createWorkosAuthorityReader({ apiKey: 'private-secret', onepatchOrigin: pins.onepatchOrigin,
    fetchImpl: async (url, options) => { reads++; assert.equal(url, `https://api.workos.com/organizations/${pins.organizationId}`); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); return { ok: true, json: async () => authority().organization }; },
    readTenantRecord: async (id) => { registryReads++; assert.equal(id, pins.organizationId); return authority().tenant; },
  });
  assert.deepEqual(await reader(pins.organizationId), authority()); await reader(pins.organizationId);
  assert.equal(reads, 2); assert.equal(registryReads, 2);
});

test('WorkOS reader never relabels an existing org and hides error contents', async () => {
  let registryReads = 0;
  const reader = createWorkosAuthorityReader({ apiKey: 'private-secret', onepatchOrigin: pins.onepatchOrigin,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: pins.organizationId, metadata: {} }) }),
    readTenantRecord: async () => { registryReads++; return authority().tenant; },
  });
  await assert.rejects(reader(pins.organizationId), /not the pinned demo/); assert.equal(registryReads, 0);
  const failed = createWorkosAuthorityReader({ apiKey: 'private-secret', onepatchOrigin: pins.onepatchOrigin,
    fetchImpl: async () => { throw new Error('private-secret'); }, readTenantRecord: async () => null,
  });
  await assert.rejects(failed(pins.organizationId), (error) => !error.message.includes('private-secret'));
});
