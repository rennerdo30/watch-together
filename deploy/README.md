# Watch Together · Production deploy

Production stack for **w2g.renner.dev**, fronted by a Cloudflare Tunnel
(`cloudflared`). Nothing is published on the host: the tunnel proxies to
`nginx:80` on the internal Docker network, and nginx routes to the frontend
and the backend. Same shape as the `eupd` deploy on the same host.

## Files

- [`docker-compose.yml`](docker-compose.yml) — backend + bgutil + frontend + nginx + cloudflared, and `neko` behind the `browser` profile
- [`docker-compose.browser-udp.yml`](docker-compose.browser-udp.yml) — overlay that publishes a UDP range for the shared browser (the only file here that opens a port)
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

Rebuilds both images and restarts. The backend data volume — SQLite database
and segment cache — survives (cookies are never on it). Add `--reset-data`
to wipe it (asks for confirmation first).

Useful flags: `--skip-sync` (remote-only), `--dry-run`, `--host=`/`--user=`.

## DNS over HTTPS

Every container resolves external names through the `dns` service, an AdGuard
`dnsproxy` sidecar forwarding to Cloudflare over HTTPS, so the
host's resolver sees no query from the stack. It has a fixed address inside
the stack's subnet (`WT_SUBNET`, `WT_DNS_IP` in `.env`). If the defaults
collide with another network on the host, change both together and recreate
the network once: `docker compose down && docker compose up -d`.

## Identity

The backend can tell who a request belongs to in two ways, and the difference
matters because identity selects **which user's YouTube cookies get used**:

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

## yt-dlp stays current

The backend refreshes yt-dlp from the upstream nightly on every container
start, so a deploy or restart always picks up the newest extractor code.
YouTube changes its requirements frequently and the failure mode is total —
zero playable formats, not reduced quality — so a version frozen at image
build time goes stale within days.

Python packages live in a virtualenv owned by the app user, which is what
lets a non-root container upgrade them at boot. Update failures are never
fatal: an offline or rate-limited host starts with the version it has.

```bash
YTDLP_AUTO_UPDATE=false        # pin to whatever the image was built with
```

To pick up new extractor code without a full deploy:

```bash
ssh <host> "cd /opt/watch-together && \
  docker compose -f deploy/docker-compose.yml --env-file /opt/watch-together/.env \
  restart backend"
```

## The shared browser (neko) — opt-in, and why

A room can put a **real browser on the server** into its player: everyone
watches the same page, and whoever holds control types into it. It runs as
[neko](https://github.com/m1k1o/neko), pinned to `ghcr.io/m1k1o/neko/chromium:3.1.5`.

It is **off by default, and it is the only feature here that cannot work on
the tunnel alone.** cloudflared carries HTTP and WebSocket; neko's picture is
WebRTC media, which is neither. So the media needs a path of its own, and
there are exactly two:

| | What you open | What it costs |
|---|---|---|
| **UDP** | a UDP port range on the host, plus the host's public address announced as an ICE candidate | the host stops being a closed box |
| **TURN** | nothing — both ends reach a relay outbound | the relay's bandwidth |

**Until one of them is configured the feature reports itself unavailable**,
and the room says so — with the reason — instead of offering a button that
opens a black rectangle. The backend derives that from the configuration
values themselves (`BROWSER_PUBLIC_IP` + `BROWSER_UDP_PORTS`, or
`WEBRTC_TURN_URL`); there is no "yes it works, trust me" switch.

### Common to both

```bash
./make-env.sh --set=BROWSER_ENABLED=true \
              --set=BROWSER_USER_PASSWORD="$(openssl rand -hex 24)" \
              --set=BROWSER_ADMIN_PASSWORD="$(openssl rand -hex 24)"
```

Neither password is ever sent to a browser. The backend logs into neko over
the internal network and hands each member the resulting session as a cookie
scoped to `/neko`, so a member can use the browser and still has nothing they
could log in with from anywhere else. The room's **admin** gets neko's admin
session (control); everyone else gets the user session.

### Option A — a UDP range on the host

```bash
./make-env.sh --set=BROWSER_UDP_PORTS=59000-59100 \
              --set=BROWSER_PUBLIC_IP=<the host's public IPv4>
```

Then bring the stack up with the overlay that publishes it — a separate file
because the base compose promises that nothing is published:

```bash
docker compose -f deploy/docker-compose.yml \
               -f deploy/docker-compose.browser-udp.yml \
               --env-file /opt/watch-together/.env --profile browser up -d
```

Open the same range **UDP** in the host firewall *and* at the provider. A
candidate pointing at a filtered port is worse than no candidate: every
viewer waits out an ICE timeout before giving up. Verify from elsewhere with
`nc -uzv <host> 59000`.

### Option B — a TURN relay (nothing published)

Reuses the relay screen sharing already has (`WEBRTC_TURN_*`), plus the same
credentials in the JSON shape neko wants:

```bash
./make-env.sh --set=WEBRTC_TURN_URL=turn:turn.example.net:3478 \
              --set=WEBRTC_TURN_USERNAME=<user> \
              --set=WEBRTC_TURN_CREDENTIAL=<secret> \
              --set=BROWSER_ICE_SERVERS='[{"urls":"turn:turn.example.net:3478","username":"<user>","credential":"<secret>"}]'
docker compose -f deploy/docker-compose.yml \
               --env-file /opt/watch-together/.env --profile browser up -d
```

`BROWSER_ICE_SERVERS` is given to neko as **both** its frontend and backend
ICE list, and both matter: the viewer needs the relay to find neko, and neko
needs it to allocate an address of its own. With only the frontend list a
closed host still has nothing to offer.

### Checking it

```bash
./host-status.sh --probe=/api/browser     # enabled / available / reason / transport / running
```

`available: false` with `reason: "no_media_path"` means neither option above
is configured — that is the state the room reports to members. `running:
false` with `available: true` means the container is not up: add
`--profile browser` to the compose command.

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
- **Every YouTube link fails to resolve** — the server's address is a
  datacenter IP, which YouTube treats as a bot and answers with "Sign in to
  confirm you're not a bot" and zero formats. The same code resolves the same
  video fine from a residential connection. The fix is cookies from a
  signed-in account: install the browser extension, open the site, and use
  "Connect this site" in the extension popup so it can sync them.
  `./deploy/host-status.sh --clients=<url>` shows whether any player client
  resolves from the server.
- **Video stalls / `ERR_HTTP2_PROTOCOL_ERROR`** — known open issue; read
  `GET /api/metrics/proxy` (needs identity) for per-transfer outcomes, and
  see `ISSUES.md`.
- **Backend restart loop mentioning `data`** — the data volume must be
  writable by uid 1001; the image creates `/app/data` for exactly this
  reason, so a volume created by an older image may need
  `--reset-data`.
