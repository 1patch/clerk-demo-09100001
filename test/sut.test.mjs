import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServers } from '../sut/server.mjs';
import { RELEASES, profileForSample, outcomeForSample, buildHistoricalTelemetry } from '../sut/telemetry.mjs';

const SHA = 'a'.repeat(40);
const attribute = (span, key) => span.attributes.find((a) => a.key === key)?.value;
const spans = (payload) => payload.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
const slowIndex = Array.from({ length: 1000 }, (_, i) => i).find((i) => profileForSample(i).cohort === 'enterprise');
const fastIndex = Array.from({ length: 1000 }, (_, i) => i).find((i) => !profileForSample(i).verifierFails && profileForSample(i).cohort === 'standard');

test('the same deterministic population produces 0.4%, 18.7%, and 0.4% failure rates', () => {
  for (const [phase, expected] of [['baseline', 4], ['regression', 187], ['fix', 4]]) {
    const outcomes = Array.from({ length: 1000 }, (_, i) => outcomeForSample(i, RELEASES[phase]));
    assert.equal(outcomes.filter((o) => o.error).length, expected);
  }
  const latency = Array.from({ length: 1000 }, (_, i) => profileForSample(i).verifierLatencyMs).sort((a, b) => a - b);
  assert.ok(latency[949] > 150 && latency[949] < 250);
});

test('historical traces connect two services, preserve git revision, and omit persistence on failures', () => {
  const payload = buildHistoricalTelemetry({ phase: 'regression', releaseSha: SHA, runId: 'test-history', startTimeMs: 1700000000000 });
  assert.equal(payload.resourceSpans.length, 2);
  for (const resource of payload.resourceSpans) assert.equal(attribute(resource.resource, 'service.version').stringValue, SHA);
  const all = spans(payload);
  const roots = all.filter((s) => !s.parentSpanId);
  assert.equal(roots.length, 1000);
  assert.equal(roots.filter((s) => s.status.code === 2).length, 187);
  for (const root of roots) {
    const trace = all.filter((s) => s.traceId === root.traceId);
    const byName = Object.fromEntries(trace.map((s) => [s.name, s]));
    assert.equal(byName['request.verify'].parentSpanId, root.spanId);
    assert.equal(byName['ip_verifier.verify'].parentSpanId, byName['request.verify'].spanId);
    assert.equal(byName['POST /verify'].parentSpanId, byName['ip_verifier.verify'].spanId);
    assert.equal(Boolean(byName['session.persist']), root.status.code === 1);
    for (const span of trace) assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
  }
  assert.throws(() => buildHistoricalTelemetry({ phase: 'fix', releaseSha: 'short', runId: 'test', startTimeMs: 0 }), /full 40/);
});

test('real callback preserves a slow healthy login, fails after timeout regression, and recovers with fix', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clerk-demo-sut-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const phase of ['baseline', 'regression', 'fix']) {
    const releasePath = join(directory, `${phase}.json`);
    await writeFile(releasePath, JSON.stringify(RELEASES[phase]));
    const telemetry = [];
    const servers = await startServers({ port: 0, verifierPort: 0, hostname: '127.0.0.1', releasePath, releaseSha: SHA, onTelemetry: (value) => telemetry.push(value) });
    try {
      const endpoint = `http://127.0.0.1:${servers.port}`;
      const health = await (await fetch(`${endpoint}/health`)).json();
      assert.equal(health.phase, phase);
      assert.equal(health.releaseSha, SHA);
      for (const sampleIndex of [slowIndex, fastIndex, 0]) {
        const response = await fetch(`${endpoint}/oauth/callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sampleIndex, runId: 'test-live' }) });
        const value = await response.json();
        const expected = outcomeForSample(sampleIndex, RELEASES[phase]);
        assert.equal(response.status, expected.statusCode);
        assert.equal(value.error ?? null, expected.error);
        assert.equal(value.telemetry, undefined);
        const trace = spans(telemetry.at(-1));
        const root = trace.find((s) => !s.parentSpanId);
        assert.equal(root.traceId, value.traceId);
        assert.equal(root.status.code, expected.error ? 2 : 1);
        assert.equal(attribute(root, 'demo.source').stringValue, 'live-request');
        assert.equal(trace.some((s) => s.name === 'session.persist'), !expected.error);
      }
      assert.equal((await fetch(`${endpoint}/reset`, { method: 'POST' })).status, 404);
      assert.equal((await fetch(`${endpoint}/oauth/callback`, { method: 'POST', body: '{bad' })).status, 400);
    } finally { await servers.close(); }
  }
});
