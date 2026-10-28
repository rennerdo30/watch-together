---
title: Browser extension
description: Install the extension and control which sessions it shares with your instance.
---

The Watch Together Cookie Sync extension sends cookies from configured video
sites to a connected Watch Together instance. Cookies include login sessions:
only connect to an instance operator you trust. Read the
[privacy policy](../../privacy/) before connecting.

## Install

### Chrome and Edge

Install [Watch Together Cookie Sync from the Chrome Web Store](https://chromewebstore.google.com/detail/watch-together-cookie-syn/beonlkadfoclpnfigngknbjfoifibagn).
The same link is available in a room's Settings. Store-managed installations
receive browser updates automatically; no Developer mode or unpacked folder is needed.

### Development builds

For extension development, download the Chrome ZIP from the project's
[nightly release](https://github.com/rennerdo30/watch-together/releases/tag/nightly),
extract it into a permanent folder, enable **Developer mode** in
`chrome://extensions` or `edge://extensions`, and choose **Load unpacked**.
Select the folder containing `manifest.json`. Keep the folder in place and reload
the extension after replacing its files with a newer development build.

### Firefox

For a temporary development installation, extract the Firefox ZIP, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
select its `manifest.json`. Firefox temporary add-ons need to be loaded again
after a browser restart.

## Connect

1. Sign in to your **HTTPS** Watch Together instance in the browser.
2. Open the extension popup on that instance and choose **Connect this site**.
3. Approve the browser's permission request for that instance.
4. Confirm the account shown in the popup or extension Settings is yours.
5. Sign in to the video sites you want to use, then choose **Sync now**.

The extension verifies the instance account before syncing. HTTP instances are
rejected to protect cookies and authentication tokens in transit.

## Automatic sync and domains

Automatic sync is on by default and runs about every ten minutes while the
browser is running. It can also refresh on connection, startup or return to an
active browser. Turn **Auto-sync** off in the popup or Settings to use manual
sync instead.

Settings lists the cookie domains. Add or remove domains there and approve any
additional browser permission requests. Domain choices and other portable
preferences can synchronize through your browser account; the instance token
stays in local extension storage.

## Disconnect and delete synced cookies

Use **Reset** in extension Settings to clear the connection and preferences. It
also attempts to revoke the server token and delete the account's synced
cookies. The instance must be reachable for that request to succeed. You can
also delete synced cookies in the Watch Together account's cookie controls.

Turning off sync or uninstalling stops future syncing; the server's existing
copy expires 30 minutes after its last refresh. These actions do not log you out
of the original video sites or erase their watch history.

## Connection problems

- Sign in to the instance and reconnect if the account has changed or signed out.
- Check that the instance uses HTTPS and that its browser permission is granted.
- Open the original video site and confirm you are signed in before syncing.
- Check the displayed sync status. A stopped browser cannot keep cookies fresh.
- Ask the instance operator about server-side failures. Do not attach cookie
  values or authentication tokens to a support request.
