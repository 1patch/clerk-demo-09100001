import test from 'node:test';
import assert from 'node:assert/strict';
import { startServers } from '../sut/server.mjs';
import { profileForSample, outcomeForSample } from '../sut/telemetry.mjs';
import { readFile } from 'node:fs/promises';

test('callback honors the committed verifier policy and emits connected spans', async () => {
  const release = JSON.parse(await readFile(new URL('../sut/release.json', import.meta.url), 'utf8'));
  const sha = 'a'.repeat(40), telemetry = [];
  const servers = await startServers({port:0, verifierPort:0, hostname:'127.0.0.1', releaseSha:sha, onTelemetry:value=>telemetry.push(value)});
  try {
    const origin = `http://127.0.0.1:${servers.port}`;
    const health = await (await fetch(origin+'/health')).json();
    assert.equal(health.version,sha);
    for(const sampleIndex of [0,11,12]) {
      const response = await fetch(origin+'/oauth/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sampleIndex,runId:'unit'})});
      const body = await response.json(), expected = outcomeForSample(sampleIndex,release);
      assert.equal(response.status,expected.statusCode);
      assert.equal(body.error??null,expected.error);
      const spans=telemetry.at(-1).resourceSpans.flatMap(r=>r.scopeSpans.flatMap(s=>s.spans));
      const root=spans.find(s=>!s.parentSpanId);
      assert.equal(root.traceId,body.traceId);
      assert.equal(spans.some(s=>s.name==='session.persist'),!expected.error);
      assert.ok(profileForSample(sampleIndex).verifierLatencyMs>0);
    }
    assert.equal((await fetch(origin+'/oauth/callback',{method:'POST',body:'{bad'})).status,400);
  } finally { await servers.close(); }
});
