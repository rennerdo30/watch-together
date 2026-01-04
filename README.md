# Watch Together

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A real-time video synchronization platform allowing users to watch content from YouTube, Twitch, and more together. Built with Next.js, FastAPI, and `yt-dlp`.

## Features
- **Universal Resolver**: Uses `yt-dlp` to resolve HLS streams from almost any URL.
- **Real-time Sync**: Synchronized playback (Play/Pause/Seek) via WebSockets.
- **Room System**: Dynamic rooms with guest user support using Cloudflare Zero Trust identity.
- **Modern UI**: Dark-mode interface built with TailwindCSS.


## Deployment

This project uses **Docker Compose** for easy deployment. While it can be exposed via any reverse proxy, we recommend **Cloudflare Tunnel** for secure, easy access without opening ports.

See [DEPLOYMENT.md](DEPLOYMENT.md) for a detailed step-by-step guide.

## Screenshots

<!-- Add screenshots of the application here -->
> *Work in progress*

### 1. Prerequisites
- Docker & Docker Compose installed.
- (Optional but Recommended) A Cloudflare account for Zero Trust access.

### 2. Quick Start
1. Clone the repo.
2. `cp .env.example .env`
3. `docker compose up -d --build`

## Bypassing Restrictions (Cookies)

To watch age-restricted content or bypass regional blocks, you must provide valid cookies to `yt-dlp`.

1. **Log in** to the application (Guests cannot save cookies).
2. Open the **Settings** menu (Gear icon) in any room.
3. Paste your YouTube cookies (Netscape format) into the "Cookie Authentication" text area.
4. Click **Save Cookies**.

> [!TIP]
> You can export cookies using extensions like [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc).
> These cookies are stored on the server and linked to your identity.

## Local Development
- **Backend**: `cd backend && uvicorn main:app --reload` (Port 8000)
- **Frontend**: `cd frontend && npm run dev` (Port 3000)
