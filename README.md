# OAuth callback service

A Node.js service that creates sessions after checking advisory IP reputation. `auth-service` calls `ip-verifier`; the verifier budget and fallback policy are configured in `sut/release.json`.

Run with Node 22: `npm start`. Run request and deployment checks with `npm test`. The service exposes `/health` and `/version` with the running Git revision. `POST /oauth/callback` accepts the fixture request shape described by `sut/server.mjs`.

The telemetry generator emits representative request traces with explicit synthetic attributes. GitHub deployment receipts identify the actual deployed commit. `onepatch/workspace` contains service definitions and the deployment-regression monitor configuration.
