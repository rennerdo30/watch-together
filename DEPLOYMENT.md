# Deployment Guide

This guide details how to deploy **Watch Together** using Docker Compose.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Deployment Methods](#deployment-methods)
    - [Option 1: Cloudflare Tunnel (Recommended)](#option-1-cloudflare-tunnel-recommended)
    - [Option 2: Generic Reverse Proxy](#option-2-generic-reverse-proxy)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Docker** and **Docker Compose** installed on your server.
- A domain name (e.g., `example.com`).

---

## Deployment Methods

### Option 1: Cloudflare Tunnel (Recommended)

This method is the most secure as it exposes no open ports on your server.

#### 1. Setup Cloudflare Zero Trust
1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Navigate to **Access** -> **Tunnels**.
3. Create a new tunnel, name it (e.g., `watch-together`).
4. Choose the environment (Docker).
5. Copy the **token** from the install command (it looks like `ey...`).

#### 2. Configure Environment
Create a `.env` file in the project root:

```bash
# .env
TUNNEL_TOKEN=your_token_here_ey...
```

#### 3. Update `docker-compose.yml` (if needed)
Ensure the `cloudflared` service is present (it is by default in this repository).

#### 4. Configure Tunnel Routes
In the Cloudflare Dashboard (Tunnel configuration):
Add a single Public Hostname:

- **Public Hostname**: `watch.yourdomain.com`
- **Service**: `HTTP` -> `watch-together-proxy:80`

**Note:** You do NOT need multiple entries. The Nginx proxy handles `/api`, `/ws`, and static assets.

#### 5. User Authentication (Optional but Recommended)
To prevent unauthorized access:
1. Go to **Access** -> **Applications**.
2. Create a "Self-hosted" application.
3. Set domain to `watch.yourdomain.com`.
4. Configure policies (e.g., allow emails ending in `@yourdomain.com` or specific users).

The application reads the `Cf-Access-Authenticated-User-Email` header to identify users logged in via Cloudflare Access.

#### 6. Deploy
```bash
docker compose up -d --build
```

---

### Option 2: Generic Reverse Proxy

If you use Nginx, Traefik, or Caddy on your host:

1. Remove the `tunnel` service from `docker-compose.yml`.
2. Map the proxy port to the host:
   ```yaml
   services:
     proxy:
       ports:
         - "8080:80"  # Expose proxy on port 8080
   ```
3. Configure your reverse proxy to forward traffic to `localhost:8080`.

**Important:** You must handle SSL termination at your reverse proxy. The internal Nginx is only HTTP.

---

## Troubleshooting

### "Video not loading / 403 Forbidden"
This usually happens with YouTube age-gated content.
**Fix:** You need to provide cookies.
1. Use a "Get cookies.txt" extension.
2. Save to `backend/data/cookies.txt`.
3. Restart backend: `docker compose restart backend`.

### "WebSocket Connection Failed"
Ensure your reverse proxy supports WebSockets.
- **Cloudflare**: Enabled by default.
- **Nginx**: Ensure standard WebSocket headers (`Upgrade`, `Connection`) are passed.

### "App is stuck on loading screen"
Check browser console (`F12`). If you see CSP errors or 404s, ensure the `watch-together-proxy` container is running and healthy.
