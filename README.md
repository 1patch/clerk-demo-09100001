# OAuth callback service

A Node.js service that creates sessions after checking advisory IP reputation. `auth-service` calls `ip-verifier`; the verifier timeout and fallback policy are configured in `sut/release.json`.

Requires Node.js 22 or newer. Run `npm start` to start the service, and `npm test` to run its tests. No dependencies are required.

`GET /health` and `GET /version` report the active policy and Git revision. `POST /oauth/callback` accepts a JSON object with `sampleIndex` (a nonnegative integer) and `runId` (1–100 letters, numbers, dots, underscores, or hyphens). The sample selects a deterministic simulated IP-verifier response. The callback returns a session on success or a dependency error.

Request instrumentation produces linked spans for authentication, verification, and session persistence. `startServers` accepts an `onTelemetry` callback for exporting these spans. `PORT` and `VERIFIER_PORT` configure the listeners; their defaults are 8080 and 8081.
