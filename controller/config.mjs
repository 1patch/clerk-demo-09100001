import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDemoGuard, createWorkosAuthorityReader } from './guard.mjs';

const environments = {
  'https://app.staging.onepatch.dev': { account: '017535066453', table: 'onepatch-staging-tenant-registry' },
  'https://app.onepatch.dev': { account: '012751250431', table: 'onepatch-prod-tenant-registry' },
};
export function validateConfig(config) {
  const environment = environments[config.onepatchOrigin];
  if (!environment || config.tenantRegistryTable !== environment.table || config.awsRegion !== 'us-east-1')
    throw new Error('OnePatch origin must match its canonical tenant registry and us-east-1 region');
  if (config.githubRepository !== '1patch/clerk-demo-09100001') throw new Error('Controller is restricted to 1patch/clerk-demo-09100001');
  if (!/^[A-Za-z0-9_-]+$/.test(config.awsProfile ?? '')) throw new Error('Explicit AWS profile required');
  if (!/^[a-z0-9][a-z0-9-]*\.exe\.xyz$/.test(config.sshHost ?? '') || config.sutOrigin !== `https://${config.sshHost}`)
    throw new Error('Pin the exact demo VM and its matching HTTPS origin');
  return environment;
}
export function loadConfig(path = '.demo/config.json') {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  validateConfig(config);
  return Object.freeze(config);
}
export function createControllerGuard(config, { apiKey = process.env.WORKOS_API_KEY, execute = execFileSync, fetchImpl = fetch } = {}) {
  const environment = validateConfig(config);
  const aws = (args) => JSON.parse(execute('aws', [...args, '--profile', config.awsProfile, '--region', config.awsRegion, '--output', 'json'],
    { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' } }));
  const readTenantRecord = async (organizationId) => {
    if (aws(['sts', 'get-caller-identity']).Account !== environment.account) throw new Error('AWS account mismatch');
    const response = aws(['dynamodb', 'get-item', '--table-name', environment.table, '--consistent-read', '--key', JSON.stringify({ orgId: { S: organizationId } })]);
    return Object.fromEntries(Object.entries(response.Item ?? {}).map(([key, value]) => [key, value.S]));
  };
  const readAuthority = createWorkosAuthorityReader({ apiKey, onepatchOrigin: config.onepatchOrigin, readTenantRecord, fetchImpl });
  return createDemoGuard({ pins: config, readAuthority });
}
