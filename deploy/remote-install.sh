#!/usr/bin/env bash
set -euo pipefail
# Invoked through sudo by the laptop deployer; no deployment credentials live here.
readonly target=/opt/clerk-demo
readonly marker=clerk-demo-managed-v1
readonly unit=/etc/systemd/system/clerk-demo.service
sha=${1:?full commit SHA required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run through sudo' >&2; exit 1; }
stage=$(cd -- "$(dirname -- "$0")" && pwd)
command -v git >/dev/null
command -v systemctl >/dev/null
command -v curl >/dev/null
[[ -x /usr/bin/node ]] || { echo 'Install Node.js at /usr/bin/node first' >&2; exit 1; }
[[ $(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || { echo 'Node.js 22+ required' >&2; exit 1; }
# Refuse unrelated installations and any dirty checkout. Never force-reset or clean.
[[ ! -L "$target" ]] || { echo 'Refusing symlink installation' >&2; exit 1; }
if [[ -e "$target" ]]; then
  [[ -d "$target/.git" && ! -L "$target/.git" && -f "$target/.git/clerk-demo-managed" ]] || { echo 'Existing directory is not a managed demo' >&2; exit 1; }
  [[ $(cat "$target/.git/clerk-demo-managed") == "$marker" ]] || exit 1
  [[ -z $(git -C "$target" status --porcelain --untracked-files=all) ]] || { echo 'Demo checkout is dirty; resolve manually' >&2; exit 1; }
fi
if [[ -e "$unit" ]]; then
  [[ ! -L "$unit" ]] && head -n 1 "$unit" | grep -Fxq '# Managed by clerk-demo deployment v1' || { echo 'Refusing unrelated systemd unit' >&2; exit 1; }
fi
if [[ ! -e "$target" ]]; then
  mkdir -m 755 "$target"
  git -C "$target" init -q
  printf '%s\n' "$marker" > "$target/.git/clerk-demo-managed"
fi
git -C "$target" fetch --no-tags "$stage/repo.bundle" +refs/clerk-demo/deploy:refs/clerk-demo/deploy
git -C "$target" cat-file -e "$sha^{commit}"
[[ $(git -C "$target" rev-parse refs/clerk-demo/deploy) == "$sha" ]] || { echo 'Bundle SHA mismatch' >&2; exit 1; }
git -C "$target" checkout --detach "$sha"
[[ -f "$target/sut/server.mjs" ]] || { echo 'SUT missing in requested commit' >&2; exit 1; }
if ! id clerk-demo >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin clerk-demo
fi
# Files remain root-owned and read-only to the runtime user. It only needs git reads.
chmod -R a+rX "$target"
git config --system --get-all safe.directory | grep -Fxq "$target" || git config --system --add safe.directory "$target"
install -m 644 "$stage/clerk-demo.service" "$unit"
systemctl daemon-reload
systemctl enable clerk-demo.service >/dev/null
systemctl restart clerk-demo.service
for attempt in $(seq 1 30); do
  health=$(curl --fail --silent --max-time 2 http://127.0.0.1:8080/health || true)
  if [[ -n "$health" ]] && printf '%s' "$health" | /usr/bin/node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).version===process.argv[1]?0:1)}catch{process.exit(1)}})' "$sha"; then
    actual=$(git -C "$target" rev-parse HEAD)
    [[ "$actual" == "$sha" ]] || exit 1
    systemctl is-active --quiet clerk-demo.service
    printf '{"deployed":true,"head":"%s","health":%s}\n' "$actual" "$health"
    exit 0
  fi
  sleep 1
done
echo 'Deployment failed health/version verification; inspect journalctl -u clerk-demo' >&2
exit 1
