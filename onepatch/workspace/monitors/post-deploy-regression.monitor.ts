import type { DeployTarget, Monitor, MonitorAttrs, MonitorResult } from "@1patch/monitor-api";

// The shipped template version this file was instantiated from. The daily
// workspace-freshness routine compares it against the current templates and
// refreshes the kit when it lags — keep the line, verbatim, when tailoring.
// kit-version: 3

// Fires when the application's error rate got materially worse right after a
// SUCCESSFUL deploy shipped.
//
// This is the monitor the whole deploy-event spine exists for. Most production
// failures are correlated with a change, and the change is usually the newest
// one — but a generic error-rate alarm can't say "this started when you shipped
// a1b2c3d", so a human has to go correlate by hand at exactly the moment they
// have the least attention to spare. Because deploys are ordinary telemetry
// here (`onepatch_source = 'cicd'` log records; see `CICD_OTEL_SOURCE` in
// @1patch/protocol), the correlation is just a WHERE clause, and the alert
// arrives already naming the sha to roll back.
//
// Deliberately scoped to ONE deploy per tick — the most recent successful one
// across every deploy target. A tenant deploying several services at once will
// have several candidates, and picking the newest keeps the comparison
// legible: one deploy, one before/after, one recommendation. Widening this to
// a per-target comparison is a reasonable tenant-specific edit; the query
// below is the shape to copy.
//
// What counts as a deploy comes from the tenant's deploy targets
// (`deploy-signals/<name>.sql`, parsed by the runner into `ctx.deployTargets`;
// same contract as `deploy-failed.monitor.ts`). The cicd stream carries every
// completed workflow/job/deployment/commit status, so without those targets
// "the most recent successful deploy" would usually be an ordinary green CI
// run. No targets yet = the monitor stays quiet.

// Baseline window: how much traffic BEFORE the deploy to compare against.
const BASELINE_MINUTES = 60;
// Evaluate as soon as both windows have enough requests; sample floors
// prevent a partial population from producing a verdict.
const SETTLE_MINUTES = 0;
// Past this age a deploy stops being the obvious suspect. Beyond it this
// monitor goes quiet and the tenant's ordinary error-rate alarms own the
// problem — otherwise every slow afternoon reads as a regression of the last
// thing that shipped.
const MAX_AGE_MINUTES = 120;
// Both windows need at least this many server spans before a percentage means
// anything. A service handling 12 requests an hour will swing between 0% and
// 8% on one bad request.
const MIN_SAMPLES = 200;
// Both gates must trip. The absolute floor stops 0.1% → 0.4% (a tripling of
// nothing) from paging; the ratio stops 40% → 42% (already broken, unchanged)
// from paging. Together they mean "meaningfully worse, and worse by an amount
// a person would act on".
const MIN_ABS_POINTS = 2;
const MIN_RATIO = 1.5;

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Target bodies are agent-authored booleans the protocol parser already
// vetted (no `;`); parentheses are the whole escaping story. Mirrors
// protocol's `deploySignalAnySql` / `deployTargetNameSql` — a monitor file may
// only `import type` — and is pinned against them by `deploy-monitors.test.ts`.
function anyTargetSql(targets: readonly DeployTarget[]): string {
  return targets.map((t) => `(${t.where})`).join(" OR ");
}
function targetNameSql(targets: readonly DeployTarget[]): string {
  const arms = targets.flatMap((t) => [`(${t.where})`, `'${t.name}'`]);
  return `multiIf(${arms.join(", ")}, NULL)`;
}
function targetEnvSql(targets: readonly DeployTarget[]): string {
  const arms = targets.flatMap((t) => [
    `(${t.where})`,
    t.env !== "" ? `'${t.env}'` : "toString(attrs.`cicd.environment`)",
  ]);
  return `multiIf(${arms.join(", ")}, '')`;
}

// The most recent deploy of any target that actually succeeded, within the
// age bound. Failed deploys are the `deploy-failed` monitor's job — a deploy
// that never shipped can't have regressed anything. The targets' repos prune
// the scan on `otel_logs`' leading sort key (cicd rows set `service.name` to
// the repo).
export function buildLatestSuccessfulDeploySql(
  maxAgeMinutes: number,
  targets: readonly DeployTarget[],
): string {
  if (targets.length === 0) {
    throw new Error("buildLatestSuccessfulDeploySql needs at least one target");
  }
  const repos = [...new Set(targets.map((t) => t.repo))];
  return `
    SELECT
      ${targetNameSql(targets)} AS target,
      toString(attrs.\`cicd.repo\`) AS repo,
      ${targetEnvSql(targets)} AS environment,
      toString(attrs.\`cicd.sha_short\`) AS sha,
      toString(attrs.\`cicd.sha\`) AS full_sha,
      toString(attrs.\`cicd.run_url\`) AS run_url,
      toUnixTimestamp(ts) AS at_unix
    FROM otel.logs
    WHERE onepatch_source = 'cicd'
      AND service_name IN (${repos.map((r) => `'${r}'`).join(", ")})
      AND (${anyTargetSql(targets)})
      AND ts > now() - INTERVAL ${maxAgeMinutes} MINUTE
      AND toString(attrs.\`cicd.status\`) = 'success'
    ORDER BY ts DESC
    LIMIT 1
  `;
}

// Error rate on either side of the deploy boundary, in one pass over one
// window. Two separate queries would race the clock between them and read
// different `now()`s.
//
// `!= 'internal'` (not `NOT IN ('internal','cicd')`) is correct here: this
// asks "the customer's error rate, minus OnePatch's own noise", and cicd
// events are log records — they can never appear in `otel.spans` at all.
//
// `kind = 2` = server spans: requests this system handled. Client spans would
// double-count a failure as both the caller's and the callee's.
export function buildErrorRateSql(opts: {
  atUnix: number;
  baselineMinutes: number;
  environment: string;
  runId: string;
}): string {
  // `atUnix` is asserted to be a finite integer by the caller and `environment`
  // is matched against a conservative pattern — monitors have no parameter
  // binding channel (`queryOtel` takes SQL and nothing else), so validation at
  // the boundary is what keeps these literals safe.
  const boundary = `toDateTime(${Math.trunc(opts.atUnix)}, 'UTC')`;
  const envClause = opts.environment === "" ? "" : `AND env = '${opts.environment}'\n      `;
  return `
    SELECT
      countIf(start_ts < ${boundary}) AS before_total,
      countIf(start_ts < ${boundary} AND status_code = 2) AS before_errors,
      countIf(start_ts >= ${boundary}) AS after_total,
      countIf(start_ts >= ${boundary} AND status_code = 2) AS after_errors
    FROM otel.spans
    WHERE kind = 2
      AND service_name = 'auth-service'
      AND toString(attrs.\`demo.run_id\`) = '${opts.runId}'
      AND onepatch_source != 'internal'
      ${envClause}AND start_ts BETWEEN ${boundary} - INTERVAL ${opts.baselineMinutes} MINUTE AND now()
  `;
}

// Environments are customer-authored strings arriving from a GitHub webhook.
// Anything outside this shape is dropped rather than escaped — a deploy to an
// environment named with a quote is not worth a bespoke quoting path.
const ENV_RE = /^[\w.@:-]{1,64}$/;

function pct(errors: number, total: number): number {
  return total === 0 ? 0 : (100 * errors) / total;
}

const monitor: Monitor = {
  // Evaluate frequently; verdicts remain gated by deployment and sample evidence.
  cron: "*/15 * * * * *",
  // Armed: hands off to `deploy-response`, whose playbook for this case is
  // "confirm the correlation, then recommend rollback or fix-forward with the
  // sha already in hand".
  armed: true,
  responderSkill: "deploy-response",
  description: "Fires when error rate rose materially right after a successful deploy.",
  async evaluate(ctx): Promise<MonitorResult> {
    try {
      const { targets, errors, configured } = ctx.deployTargets;
      // A target file we could not parse is our failure, not a customer fact:
      // surface it as unknown (see deploy-failed).
      if (errors.length > 0) {
        return {
          state: "unknown",
          reason: `deploy target file(s) failed to parse: ${errors
            .map((e) => `${e.file}: ${e.reason}`)
            .join("; ")}`,
        };
      }
      // No targets yet: stay quiet (see deploy-failed).
      if (!configured) {
        return { state: "healthy", attrs: { skipped: "deploy_targets_not_configured" } };
      }

      const deployRows = await ctx.queryOtel(
        buildLatestSuccessfulDeploySql(MAX_AGE_MINUTES, targets),
      );
      const d = deployRows[0];
      if (!d) {
        return { state: "healthy", attrs: { skipped: "no_recent_successful_deploy" } };
      }

      const atUnix = num(d.at_unix);
      const target = str(d.target);
      const service = targets.find((t) => t.name === target)?.service ?? "";
      const repo = str(d.repo);
      const sha = str(d.sha);
      const fullSha = str(d.full_sha);
      const runUrl = str(d.run_url);
      const rawEnv = str(d.environment);
      const environment = ENV_RE.test(rawEnv) ? rawEnv : "";
      if (atUnix <= 0) {
        return { state: "unknown", reason: "deploy row carried no usable timestamp" };
      }

      const ageMinutes = Math.floor((Date.now() / 1000 - atUnix) / 60);
      if (ageMinutes < SETTLE_MINUTES) {
        return {
          state: "healthy",
          attrs: { skipped: "deploy_too_fresh", deploy_age_minutes: ageMinutes, deploy_sha: sha },
        };
      }

      if (!/^[a-f0-9]{40}$/.test(fullSha)) {
        return { state: "unknown", reason: "Latest demo deployment has no full Git SHA" };
      }
      // Resolve the current scenario from telemetry of THIS actual deployment. Old
      // rehearsals and delayed ingestion from a previous SHA cannot select the run.
      const runRows = await ctx.queryOtel(`
        SELECT toString(attrs.\`demo.run_id\`) AS run_id
        FROM otel.spans
        WHERE service_name = 'auth-service' AND kind = 2
          AND onepatch_source != 'internal' AND env = 'demo'
          AND toString(resource_attrs.\`service.version\`) = '${fullSha}'
          AND start_ts >= toDateTime(${Math.trunc(atUnix)}, 'UTC')
          AND start_ts <= now()
        ORDER BY start_ts DESC
        LIMIT 1
      `);
      const runId = str(runRows[0]?.run_id);
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(runId)) {
        return { state: "unknown", reason: "Waiting for telemetry from the current demo deployment" };
      }
      const rateRows = await ctx.queryOtel(
        buildErrorRateSql({ atUnix, baselineMinutes: BASELINE_MINUTES, environment, runId }),
      );
      const r = rateRows[0] ?? {};
      const beforeTotal = num(r.before_total);
      const afterTotal = num(r.after_total);
      const beforePct = pct(num(r.before_errors), beforeTotal);
      const afterPct = pct(num(r.after_errors), afterTotal);

      const attrs: MonitorAttrs = {
        demo_run_id: runId,
        deploy_target: target,
        deploy_repo: repo,
        ...(service !== "" ? { deploy_service: service } : {}),
        deploy_sha: sha,
        deploy_environment: environment,
        deploy_age_minutes: ageMinutes,
        before_spans: beforeTotal,
        after_spans: afterTotal,
        before_error_pct: Number(beforePct.toFixed(3)),
        after_error_pct: Number(afterPct.toFixed(3)),
      };
      if (runUrl !== "") attrs.deploy_run_url = runUrl;

      if (beforeTotal < MIN_SAMPLES || afterTotal < MIN_SAMPLES) {
        attrs.skipped = "insufficient_traffic";
        attrs.min_samples = MIN_SAMPLES;
        return { state: "unknown", reason: "Demo observation window is still arriving", attrs };
      }

      const absDelta = afterPct - beforePct;
      // A zero baseline makes the ratio meaningless (and infinite), so the
      // absolute gate carries it alone in that case.
      const ratioOk = beforePct === 0 ? true : afterPct >= beforePct * MIN_RATIO;
      if (absDelta < MIN_ABS_POINTS || !ratioOk) {
        return { state: "healthy", attrs };
      }

      const unit = service === "" ? repo : `${repo} (${service})`;
      const where = environment === "" ? unit : `${unit} → ${environment}`;
      return {
        state: "firing",
        reason:
          `Error rate rose from ${beforePct.toFixed(2)}% to ${afterPct.toFixed(2)}% ` +
          `(+${absDelta.toFixed(2)} points) in the ${ageMinutes}m since ${where} deployed ${sha}` +
          (runUrl === "" ? "" : ` — ${runUrl}`),
        attrs,
      };
    } catch (err) {
      return {
        state: "unknown",
        reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
export default monitor;
