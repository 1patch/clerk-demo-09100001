import { createHash } from 'node:crypto';

export const PROTECTED_ORGANIZATIONS = Object.freeze([
  'org_01KVBJDE06AVKAPTXGRM8VCASQ',
  'org_01KV7G5DH6QS1NW6RYJ6ZY8GWJ',
]);

export class DemoGuardError extends Error {
  constructor(message) {
    super(`Demo mutation refused: ${message}`);
    this.name = 'DemoGuardError';
  }
}

function refuse(message) { throw new DemoGuardError(message); }

function httpsOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { refuse(`${label} must be an HTTPS origin`); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' ||
      value !== url.origin) refuse(`${label} must be an exact HTTPS origin without a path`);
  return url.origin;
}

function validateTarget(target) {
  if (!target || typeof target.organizationId !== 'string' ||
      !/^org_[A-Za-z0-9]+$/.test(target.organizationId)) refuse('an exact organization ID is required');
  if (PROTECTED_ORGANIZATIONS.includes(target.organizationId)) refuse('protected organization');
  httpsOrigin(target.onepatchOrigin, 'OnePatch origin');
  if (typeof target.githubRepository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.githubRepository)) {
    refuse('an exact GitHub owner/repository is required');
  }
}

function verifiedBinding(pins, authority) {
  const organization = authority?.organization;
  const tenant = authority?.tenant;
  if (authority?.onepatchOrigin !== pins.onepatchOrigin) refuse('authority origin does not match pinned origin');
  if (organization?.id !== pins.organizationId) refuse('authoritative organization ID mismatch');
  if (organization.metadata?.demo_instance !== 'true') refuse('organization is not authoritatively marked as a demo');
  let repos;
  try { repos = JSON.parse(organization.metadata.github_repos); } catch { refuse('missing or malformed authoritative repository binding'); }
  if (!Array.isArray(repos) || !repos.every((repo) => typeof repo === 'string') ||
      !repos.includes(pins.githubRepository)) refuse('repository is not connected to the demo organization');
  if (tenant?.orgId !== pins.organizationId) refuse('tenant registry organization ID mismatch');
  if (tenant.status !== 'active') refuse('tenant registry is not active');
  if (tenant.dataLayerMode && tenant.dataLayerMode !== 'hosted') refuse('this demo supports hosted telemetry only');
  const ingestUrl = httpsOrigin(tenant.ingestUrl, 'Registry ingest URL');
  const ingestToken = organization.metadata.otel_ingest_token;
  if (typeof ingestToken !== 'string' || !/^op_[A-Za-z0-9_-]+$/.test(ingestToken)) refuse('missing authoritative ingest token');
  const hash = createHash('sha256').update(ingestToken).digest('hex');
  if (tenant.chIngestTokenSha256 !== hash) refuse('ingest token is not bound to this tenant registry row');
  // Only registry/WorkOS values reach the mutation. No config-supplied ingest
  // endpoint, token, local-env override, demo marker, or cached permission.
  return Object.freeze({ ...pins, ingestUrl, ingestToken });
}

/**
 * Guard one side effect at a time, immediately before it happens. Call mutate
 * again for every GitHub write, deployment, ingest batch, and agent command.
 * readAuthority is a trusted, fresh reader, never caller-supplied JSON/config.
 * It must bind its registry environment to the configured OnePatch origin.
 * This is an accident-prevention boundary, not a sandbox for callback code.
 */
export function createDemoGuard({ pins, readAuthority, now = Date.now, maxReadAgeMs = 5000 }) {
  validateTarget(pins);
  const pinned = Object.freeze({
    organizationId: pins.organizationId,
    onepatchOrigin: pins.onepatchOrigin,
    githubRepository: pins.githubRepository,
  });
  if (typeof readAuthority !== 'function') refuse('fresh authority reader is required');
  if (!Number.isFinite(maxReadAgeMs) || maxReadAgeMs < 1 || maxReadAgeMs > 5000) refuse('invalid authority freshness limit');
  return Object.freeze({
    async mutate(target, effect) {
      validateTarget(target);
      for (const field of Object.keys(pinned)) {
        if (target[field] !== pinned[field]) refuse(`target ${field} does not match its pin`);
      }
      if (typeof effect !== 'function') refuse('mutation callback is required');
      const started = now();
      let authority;
      try { authority = await readAuthority(pinned.organizationId); }
      catch { refuse('fresh authority lookup failed'); }
      const elapsed = now() - started;
      if (elapsed < 0 || elapsed > maxReadAgeMs) refuse('authority lookup is stale; retry with a fresh lookup');
      const binding = verifiedBinding(pinned, authority);
      return effect(binding);
    },
  });
}

/** GET-only WorkOS reader. readTenantRecord must issue a fresh, strongly
 * consistent registry read and return the decoded row (not an AWS envelope).
 * The caller explicitly binds AWS account/table and OnePatch environment.
 * No API key or response body is included in errors or logs.
 */
export function createWorkosAuthorityReader({ apiKey, onepatchOrigin, readTenantRecord, fetchImpl = fetch }) {
  httpsOrigin(onepatchOrigin, 'Authority OnePatch origin');
  if (typeof apiKey !== 'string' || !apiKey.trim()) refuse('laptop WORKOS_API_KEY is required');
  if (typeof readTenantRecord !== 'function') refuse('fresh tenant registry reader is required');
  return async (organizationId) => {
    if (!/^org_[A-Za-z0-9]+$/.test(organizationId) || PROTECTED_ORGANIZATIONS.includes(organizationId)) refuse('invalid or protected authority target');
    let response;
    try {
      response = await fetchImpl(`https://api.workos.com/organizations/${encodeURIComponent(organizationId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'cache-control': 'no-cache' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
    } catch { refuse('WorkOS organization lookup failed'); }
    if (!response.ok) refuse('WorkOS organization lookup was not successful');
    let organization;
    try { organization = await response.json(); } catch { refuse('WorkOS organization response was invalid'); }
    if (organization?.id !== organizationId || organization?.metadata?.demo_instance !== 'true') {
      refuse('WorkOS organization is not the pinned demo');
    }
    let tenant;
    try { tenant = await readTenantRecord(organizationId); } catch { refuse('tenant registry lookup failed'); }
    return { onepatchOrigin, organization, tenant };
  };
}
