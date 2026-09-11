import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildOperationalTelemetry, buildRequestTelemetry, profileForSample, spanIdFor } from './telemetry.mjs';
import { createOtlpExporter } from './exporter.mjs';

const defaultReleasePath = new URL('./release.json', import.meta.url);
// Unmatched requests carry no route template; a sentinel keeps http.route bounded
// while url.path keeps the actual target for debugging.
const UNMATCHED_ROUTE = '/*';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 4096) throw new Error('Request body exceeds 4096 bytes');
  }
  return JSON.parse(value || '{}');
}
function validateInput(input) {
  profileForSample(input.sampleIndex);
  if (typeof input.runId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.runId)) throw new Error('runId must be 1–100 letters, numbers, dots, underscores or hyphens');
}
function validateRelease(release) {
  if (!['baseline', 'regression', 'fix'].includes(release.phase) || !Number.isSafeInteger(release.timeoutMs) || release.timeoutMs < 1 || release.timeoutMs > 5000 || typeof release.fallbackOnTimeout !== 'boolean') throw new Error('Invalid release configuration');
  return release;
}
const listen = (server, port, hostname) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, hostname, () => { server.removeListener('error', reject); resolve(); });
});
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });

export async function startServers({ port = 8080, verifierPort = 8081, hostname = '0.0.0.0', releasePath = defaultReleasePath, releaseSha, runId, onTelemetry } = {}) {
  releaseSha ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error('A full git HEAD SHA is required');
  // Bind release behavior and identity together for the lifetime of this process.
  const release = validateRelease(JSON.parse(await readFile(releasePath, 'utf8')));
  // Probes, 404s and 400s answer before any sampleIndex/runId exists, so they are
  // attributed to one run id for the lifetime of the process.
  const processRunId = runId ?? process.env.DEMO_RUN_ID ?? `live-${randomBytes(6).toString('hex')}`;
  // Emitting must never break a response: build the span after replying, swallow failures.
  const emit = ({ serviceName, req, route, statusCode, error, startTimeMs }) => {
    if (!onTelemetry) return;
    try {
      onTelemetry(buildOperationalTelemetry({
        serviceName, release, releaseSha, runId: processRunId,
        name: `${req.method} ${route}`, startTimeMs, endTimeMs: Date.now(),
        attributes: { 'http.request.method': req.method, 'http.route': route, 'url.path': req.url, 'http.response.status_code': statusCode },
        error,
      }));
    } catch { /* telemetry is best effort; the client already has its response */ }
  };
  const verifier = createServer(async (req, res) => {
    const startTimeMs = Date.now();
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { status: 'ok', service: 'ip-verifier', version: releaseSha, releaseSha });
      return emit({ serviceName: 'ip-verifier', req, route: '/health', statusCode: 200, startTimeMs });
    }
    if (req.url !== '/verify' || req.method !== 'POST') {
      json(res, 404, { error: 'NOT_FOUND' });
      return emit({ serviceName: 'ip-verifier', req, route: UNMATCHED_ROUTE, statusCode: 404, error: 'NOT_FOUND', startTimeMs });
    }
    try {
      const input = await body(req);
      validateInput(input);
      const profile = profileForSample(input.sampleIndex);
      const timer = setTimeout(() => json(res, profile.verifierFails ? 503 : 200, { verified: !profile.verifierFails, latencyMs: profile.verifierLatencyMs }), profile.verifierLatencyMs);
      res.once('close', () => clearTimeout(timer));
    } catch (error) {
      // A caller that already hung up has no known status; leave it unset, as with timeouts.
      const responded = !res.destroyed;
      if (responded) json(res, 400, { error: error.message });
      emit({ serviceName: 'ip-verifier', req, route: '/verify', statusCode: responded ? 400 : undefined, error: responded ? 'INVALID_REQUEST' : 'CLIENT_CANCELLED', startTimeMs });
    }
  });
  await listen(verifier, verifierPort, '127.0.0.1');
  const actualVerifierPort = verifier.address().port;
  const sessions = new Map();
  const auth = createServer(async (req, res) => {
    const startTimeMs = Date.now();
    if (req.method === 'GET' && ['/health', '/version'].includes(req.url)) {
      json(res, 200, { status: 'ok', service: 'auth-service', version: releaseSha, releaseSha, ...release });
      return emit({ serviceName: 'auth-service', req, route: req.url, statusCode: 200, startTimeMs });
    }
    if (req.method !== 'POST' || req.url !== '/oauth/callback') {
      json(res, 404, { error: 'NOT_FOUND' });
      return emit({ serviceName: 'auth-service', req, route: UNMATCHED_ROUTE, statusCode: 404, error: 'NOT_FOUND', startTimeMs });
    }
    let input;
    try { input = await body(req); validateInput(input); } catch (error) {
      json(res, 400, { error: error.message });
      return emit({ serviceName: 'auth-service', req, route: '/oauth/callback', statusCode: 400, error: 'INVALID_REQUEST', startTimeMs });
    }
    const started = startTimeMs;
    const traceId = randomBytes(16).toString('hex');
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, release.timeoutMs);
    let error = null;
    let fallbackUsed = false;
    const verifyStartTimeMs = Date.now();
    let verifyEndTimeMs;
    try {
      const response = await fetch(`http://127.0.0.1:${actualVerifierPort}/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json', traceparent: `00-${traceId}-${spanIdFor(traceId, 'ip_verifier.verify')}-01` },
        body: JSON.stringify(input), signal: abort.signal,
      });
      await response.json();
      if (!response.ok) error = 'IP_VERIFIER_UNAVAILABLE';
    } catch {
      if (timedOut && release.fallbackOnTimeout) fallbackUsed = true;
      else error = timedOut ? 'IP_VERIFIER_TIMEOUT' : 'IP_VERIFIER_UNAVAILABLE';
    } finally { clearTimeout(timer); verifyEndTimeMs = Date.now(); }
    const sessionId = error ? undefined : `demo-${traceId.slice(0, 12)}`;
    if (sessionId) {
      sessions.set(sessionId, { createdAt: Date.now(), runId: input.runId });
      if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    }
    const telemetry = buildRequestTelemetry({ sampleIndex: input.sampleIndex, release, releaseSha, runId: input.runId, startTimeMs: started, measuredDurationMs: Date.now() - started, verifyStartTimeMs, verifyEndTimeMs, observedOutcome: { error, fallbackUsed, timedOut, statusCode: error ? 503 : 200 }, source: 'live-request', traceId });
    onTelemetry?.(telemetry);
    // Ephemeral session is sufficient for this synthetic callback; no user data or credentials.
    json(res, error ? 503 : 200, { ok: !error, ...(error ? { error } : { sessionId }), fallbackUsed, traceId, releaseSha, phase: release.phase });
  });
  try { await listen(auth, port, hostname); } catch (error) { await close(verifier); throw error; }
  return { authServer: auth, verifierServer: verifier, port: auth.address().port, verifierPort: actualVerifierPort, close: async () => { await close(auth); await close(verifier); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Until this exporter existed the entrypoint passed no onTelemetry, so every span
  // the request pipeline built was discarded and only seeded data reached OnePatch.
  const exporter = createOtlpExporter();
  const servers = await startServers({ port: Number(process.env.PORT ?? 8080), verifierPort: Number(process.env.VERIFIER_PORT ?? 8081), onTelemetry: exporter });
  console.log(JSON.stringify({ message: 'Synthetic auth system ready', port: servers.port, verifierPort: servers.verifierPort }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await servers.close(); await exporter.shutdown(); process.exit(0); });
}
