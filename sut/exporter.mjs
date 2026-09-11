// OTLP/JSON span exporter for the production entrypoint. The request pipeline in
// server.mjs has always built spans; without this they were handed to nobody.
// Deliberately dependency-free: global fetch, a bounded queue, fire-and-forget.

// Write-only ingest pair, the same shape as a Sentry DSN: it can push spans into
// this demo's OnePatch project and read nothing back. Committed in the clear on
// purpose so a checkout exports without extra setup; the env vars only override.
const DEFAULT_ENDPOINT = 'https://clerk-demo-09-10.logger.onepatch.dev/v1/traces';
const DEFAULT_TOKEN = 'op_VFpsjs6Aak4UJkFW1c7cL2mLOl4b_TwiAta23NcFG04';

export function createOtlpExporter({
  endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEFAULT_ENDPOINT,
  token = process.env.ONEPATCH_INGEST_TOKEN ?? DEFAULT_TOKEN,
  // A batch every 200ms keeps request handlers free of network work; the queue cap
  // bounds memory if the collector is unreachable, dropping oldest-first.
  batchDelayMs = 200, maxQueuedPayloads = 256, timeoutMs = 2000,
  onError = (error) => console.warn(JSON.stringify({ message: 'span export failed', error: String(error?.message ?? error) })),
} = {}) {
  const queue = [];
  let timer = null;
  let inFlight = Promise.resolve();

  const send = (resourceSpans) => {
    const attempt = fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceSpans }),
      signal: AbortSignal.timeout(timeoutMs),
    }).then((response) => { if (!response.ok) onError(new Error(`ingest responded ${response.status}`)); }, onError);
    inFlight = inFlight.then(() => attempt);
    return attempt;
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (queue.length === 0) return inFlight;
    const resourceSpans = queue.splice(0, queue.length).flatMap((payload) => payload.resourceSpans ?? []);
    return resourceSpans.length ? send(resourceSpans) : inFlight;
  };

  // The exported value is the onTelemetry callback itself: never throws, never awaits.
  const exporter = (payload) => {
    try {
      if (!payload?.resourceSpans?.length) return;
      if (queue.length >= maxQueuedPayloads) queue.shift();
      queue.push(payload);
      if (!timer) { timer = setTimeout(flush, batchDelayMs); timer.unref?.(); }
    } catch (error) { onError(error); }
  };
  exporter.flush = flush;
  exporter.shutdown = async () => { try { await flush(); await inFlight; } catch (error) { onError(error); } };
  return exporter;
}
