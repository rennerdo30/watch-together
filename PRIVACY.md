# Watch Together Cookie Sync — Privacy Policy

Last updated: October 22, 2026

This policy covers the Watch Together Cookie Sync browser extension and the
Watch Together server features that receive its data. Contact the extension's
maintainer at [support@renner.dev](mailto:support@renner.dev). Watch Together can
be self-hosted: the operator of the instance you connect to controls that server
and its infrastructure. Only connect to an operator you trust with your login
sessions. Contact that operator for requests about data on their instance.

## What the extension accesses and why

- **Cookies, including authentication cookies:** The extension reads cookies
  for the domains configured in Settings, including cookie names, values, domains,
  paths, expiry dates and secure flags. Defaults are YouTube, Twitch, Kick,
  Vimeo, Dailymotion and Crunchyroll. These cookies can grant access to your
  signed-in accounts. They are sent to your connected instance to resolve and
  fetch videos using your existing website sessions. The extension does not
  read password fields or your browser's saved-password database.
- **Connection and account information:** The extension obtains an instance
  address, an authentication token and the account email verified by that
  instance to authenticate requests and show which account is connected.
- **Tabs and video URLs:** The extension reads the active tab URL for connection
  and send-to-room actions. On permitted video sites it observes network request
  URLs to detect HLS/DASH streams, recording a tab ID, stream URL, source origin
  or page URL, stream type and detection time. Sending a video transmits its URL
  and any supplied source page URL to the instance for resolution. URLs may
  contain access tokens or other private query parameters. It also checks open
  tabs on the connected instance and keeps room tabs from being discarded so
  synchronization continues in the background. It does not read your browser's
  stored browsing history.
- **Preferences and operational state:** Domain choices, automatic-sync setting,
  last room ID, last-sync time/status, update availability and the most recently
  resolved video are stored to provide the extension's controls. Browser
  idle/active events can trigger a refresh of cookies when you return.

Once connected, automatic cookie sync is enabled by default and runs about every
10 minutes while the browser is running. Connection, startup and returning to
an active browser can also trigger a sync. You can turn automatic sync off or
sync manually. Additional domains and instance origins require browser site
permission where the browser supports optional permissions.

## Recipients and use

Cookie sync and video-resolution requests go to the Watch Together instance you
connect to. That server uses the relevant cookies when contacting video sites
and media hosts to resolve and play content. **Your session can also help other
members of your room watch individual YouTube, Twitch or Kick videos**, including
for up to 30 minutes after you leave the room if your cookies remain current.
Raw cookie values are not sent to room members by the application. Video details
and playback state used in a room can be visible to its participants.

If you separately enable **YouTube watch history** in Watch Together, the server
uses your synced YouTube session to report watched videos and playback progress
to YouTube. This setting is off by default.

The extension includes no advertising or analytics service. Personal data is not
sold, used for advertising, creditworthiness or lending decisions, or transferred
for purposes unrelated to the features described here. The instance operator and
their hosting, network and authentication providers process requests needed to
operate that instance, including ordinary connection metadata such as IP
addresses. Their infrastructure and logging practices are controlled by that
operator. Browser account synchronization is handled by the browser provider
under its own privacy terms.

## Storage, retention and security

- The active instance address and bearer token are held in extension storage
  locally on your device, not in browser account sync. Local operational data
  includes last-sync status, update information and the last resolved video.
  These records persist until removed, reset or the extension is uninstalled;
  some are overwritten by later actions.
- Portable preferences (domains, automatic sync and last room ID) use
  `chrome.storage.sync` and may synchronize to other browsers signed into your
  browser account. Authentication credentials are not stored there.
- Detected streams and protected-tab records use browser session storage.
  Stream records are removed when their tab closes or by periodic cleanup after
  they are more than one hour old; session storage is cleared when the browser
  session ends.
- The server holds synced cookies in process memory and treats them as expired
  **30 minutes** after their last refresh. They are not saved to its database or
  a persistent cookie file. Video extraction temporarily creates a private cookie
  file, normally in RAM-backed storage on Linux; elsewhere it can use the system
  temporary directory. The file is removed after extraction. Server restart also
  clears the in-memory cookie store. Expired entries are removed during cleanup
  or access, rather than promising an exact physical-memory erasure time.
- Other server records, such as authentication tokens, resolved-video caches and
  room data, have separate lifetimes. Removing cookies does not delete every
  server record or infrastructure log. Ask your instance operator about deletion
  and their deployment's retention and backups.

The extension requires an HTTPS instance to encrypt requests in transit. HTTP
instance connections are rejected, including connections saved by older builds.

## Your controls and deletion

You can remove cookie domains, revoke browser site permissions, disable automatic
sync, or uninstall the extension to stop further collection. Disabling sync or
uninstalling does not immediately revoke data already sent to the server.

**Reset** in extension Settings attempts to revoke the active server token and
delete that account's synced cookies, then clears the local connection and
preferences. If the server is unreachable, revocation cannot be guaranteed; its
cookie copy still expires after the last refresh. You can also delete synced
cookies in the connected Watch Together account's cookie controls. Resetting or
uninstalling does not delete cookies from the original video sites or erase
YouTube watch history. Manage those directly with the relevant site.

For privacy questions or deletion requests concerning the maintainer's instance,
email [support@renner.dev](mailto:support@renner.dev). For another self-hosted
instance, contact its operator. Do not send cookie values or authentication
tokens in support requests.

## Limited Use and policy changes

Watch Together Cookie Sync's use of user data adheres to the Chrome Web Store
User Data Policy, including its Limited Use requirements. Data is used only to
provide the user-facing features described above, not for unrelated tracking.

Changes to these practices will be reflected in this policy with an updated
date and, where required, additional notice or consent before the changed use.
