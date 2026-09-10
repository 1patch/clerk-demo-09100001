# Durable system under test

The laptop owns scenario control and GitHub credentials. The exe.dev VM runs only
the auth/verifier system under test through systemd. Deployment uploads committed
Git objects in a bundle; no GitHub credentials or repository access are needed on
the VM. Tracked controller code can be present in the checkout but is never started.

Provision a dedicated exe.dev VM with Node.js 22+ at `/usr/bin/node`, Git, curl,
systemd, and passwordless sudo for its SSH user. Establish and verify the VM's SSH
host key once; the deployer requires strict host-key checking and batch-mode auth.
It does not create VMs, authorize keys, install packages, or change web visibility.

```sh
# exe.dev lobby command; keeps existing visibility (private by default).
ssh exe.dev share port YOUR_VM_NAME 8080

# Full immutable SHA, already committed locally.
node deploy/deploy.mjs --host YOUR_VM_NAME.exe.xyz --revision FULL_COMMIT_SHA --dry-run
# Actual deployment must pass the laptop controller's workspace guard.
npm run demo -- deploy
```

`/opt/clerk-demo` must be absent on first installation. Subsequent deployments
require the installation's marker in `.git/clerk-demo-managed`, a clean checkout,
and the managed systemd unit. Unrelated directories or modified files cause a
failure, never a reset or cleanup. Each deployment fetches the bundle and checks
out the requested SHA in detached HEAD; resetting the scenario deploys the baseline
commit the same way. There are no phase overrides in runtime environment variables.

The service starts at boot and restarts on failure. The process runs as the
unprivileged `clerk-demo` user with a root-owned checkout. Success requires both
Git HEAD and `/health.version` to match the requested SHA after restart. A failed
health check reports failure and leaves the actual state available for inspection;
it does not claim success or silently roll back. Inspect with:

```sh
ssh YOUR_VM_NAME.exe.xyz sudo journalctl -u clerk-demo.service -n 100
```

`--host localhost --dry-run` performs local validation without opening SSH or
modifying refs. Tests exercise real Git bundles and detached HEAD transitions in
temporary directories, including a return to baseline; they never mutate a VM.

Official hosting references: [SSH model](https://exe.dev/docs/faq/how-exedev-works),
[HTTP proxy and visibility](https://exe.dev/docs/proxy).
