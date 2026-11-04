# Third-party notices

Watch Together's own code is under the [MIT license](LICENSE). Some of what it
bundles, the container images it publishes, and the data it uses at runtime
come under other terms, listed here. Two of them are **non-commercial**: the
motion-smoothing model weights and SponsorBlock's data. Running Watch Together
for yourself and friends is fine; offering it as a paid service is not, unless
you remove those parts or get permission from their owners.

## Bundled in the web app

Served to browsers from `frontend/public/`, each with its licence text alongside.

| Component | Used for | Licence | Notice |
|---|---|---|---|
| [WebSR](https://github.com/sb2702/websr) 0.0.16, with its CNN weights and MobileNetV3 content classifier | Video enhancement (opt-in) | MIT | `frontend/public/upscaling/v1/` |
| [Anime4K](https://github.com/bloc97/Anime4K) CNN and weights | Video enhancement (opt-in) | MIT | `frontend/public/upscaling/v1/THIRD_PARTY_NOTICES.txt` |
| [LiteRT.js](https://github.com/google-ai-edge/LiteRT) 2.5.3 | Running the classifier | Apache-2.0 | `frontend/public/upscaling/v1/THIRD_PARTY_NOTICES.txt` |
| [Framegen](https://github.com/MONZikWasTaken/Framegen) 1.4.0 runtime | Motion smoothing (opt-in) | MIT | `frontend/public/framegen/v1/LICENSE.txt` |
| Framegen v7-small **model weights** (`rt_v7s.*`) | Motion smoothing (opt-in) | **Non-commercial research and personal use only**; redistributed unchanged with its notice | `frontend/public/framegen/v1/WEIGHTS_LICENSE.md` |

The app's npm dependencies (Next.js, React, Shaka Player, hls.js, lucide-react,
dnd-kit and others) are under MIT, Apache-2.0, ISC, BSD or 0BSD licences. The
frontend container image also contains `sharp`'s prebuilt libvips
(LGPL-3.0-or-later), used by Next.js for image optimisation on the server; its
source is at https://github.com/lovell/sharp-libvips.

## In the published container images

CI publishes `ghcr.io/rennerdo30/watch-together/backend` and `.../frontend`.
Besides this project's code, the backend image contains:

| Component | Licence | Source |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | https://github.com/yt-dlp/yt-dlp |
| [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) (yt-dlp plugin) | GPL-3.0 | https://github.com/Brainicism/bgutil-ytdlp-pot-provider |
| [yt-dlp-get-pot](https://github.com/coletdjnz/yt-dlp-get-pot) (yt-dlp plugin) | Unlicense | https://github.com/coletdjnz/yt-dlp-get-pot |
| FFmpeg, as packaged by Debian | LGPL-2.1+ / GPL-2.0+ (Debian's build) | `apt-get source ffmpeg`, or https://sources.debian.org/src/ffmpeg/ |
| Python, Debian base system | PSF and the respective Debian package licences | https://sources.debian.org/ |
| Python dependencies in `backend/requirements.txt` | MIT, BSD, Apache-2.0, MPL-2.0 (certifi) and similar | PyPI |

Every component is installed unmodified from its upstream release. The GPL and
LGPL parts are separate programs or plugins loaded at runtime; their source is
available at the links above, and the exact versions are pinned in
`backend/requirements.txt` and `backend/Dockerfile`.

The compose files also start images this project does not publish:
[neko](https://github.com/m1k1o/neko) (Apache-2.0, opt-in), the
[bgutil PO-token server](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) (GPL-3.0),
[nginx](https://nginx.org/) (BSD-2-Clause),
[AdGuard dnsproxy](https://github.com/AdguardTeam/dnsproxy) (Apache-2.0) and
[cloudflared](https://github.com/cloudflare/cloudflared) (Apache-2.0).

## Data used at runtime

- **SponsorBlock.** Uses SponsorBlock data from https://sponsor.ajay.app/,
  licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
  The room settings credit it where the feature is switched on. The licence is
  non-commercial; commercial use needs the SponsorBlock author's permission.
- **Live chat embeds** (Twitch, YouTube, Kick, Owncast) are loaded from those
  services under their own terms.

## Fonts and images on the website

- [Inter Tight](https://github.com/rsms/inter-tight) and
  [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), self-hosted under
  the SIL Open Font License 1.1 (`docs/public/site/fonts/OFL.txt`).
- Screenshots are of this app with made-up rooms and users; the "video" in them
  is a drawn landscape, not anyone's footage.

## Trademarks

YouTube, Twitch, Kick, Vimeo, Dailymotion, Owncast, Chrome, Edge, Firefox,
Cloudflare and other names are trademarks of their respective owners. They are
used only to say which services Watch Together works with. Watch Together is an
independent project, not affiliated with, endorsed or sponsored by any of them.
Viewers are responsible for following the terms of the sites they watch.
