# Chrome Web Store submission

Use the public GitHub Pages policy URL:

https://rennerdo30.github.io/watch-together/privacy/

The documentation site is public, so this URL does not require a Watch Together or
Cloudflare Access login. Verify it in a signed-out browser before submission.
Do not use an instance URL protected by Access. Privacy contact: support@renner.dev.

## Privacy practices tab

Single purpose: connect a browser session to a Watch Together instance so members
can resolve streaming videos, synchronize their viewing, and send video links
from permitted sites to the instance.

Disclose personally identifiable information (the verified account email),
authentication information (session cookies and the instance token), web history
(visited/source/video URLs handled for these features), and website content
(video/stream metadata). Review the dashboard's current category descriptions
and include user activity where applicable to tab/idle events. Do not declare
that the extension collects no user data. State that configured-site cookies
are sent to the connected instance and may help other members in the same room
resolve individual videos. Keep the listing, policy and dashboard consistent.

Permission justifications:

- `cookies`: read selected streaming-site sessions to resolve and fetch videos.
- `storage`: retain the local instance connection, preferences and detected streams.
- `alarms`: schedule cookie refresh and stale-stream cleanup.
- `idle`: refresh the session when the browser becomes active again.
- `tabs`: read the active page for connection/video actions, find instance tabs,
  and prevent open room tabs from being discarded.
- `webRequest`: detect media manifest URLs on permitted video hosts.
- Required video host access: read streaming-site cookies and detect manifests.
- Optional host access: users explicitly grant their self-hosted instance origin
  and additional cookie domains; the instance address is not known at build time.

No remote executable code is loaded by the extension. Backend API responses are
data. The server-side yt-dlp updater is separate from extension code.

## Before upload

Build the Chrome ZIP using the same packager as in-app downloads:

```sh
python backend/services/extension_package.py --source extension --browser chrome \
  --output dist/watch-together-chrome.zip --checksum
```

Use a version greater than every version previously uploaded to your listing.
The manifest currently declares 1.5.3; the dashboard remains the source of truth
for previously uploaded versions. Provide reviewer instructions and a usable
test instance/account if access is required.

The extension requires HTTPS for instance connections, including previously
saved connections. Test that an HTTP instance cannot receive cookies or tokens.
The popup and Settings disclose cookie transmission and default automatic sync.

References checked October 22, 2026:

- [Privacy practices dashboard](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User data policy](https://developer.chrome.com/docs/webstore/program-policies/user-data)
- [Secure transmission](https://developer.chrome.com/docs/webstore/program-policies/secure-transmission)
