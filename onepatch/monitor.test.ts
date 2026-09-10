import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import monitor from './workspace/monitors/post-deploy-regression.monitor';
import { buildHistoricalTelemetry } from '../sut/telemetry.mjs';

const BASE = 'a'.repeat(40), BAD = 'b'.repeat(40), FIX = 'c'.repeat(40), RESET = 'd'.repeat(40);
const T = 1788970000; // real-size Unix seconds; clock and telemetry are deterministic.
const attrs = (entries: Array<{key: string; value: Record<string, unknown>}>) =>
  Object.fromEntries(entries.map(({ key, value }) => [key, Object.values(value)[0]]));
// Native ClickHouse JSON serializes dotted OTLP attribute paths as nested
// objects. A literal JSONExtractString(..., 'demo.run_id') cannot read them;
// direct attrs.`demo.run_id` addresses the JSON subcolumn instead.
function serializeNativeJson(flat: Record<string, unknown>): string {
  const nested: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let target = nested;
    for (const part of parts.slice(0, -1)) {
      target = (target[part] ??= {}) as Record<string, unknown>;
    }
    target[parts.at(-1)!] = value;
  }
  return JSON.stringify(nested);
}
const subcolumnPath = (key: string) => '$.' + key.split('.').map(part => '"' + part + '"').join('.');
const closeables: Database[] = [];
afterEach(() => { for (const db of closeables.splice(0)) db.close(); });

// Execute the monitor's actual SELECTs against SQLite. Only ClickHouse scalar
// syntax is adapted; WHERE, boundaries, grouping and count predicates execute
// in the SQL engine, rather than a mock returning hand-selected count rows.
function harness(now = T + 30) {
  const db = new Database(':memory:'); closeables.push(db);
  db.exec("ATTACH DATABASE ':memory:' AS otel");
  db.exec('CREATE TABLE otel.spans(start_ts REAL, service_name TEXT, kind INTEGER, status_code INTEGER, onepatch_source TEXT, env TEXT, attrs TEXT, resource_attrs TEXT)');
  db.exec('CREATE TABLE otel.logs(ts REAL, service_name TEXT, onepatch_source TEXT, attrs TEXT)');
  const queries: string[] = [];
  function calls(source: string): string {
    const pattern = /\b(now|toDateTime|toUnixTimestamp|toString|toJSONString|JSONExtractString|multiIf|countIf)\(/g;
    let output = '', cursor = 0, match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      output += source.slice(cursor, match.index);
      const name = match[1];
      let i = pattern.lastIndex, depth = 1, quoted = false, start = i;
      const args: string[] = [];
      for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === "'") { quoted = !quoted; continue; }
        if (quoted) continue;
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if ((ch === ',' && depth === 1) || depth === 0) {
          args.push(calls(source.slice(start, i).trim())); start = i + 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new Error('Unbalanced SQL function');
      let replacement: string;
      switch (name) {
        case 'now': replacement = String(now); break;
        case 'toDateTime': replacement = args[0]; break;
        case 'toUnixTimestamp': replacement = `CAST(${args[0]} AS INTEGER)`; break;
        case 'toString': replacement = `CAST(${args[0]} AS TEXT)`; break;
        case 'toJSONString': replacement = args[0]; break;
        case 'JSONExtractString': replacement = `COALESCE(json_extract(${args[0]}, '$."${args[1].slice(1, -1)}"'), '')`; break;
        case 'countIf': replacement = `SUM(CASE WHEN ${args[0]} THEN 1 ELSE 0 END)`; break;
        case 'multiIf': replacement = 'CASE ' + args.slice(0, -1).reduce((text, value, index) => text + (index % 2 ? ` THEN ${value} ` : `WHEN ${value}`), '') + `ELSE ${args.at(-1)} END`; break;
        default: throw new Error('Unknown scalar');
      }
      output += replacement; cursor = i + 1; pattern.lastIndex = cursor;
    }
    return output + source.slice(cursor);
  }
  const sql = (source: string) => calls(source
    .replace(/(resource_attrs|attrs)\.\`([^`]+)\`/g, (_, column, key) => `json_extract(${column}, '${subcolumnPath(key)}')`)
    .replace(/INTERVAL (\d+) MINUTE/g, '($1 * 60)'));
  const ctx = {
    memo: {},
    deployTargets: { configured: true, errors: [], targets: [{
      name: 'clerk-demo', repo: '1patch/clerk-demo-09100001', service: '', env: 'demo', paths: [],
      where: "toString(attrs.`cicd.trigger`) = 'deployment_status' AND toString(attrs.`cicd.environment`) = 'demo' AND toString(attrs.`cicd.repo`) = '1patch/clerk-demo-09100001'",
    }] },
    queryOtel: async (query: string) => { queries.push(query); return db.query(sql(query)).all() as Array<Record<string, unknown>>; },
  };
  return {
    db, queries, setNow(value: number) { now = value; },
    deploy(sha: string, at: number, environment = 'demo') {
      db.query('INSERT INTO otel.logs VALUES (?, ?, ?, ?)').run(at, '1patch/clerk-demo-09100001', 'cicd', serializeNativeJson({
        'cicd.repo': '1patch/clerk-demo-09100001', 'cicd.trigger': 'deployment_status', 'cicd.environment': environment,
        'cicd.sha': sha, 'cicd.sha_short': sha.slice(0, 7), 'cicd.status': 'success', 'cicd.run_url': 'https://github.com/1patch/clerk-demo-09100001/deployments',
      }));
    },
    population(phase: string, sha: string, runId: string, start: number, intervalSeconds: number, count = 1000) {
      const payload = buildHistoricalTelemetry({ phase, releaseSha: sha, runId, startTimeMs: start * 1000, sampleCount: count, intervalMs: intervalSeconds * 1000 });
      const insert = db.query('INSERT INTO otel.spans VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      db.transaction(() => {
        for (const resource of payload.resourceSpans) {
          const ra = attrs(resource.resource.attributes);
          for (const group of resource.scopeSpans) for (const span of group.spans) {
            insert.run(Number(BigInt(span.startTimeUnixNano)) / 1e9, String(ra['service.name']), span.kind, span.status.code, String(ra['onepatch.source'] ?? ''), String(ra['deployment.environment.name'] ?? ''), serializeNativeJson(attrs(span.attributes)), serializeNativeJson(ra));
          }
        }
      })();
    },
    async evaluate() {
      const clock = spyOn(Date, 'now').mockReturnValue(now * 1000);
      try { return await monitor.evaluate(ctx as never); } finally { clock.mockRestore(); }
    },
  };
}

describe('Clerk demo deployment monitor with complete OTLP populations', () => {
  test('baseline requires traffic on both sides; two complete baseline batches establish .4% healthy', async () => {
    const h = harness(); h.deploy(BASE, T);
    h.population('baseline', BASE, 'run-a', T - 300, .299);
    const missing = await h.evaluate();
    expect(missing.state).toBe('unknown');
    expect(missing.reason).toContain('current demo deployment');
    h.population('baseline', BASE, 'run-a', T + 1, .02);
    const healthy = await h.evaluate();
    expect(healthy.state).toBe('healthy');
    expect(healthy.attrs).toMatchObject({ before_spans: 1000, after_spans: 1000, before_error_pct: .4, after_error_pct: .4, demo_run_id: 'run-a' });
  });

  test('real bad deployment fires at 18.7%, and fix deployment alone cannot falsely recover', async () => {
    const h = harness(T + 90); h.deploy(BASE, T - 600);
    h.population('baseline', BASE, 'run-a', T - 300, .299);
    h.deploy(BAD, T); h.population('regression', BAD, 'run-a', T + 1, .05);
    const firing = await h.evaluate();
    expect(firing.state).toBe('firing');
    expect(firing.attrs).toMatchObject({ before_spans: 1000, after_spans: 1000, before_error_pct: .4, after_error_pct: 18.7 });
    h.deploy(FIX, T + 60);
    expect((await h.evaluate()).state).toBe('unknown');
    h.population('fix', FIX, 'run-a', T + 61, .02, 100);
    const partial = await h.evaluate();
    expect(partial.state).toBe('unknown');
    expect(partial.reason).toContain('window is still arriving');
    h.db.exec(`DELETE FROM otel.spans WHERE start_ts >= ${T + 60}`);
    h.population('fix', FIX, 'run-a', T + 61, .02);
    const recovered = await h.evaluate();
    expect(recovered.state).toBe('healthy');
    expect(recovered.attrs).toMatchObject({ before_spans: 2000, after_spans: 1000, before_error_pct: 9.55, after_error_pct: .4 });
  });

  test('new reset run excludes old rehearsal and later-arriving old SHA telemetry', async () => {
    const h = harness(T + 90); h.deploy(RESET, T);
    h.population('regression', BAD, 'old-run', T - 300, .4);
    h.population('baseline', RESET, 'new-run', T - 300, .299);
    h.population('baseline', RESET, 'new-run', T + 1, .02);
    // Arrives late, with later event times too: exact deployed SHA still isolates it.
    h.population('regression', BAD, 'old-run', T + 30, .04);
    const reset = await h.evaluate();
    expect(reset.state).toBe('healthy');
    expect(reset.attrs).toMatchObject({ demo_run_id: 'new-run', before_spans: 1000, after_spans: 1000, before_error_pct: .4, after_error_pct: .4 });
  });

  test('future spans and wrong environment cannot supply readiness for a deployment', async () => {
    const h = harness(); h.deploy(BASE, T);
    h.population('baseline', BASE, 'run-a', T - 300, .299);
    h.population('baseline', BASE, 'run-a', T + 60, .02);
    expect((await h.evaluate()).state).toBe('unknown');
    h.population('baseline', BASE, 'run-a', T + 1, .02);
    h.db.exec("UPDATE otel.spans SET env = 'production' WHERE start_ts >= " + T + ' AND start_ts <= ' + (T + 30));
    expect((await h.evaluate()).state).toBe('unknown');
  });

  test('OTLP maps env and version from resource attributes and run ID from span attributes', async () => {
    const h = harness(); h.deploy(BASE, T);
    h.population('baseline', BASE, 'run-a', T - 300, .299);
    h.population('baseline', BASE, 'run-a', T + 1, .02);
    const raw = h.db.query('SELECT DISTINCT service_name, env, onepatch_source, json_extract(resource_attrs, \'$.service.version\') AS version, json_extract(attrs, \'$.demo.run_id\') AS run FROM otel.spans').all();
    expect(raw).toHaveLength(2);
    for (const row of raw) expect(row).toMatchObject({ env: 'demo', onepatch_source: '', version: BASE, run: 'run-a' });
    // The old serialized-JSON filter sees no literal dotted key, even though
    // the direct native subcolumn above correctly finds the scenario.
    const serialized = h.db.query("SELECT DISTINCT COALESCE(json_extract(attrs, '$.\"demo.run_id\"'), '') AS old_run FROM otel.spans").all();
    expect(serialized).toEqual([{ old_run: '' }]);
    const result = await h.evaluate();
    expect(result.attrs?.after_spans).toBe(1000); // Not 2,000 server spans across two services.
    expect(h.queries).toHaveLength(3);
  });
});
