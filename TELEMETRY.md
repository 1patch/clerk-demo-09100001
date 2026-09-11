# Telemetry

The services emit OTLP/JSON spans only — no metrics, no logs. `sut/telemetry.mjs` builds the
payloads by hand (there is no OpenTelemetry SDK), and `sut/exporter.mjs` POSTs them.

## Export

`npm start` wires `createOtlpExporter()` into `startServers` as `onTelemetry`, so spans leave the
process. Tests and other embedders pass their own `onTelemetry` callback instead.

Spans are queued and flushed every 200ms with a 2s request timeout. The queue is capped at 256
payloads and drops oldest-first; export failures are logged and never fail a request.

| | Default | Override |
|---|---|---|
| Endpoint | `https://clerk-demo-09-10.logger.onepatch.dev/v1/traces` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` |
| Token | `op_VFpsjs6Aak4UJkFW1c7cL2mLOl4b_TwiAta23NcFG04` | `ONEPATCH_INGEST_TOKEN` |

The endpoint and token are a write-only ingest pair, like a Sentry DSN: they can push spans into
this demo's project and read nothing back. They are committed in the clear on purpose.

## Resource attributes

`service.name` (`auth-service` or `ip-verifier`), `service.version` (full 40-char git SHA),
`deployment.environment.name` (`demo`), `demo.run_id`. Instrumentation scope is `clerk-demo` 1.0.0.

## Spans

`POST /oauth/callback` produces a linked trace: `POST /oauth/callback` → `request.verify` →
`ip_verifier.verify`, plus `session.persist` on success, and the verifier's own `POST /verify`.

Every other route produces one standalone server span: `GET /health` and `GET /version` on
auth-service, `GET /health` on ip-verifier, and the 404 and 400 branches of both services.

## Attribute conventions

- `demo.source` is `live-request` for real traffic; seeded populations use `historical` or
  `synthetic-stream`. `demo.synthetic` is false only for live traffic, so the two never mix.
- `http.route` is a route template. Unmatched requests use the sentinel `/*` to bound cardinality;
  `url.path` carries the actual target.
- `http.response.status_code` is set only when a status is genuinely known. It stays unset on a
  timeout and when the client hung up before a reply.
- Span `status.code = 2` means the service failed. Client errors (4xx) keep status 1 and record
  `error.type` instead, so 404s and malformed bodies do not inflate the service error rate.
- `error.type` values: `IP_VERIFIER_TIMEOUT`, `IP_VERIFIER_UNAVAILABLE`, `CLIENT_CANCELLED`,
  `NOT_FOUND`, `INVALID_REQUEST`.
