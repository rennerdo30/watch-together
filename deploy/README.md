# Watch Together · Production deploy

Production stack for **w2g.renner.dev**, fronted by a Cloudflare Tunnel
(`cloudflared`). Nothing is published on the host: the tunnel proxies to
`nginx:80` on the internal Docker network, and nginx routes to the frontend
and the backend. Same shape as the `eupd` deploy on the same host.

## Files

- [`docker-compose.yml`](docker-compose.yml) — backend + bgutil + frontend + nginx + cloudflared
- [`env.example`](env.example) — copy to `/opt/watch-together/.env` and fill in
- [`sync.sh`](sync.sh) — rsync the repo to `/opt/watch-together/`
- [`deploy.sh`](deploy.sh) — one command: sync → build → up → probe
- [`make-env.sh`](make-env.sh) — build the host `.env`, carrying existing values over
- [`host-status.sh`](host-status.sh) — containers, volumes, `.env` keys, `--logs=<service>`

## One-time setup

**1. Create the tunnel.** Cloudflare Zero Trust → **Networks → Tunnels** →
Create tunnel (e.g. `watch-together`) → Install connector → **Docker** → copy
the long `--token` value. Then on the tunnel's **Public Hostname** tab:

| Setting | Value |
|---|---|
| Subdomain | `w2g` |
| Domain | `renner.dev` |
| Service | `HTTP` → `nginx:80` |

**2. Protect it with Access** (recommended — see *Identity* below). Zero Trust
→ **Access → Applications** → Self-hosted, domain `w2g.renner.dev`, with a
policy allowing your own email(s). Note the **AUD tag** from the app's
Overview page and your team domain (`…cloudflareaccess.com`).

**3. Deploy.**

```bash
cp deploy/target.env.example deploy/target.env
$EDITOR deploy/target.env                     # SSH host + login (gitignored)

./deploy/sync.sh                              # ship the files
./deploy/make-env.sh --show                   # see what the host already has
./deploy/make-env.sh \
  --wt-host=w2g.renner.dev \
  --cf-team=https://TEAM.cloudflareaccess.com \
  --cf-aud=YOUR_APP_AUD_TAG                   # writes .env, mode 600
./deploy/deploy.sh                            # build, start, probe
```

`make-env.sh` reuses a tunnel token that is already on the host, including one
stored under the older `TUNNEL_TOKEN` name, so an existing tunnel does not have
to be re-provisioned. If Access already protects the hostname, the team domain
and AUD tag are visible in the login redirect it serves:

```bash
curl -sI https://w2g.renner.dev/ | grep -i location
```

`deploy/target.env` is gitignored on purpose: this repository is public, so the
server address and login stay on your machine rather than in the published
history. `--host=`/`--user=` override it for one-off runs.

`deploy.sh` creates `.env` from `env.example` on the first run and stops with
the list of keys it still needs, so running it before editing is harmless.

## Subsequent updates

```bash
./deploy/deploy.sh
```

Rebuilds both images and restarts. The backend data volume — SQLite database,
per-user cookie files, segment cache — survives. Add `--reset-data` to wipe
it (asks for confirmation first).

Useful flags: `--skip-sync` (remote-only), `--dry-run`, `--host=`/`--user=`.

## Identity

The backend can tell who a request belongs to in two ways, and the difference
matters because identity selects **which user's stored YouTube cookies get
used**:

- **`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` set** — the signed
  `Cf-Access-Jwt-Assertion` is verified against your team's public keys.
  Setting both also turns `REQUIRE_AUTHENTICATION` on, so anonymous
  WebSocket and proxy requests are rejected. **Use this.**
- **Neither set** — the backend falls back to trusting the plain
  `Cf-Access-Authenticated-User-Email` header. Cloudflare sets that header,
  but so can anyone who reaches the origin directly, and it is logged loudly
  at startup as a warning.

Because nothing is published on the host, the origin is only reachable through
the tunnel — but the verified path is still the one to run.

## Notes

- **Single worker only.** Room state, caches and the rate limiter live in
  process memory, so the compose file pins `WEB_CONCURRENCY=1` and the backend
  refuses to start above that — extra workers would split rooms and look like
  a sync bug.
- **`DEVELOPMENT_MODE` is hard-coded off** here. It would let `?user=` set any
  identity.
- The images contain their own code (no source bind mounts), so a deploy is a
  rebuild and editing files on the host changes nothing until the next one.
- The repo-root `docker-compose.yml` is for local development: it bind-mounts
  the source and publishes nginx on `127.0.0.1:80`.

## Troubleshooting

```bash
HOST=<user>@<host>          # same values as deploy/target.env
C="docker compose -f deploy/docker-compose.yml --env-file /opt/watch-together/.env"

ssh $HOST "cd /opt/watch-together && $C ps"
ssh $HOST "cd /opt/watch-together && $C logs --tail 50 backend"
ssh $HOST "cd /opt/watch-together && $C logs --tail 30 cloudflared"
```

- **502 from Cloudflare** — the tunnel's public hostname must point at
  `HTTP` `nginx:80` (service name on the shared network), not `localhost`.
- **Video stalls / `ERR_HTTP2_PROTOCOL_ERROR`** — known open issue; read
  `GET /api/metrics/proxy` (needs identity) for per-transfer outcomes, and
  see `ISSUES.md`.
- **Backend restart loop mentioning `data`** — the data volume must be
  writable by uid 1001; the image creates `/app/data` for exactly this
  reason, so a volume created by an older image may need
  `--reset-data`.
