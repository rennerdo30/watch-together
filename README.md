# Watch Together

A real-time video synchronization platform allowing users to watch content from YouTube, Twitch, and more together. Built with Next.js, FastAPI, and `yt-dlp`.

## Features
- **Universal Resolver**: Uses `yt-dlp` to resolve HLS streams from almost any URL.
- **Real-time Sync**: Synchronized playback (Play/Pause/Seek) via WebSockets.
- **Room System**: Dynamic rooms with guest user support using Cloudflare Zero Trust identity.
- **Modern UI**: Dark-mode interface built with TailwindCSS.

## Deployment with Cloudflare Zero Trust

This project is designed to be deployed using **docker-compose** and exposed via a **Cloudflare Tunnel** managed from the Zero Trust Dashboard.

### 1. Prerequisites
- Docker & Docker Compose installed.
- A Cloudflare account with Zero Trust set up.
- A Cloudflare Tunnel created in the dashboard (Save the `TUNNEL_TOKEN`).

### 2. Environment Setup
Create a `.env` file in the root directory:
```bash
TUNNEL_TOKEN=ey... # Your token from Cloudflare Dashboard
```

### 3. Start Services
Run the following command to build and start the application:
```bash
docker compose up -d --build
```

### 4. Cloudflare Dashboard Configuration
With the **Nginx Proxy** added, you only need to configure **ONE** Public Hostname rule in your Cloudflare Tunnel.

**Service**: `http://watch-together-proxy:80`

- **Subdomain**: `w2g` (or your choice)
- **Domain**: `renner.dev` (or your domain)
- **Path**: *(leave empty)*
- **Type**: `HTTP`
- **URL**: `watch-together-proxy:80`

The Nginx proxy automatically routes:
- `/api/*` -> Backend
- `/ws/*` -> Backend (WebSockets)
- `/*` -> Frontend

### 5. Access Policy (Auth)
Ensure you have an Access Application configured for `w2g.renner.dev` to handle authentication. The application reads the `Cf-Access-Authenticated-User-Email` header to identify users.

### 6. Bypassing Regional/Age Restrictions (Cookies)

For age-restricted videos or regional blocks, you need to provide your browser cookies to `yt-dlp`. **A simple console snippet is not enough** because YouTube uses "HttpOnly" cookies which are invisible to JavaScript.

1. Install a Netscape-compatible cookie export extension:
   - [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) (recommended)
   - [Cookie-Editor](https://cookie-editor.com/) (Export as Netscape)
2. Go to YouTube, ensure you are logged in.
3. Use the extension to export your cookies as a `cookies.txt` file.
4. Place the file into `backend/data/cookies.txt`.
5. Restart the services: `docker compose restart watch-together-backend`.

> [!IMPORTANT]
> To ensure the best compatibility, export the cookies from the same computer/browser you are using to submit the video, as the application now syncs your **User-Agent** for a perfect match.

## Local Development
- **Backend**: `cd backend && uvicorn main:app --reload` (Port 8000)
- **Frontend**: `cd frontend && npm run dev` (Port 3000)
