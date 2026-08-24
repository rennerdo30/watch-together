# Deployment Guide

This guide covers deploying Watch Together using Docker Compose with various reverse proxy options.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Deployment Options](#deployment-options)
  - [Option 1: Cloudflare Tunnel (Recommended)](#option-1-cloudflare-tunnel-recommended)
  - [Option 2: Direct Nginx/Traefik](#option-2-direct-nginxtraefik)
  - [Option 3: Local Development](#option-3-local-development)
- [Configuration](#configuration)
- [Browser Extension](#browser-extension)
- [Maintenance](#maintenance)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Docker** 24.0+ and **Docker Compose** v2
- A domain name (for production deployments)
- (Optional) Cloudflare account for Zero Trust authentication

## Quick Start

```bash
# Clone the repository
git clone https://github.com/rennerdo30/watch-together.git
cd watch-together

# Create environment file
cp .env.example .env

# Start all services
docker compose up -d --build

# Check status
docker compose ps

# View logs
docker compose logs -f
```

The application runs on:
- **Port 80**: Nginx proxy (main entry point). Published on `127.0.0.1` only by
  default — the Cloudflare tunnel reaches it over the Docker network. Set
  `NGINX_BIND=0.0.0.0` (and optionally `NGINX_PORT`) to publish it to the LAN.

Internal services (not exposed to host by default):
- **Port 3000**: Next.js frontend (Docker-internal only)
- **Port 8000**: FastAPI backend (Docker-internal only)
- **Port 4416**: bgutil PO token provider (Docker-internal only)

## Deployment Options

### Option 1: Cloudflare Tunnel (Recommended)

The most secure method - no open ports required on your server.

#### 1. Create Tunnel

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** → **Tunnels**
3. Click **Create a tunnel**
4. Name it (e.g., `watch-together`)
5. Choose **Docker** as the environment
6. Copy the tunnel token (starts with `ey...`)

#### 2. Configure Environment

Edit `.env`:
```bash
TUNNEL_TOKEN=eyJhIjoiYWJjMTIz...your_token_here
```

#### 3. Configure Public Hostname

In the Cloudflare Dashboard, add a public hostname:

| Setting | Value |
|---------|-------|
| Public hostname | `watch.yourdomain.com` |
| Service Type | HTTP |
| URL | `watch-together-proxy:80` |

> **Note**: Only one hostname entry is needed. Nginx handles routing internally.

#### 4. Enable Authentication (Strongly Recommended)

1. Go to **Access** → **Applications**
2. Create a **Self-hosted** application
3. Configure:
   - Application domain: `watch.yourdomain.com`
   - Session duration: 24 hours (or preferred)
4. Add an access policy:
   - Allow specific emails or email domains
   - Example: `*@yourdomain.com`
5. Copy the application's **Audience (AUD) tag** from its Overview page.

Then set both values in `.env` so the backend *verifies* identities:

```bash
CF_ACCESS_TEAM_DOMAIN=https://yourteam.cloudflareaccess.com
CF_ACCESS_AUD=your_application_audience_tag
```

With these set, the backend validates the signed `Cf-Access-Jwt-Assertion`
token on every request — checking the signature against your team's public
keys, the audience, the issuer, and the expiry — and takes the user's email
from the verified claims.

> **Why this matters**: without these variables the backend falls back to
> trusting the plain `Cf-Access-Authenticated-User-Email` header. That header
> is set by Cloudflare, but anyone who can reach the origin directly can also
> send it, and identity selects which user's stored cookies are used. Set both
> variables, and keep the origin unreachable except through the tunnel.

Setting them also turns on `REQUIRE_AUTHENTICATION`, so anonymous WebSocket
and proxy requests are rejected instead of falling back to a guest identity.
Override it explicitly if you want different behaviour.

#### 5. Deploy

```bash
docker compose up -d --build
```

### Option 2: Direct Nginx/Traefik

For use with your own reverse proxy (Nginx, Traefik, Caddy).

#### 1. Configure the published port

Remove or comment out the `cloudflared` service, then choose where nginx is
published. For a reverse proxy on the same host, the loopback default already
works — just pick the port:

```bash
NGINX_PORT=8080          # reachable at 127.0.0.1:8080
```

For a reverse proxy on another host, publish it on all interfaces:

```bash
NGINX_BIND=0.0.0.0
NGINX_PORT=8080
```

> Without Cloudflare Access in front, set up authentication in your own proxy.
> The backend cannot verify Access assertions that are never issued, so it
> falls back to trusting the identity header.

#### 2. Configure External Reverse Proxy

**Nginx Example:**
```nginx
server {
    listen 443 ssl http2;
    server_name watch.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    # Video proxy - extended timeouts
    location /api/proxy {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_max_body_size 0;
    }
}
```

**Traefik Example (docker-compose labels):**
```yaml
services:
  proxy:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.watch.rule=Host(`watch.yourdomain.com`)"
      - "traefik.http.routers.watch.tls.certresolver=letsencrypt"
      - "traefik.http.services.watch.loadbalancer.server.port=80"
```

### Option 3: Local Development

For development without Docker:

```bash
# Terminal 1: Backend
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Terminal 2: Frontend
cd frontend
npm install --legacy-peer-deps
npm run dev
```

Set `DEVELOPMENT_MODE=true` environment variable to enable `?user=` query parameter auth:
```bash
DEVELOPMENT_MODE=true uvicorn main:app --reload --port 8000
```
Access at http://localhost:3000 with `?user=dev@example.com` for identity.

> **Warning**: Never enable `DEVELOPMENT_MODE` in production. It allows impersonation via query parameter.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TUNNEL_TOKEN` | Cloudflare Tunnel token | (required for CF) |
| `DATA_DIR` | Data storage directory | `./data` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins (e.g., `https://watch.example.com`) | `*` (wildcard) |
| `DEVELOPMENT_MODE` | Enable dev features like query param auth (`true`/`false`) | `false` |
| `MAX_CONNECTIONS_PER_ROOM` | Maximum WebSocket connections per room | `50` |
| `MAX_CONNECTIONS_PER_USER` | Maximum WebSocket connections per user | `10` |

> **Security Note**: In production, always set `ALLOWED_ORIGINS` to your specific domain(s). When `ALLOWED_ORIGINS` is `*`, CORS credentials are automatically disabled. The `DEVELOPMENT_MODE` flag enables `?user=` query parameter authentication - never enable in production.

### Data Persistence

Data is stored in `./data/` (mapped via Docker volume):

```
data/
├── cookies/           # User cookie files (Netscape format)
│   └── user@email.txt
├── rooms.json         # Room state persistence
└── yt_dlp_cache/      # yt-dlp download cache
```

### Nginx Configuration

The internal Nginx configuration is at `nginx/nginx.conf`. Key settings:

- **Video Proxy**: Extended timeouts (600s), disabled buffering
- **WebSocket**: 24-hour timeout for long sessions
- **Streaming**: Chunked encoding disabled for compatibility
- **Security Headers**: CSP, HSTS, Permissions-Policy, X-Content-Type-Options, X-Frame-Options

### Container Resource Limits

All containers have memory and CPU limits configured via `deploy.resources.limits`:

| Service | Memory Limit | CPU Limit |
|---------|-------------|-----------|
| Backend | 1 GB | 2.0 |
| Frontend | 512 MB | 1.0 |
| Proxy (Nginx) | 128 MB | 0.5 |
| Tunnel | 128 MB | 0.5 |
| bgutil | 512 MB | 1.0 |

## Browser Extension

The browser extension automatically syncs cookies from YouTube/Twitch to the server.

### Installation

Chrome, from a packaged build (recommended):

1. Download `watch-together-chrome-nightly.zip` from the
   [Nightly release](../../releases/tag/nightly) — rebuilt from every commit on
   `main` — and verify it against the published `.sha256` if you like
2. Extract the archive
3. Open `chrome://extensions`, enable "Developer mode"
4. Click "Load unpacked" and select the extracted folder

From a checkout (either browser):

1. Open Chrome/Firefox and go to `chrome://extensions` or `about:addons`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` folder
4. Pin the extension for easy access

### Usage

1. Log in to YouTube/Twitch in your browser
2. Open your Watch Together instance while signed in, then click the extension
   icon and connect that site — the extension asks the instance who you are and
   stores the resulting token locally, on this browser only
3. Cookies are synced automatically from then on

The account shown in the popup and in Settings is always the one the backend
confirms owns the stored token. If you sign in as somebody else, the extension
drops the old connection rather than syncing your cookies to the previous
account, and asks you to reconnect.

## Maintenance

### Updating

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker compose up -d --build
```

### Backup

```bash
# Backup data directory
tar -czf backup-$(date +%Y%m%d).tar.gz data/
```

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f frontend

# Last 100 lines
docker compose logs --tail=100 backend
```

### Restart Services

```bash
# Restart all
docker compose restart

# Restart specific service
docker compose restart backend

# Full rebuild
docker compose down && docker compose up -d --build
```

## Troubleshooting

### Video Not Loading / 403 Forbidden

**Cause**: Age-restricted or region-locked content without valid cookies.

**Fix**:
1. Install the browser extension
2. Log in to YouTube in your browser
3. Visit Watch Together - cookies sync automatically
4. Retry the video

Or manually:
1. Export cookies using [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
2. Go to Settings → Cookie Authentication
3. Paste and save

### WebSocket Connection Failed

**Cause**: Reverse proxy not configured for WebSocket upgrade.

**Fix**: Ensure your proxy passes WebSocket headers:
```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### Video Buffering / HTTP/2 Errors

**Cause**: Streaming issues with HTTP/2 connection reuse.

**Fix**: The nginx config disables chunked encoding and forces connection close for video proxy. If using Cloudflare, try:
1. Disable "HTTP/2 to Origin" in Speed settings
2. Or add a Page Rule for `/api/proxy*` with Cache Level: Bypass

### App Stuck on Loading

**Cause**: Container not running or build error.

**Fix**:
```bash
# Check container status
docker compose ps

# Check for errors
docker compose logs backend
docker compose logs frontend

# Rebuild
docker compose down && docker compose up -d --build
```

### Container Keeps Restarting

**Cause**: Port conflict or missing dependencies.

**Fix**:
```bash
# Check logs for error
docker compose logs backend

# Check if port is in use
lsof -i :8000
lsof -i :3000
```

### No Quality Options Available

**Cause**: Invalid or expired cookies.

**Fix**:
1. Re-sync cookies via extension
2. Or delete and re-upload cookies manually
3. Check backend logs: `docker compose logs backend | grep -i cookie`
