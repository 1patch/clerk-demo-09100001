import { createHash, randomBytes } from 'node:crypto';

// Permutation spreads the fixed population across a run without random drift.
// Every 1,000 requests: four dependency failures, 183 slow successes, 813 fast successes.
export function profileForSample(sampleIndex) {
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) throw new Error('sampleIndex must be a nonnegative integer');
  const bucket = ((sampleIndex % 1000) * 919) % 1000;
  return {
    sampleIndex,
    cohort: bucket >= 4 && bucket < 187 ? 'enterprise' : 'standard',
    verifierLatencyMs: bucket < 4 ? 80 : bucket < 187 ? 201 + (bucket % 50) : 64 + (bucket % 81),
    verifierFails: bucket < 4,
  };
}

export function outcomeForSample(sampleIndex, release) {
  const profile = profileForSample(sampleIndex);
  const timedOut = profile.verifierLatencyMs > release.timeoutMs;
  const fallbackUsed = timedOut && release.fallbackOnTimeout;
  const error = timedOut ? (fallbackUsed ? null : 'IP_VERIFIER_TIMEOUT') : profile.verifierFails ? 'IP_VERIFIER_UNAVAILABLE' : null;
  return { ...profile, timedOut, fallbackUsed, error, statusCode: error ? 503 : 200 };
}

const hash = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length);
export const spanIdFor = (traceId, name) => hash(`${traceId}:${name}`, 16);
const nano = (ms) => String(BigInt(Math.round(ms * 1e6)));
const attribute = (key, value) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) } });
const attrs = (values) => Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => attribute(key, value));

// Shared by every span this module emits, so live traffic and the seeded populations
// stay separable: only seeded spans are demo.synthetic.
const demoCommon = (release, runId, source) => ({
  'demo.scenario': 'clerk-oauth-timeout', 'demo.run_id': runId,
  'demo.phase': release.phase, 'demo.synthetic': source !== 'live-request', 'demo.source': source,
  'demo.representative_sample': source === 'historical',
  'verifier.timeout_ms': release.timeoutMs, 'verifier.fallback_enabled': release.fallbackOnTimeout,
});
const resourceSpansFor = (serviceName, releaseSha, runId, spans) => ({
  resource: { attributes: attrs({ 'service.name': serviceName, 'service.version': releaseSha, 'deployment.environment.name': 'demo', 'demo.run_id': runId }) },
  scopeSpans: [{ scope: { name: 'clerk-demo', version: '1.0.0' }, spans }],
});

export function buildRequestTelemetry({ sampleIndex, release, releaseSha, runId, startTimeMs, measuredDurationMs, verifyStartTimeMs, verifyEndTimeMs, observedOutcome, source = 'historical', traceId: suppliedTraceId }) {
  if (!/^[a-f0-9]{40}$/.test(releaseSha ?? '')) throw new Error('releaseSha must be the full 40-character git SHA');
  if (!runId || !Number.isFinite(startTimeMs)) throw new Error('runId and startTimeMs are required');
  const result = { ...outcomeForSample(sampleIndex, release), ...observedOutcome };
  const traceId = suppliedTraceId ?? hash(`${runId}:${releaseSha}:${sampleIndex}:${startTimeMs}`, 32);
  const id = (name) => spanIdFor(traceId, name);
  const verifierMs = Math.min(result.verifierLatencyMs, release.timeoutMs);
  const requestMs = measuredDurationMs ?? verifierMs + (result.error ? 4 : 8);
  const callStart = verifyStartTimeMs ?? startTimeMs + 1;
  const callEnd = verifyEndTimeMs ?? Math.min(callStart + verifierMs, startTimeMs + requestMs);
  const common = { ...demoCommon(release, runId, source), 'demo.sample_index': sampleIndex, 'customer.cohort': result.cohort };
  const span = (name, parent, kind, start, end, extra = {}, error) => ({
    traceId, spanId: id(name), ...(parent ? { parentSpanId: id(parent) } : {}), name, kind,
    startTimeUnixNano: nano(start), endTimeUnixNano: nano(end),
    attributes: attrs({ ...common, ...extra, ...(error ? { 'error.type': error } : {}) }),
    status: { code: error ? 2 : 1, ...(error ? { message: error } : {}) },
  });
  const authSpans = [
    span('POST /oauth/callback', null, 2, startTimeMs, startTimeMs + requestMs,
      { 'http.request.method': 'POST', 'http.route': '/oauth/callback', 'http.response.status_code': result.statusCode }, result.error),
    span('request.verify', 'POST /oauth/callback', 1, callStart, callEnd,
      { 'verifier.fallback_used': result.fallbackUsed }, result.error),
    span('ip_verifier.verify', 'request.verify', 3, callStart, callEnd,
      { 'server.address': 'ip-verifier', 'http.request.method': 'POST', 'http.route': '/verify', 'http.response.status_code': result.timedOut ? undefined : result.verifierFails ? 503 : 200 },
      result.timedOut ? 'IP_VERIFIER_TIMEOUT' : result.error),
  ];
  if (!result.error) authSpans.push(span('session.persist', 'POST /oauth/callback', 1, callEnd, startTimeMs + requestMs, { 'session.persisted': true }));
  const verifierSpans = [span('POST /verify', 'ip_verifier.verify', 2, callStart, callEnd,
    { 'http.request.method': 'POST', 'http.route': '/verify', 'http.response.status_code': result.timedOut ? undefined : result.verifierFails ? 503 : 200, 'verifier.planned_latency_ms': result.verifierLatencyMs },
    result.timedOut ? 'CLIENT_CANCELLED' : result.error)];
  const resource = (serviceName, spans) => resourceSpansFor(serviceName, releaseSha, runId, spans);
  return { resourceSpans: [resource('auth-service', authSpans), resource('ip-verifier', verifierSpans)] };
}

// Health/version probes, 404s and 400s answer before the callback pipeline above runs,
// so each emits one standalone server span instead of a linked set.
export function buildOperationalTelemetry({ serviceName, name, release, releaseSha, runId, startTimeMs, endTimeMs, attributes = {}, error }) {
  if (!/^[a-f0-9]{40}$/.test(releaseSha ?? '')) throw new Error('releaseSha must be the full 40-character git SHA');
  if (!runId || !Number.isFinite(startTimeMs)) throw new Error('runId and startTimeMs are required');
  const traceId = randomBytes(16).toString('hex');
  const httpStatus = attributes['http.response.status_code'];
  // A client error is not a service failure: keep status code 2 meaning "we broke",
  // and let error.type carry the 4xx detail.
  const failed = Boolean(error) && !(httpStatus >= 400 && httpStatus < 500);
  const span = {
    traceId, spanId: spanIdFor(traceId, name), name, kind: 2,
    startTimeUnixNano: nano(startTimeMs), endTimeUnixNano: nano(endTimeMs ?? startTimeMs),
    attributes: attrs({ ...demoCommon(release, runId, 'live-request'), ...attributes, ...(error ? { 'error.type': error } : {}) }),
    status: { code: failed ? 2 : 1, ...(failed ? { message: error } : {}) },
  };
  return { resourceSpans: [resourceSpansFor(serviceName, releaseSha, runId, [span])] };
}
