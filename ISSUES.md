# Known Issues & Roadmap

Last verified against the codebase: 2026-08-20.

## Known Issues

### High Priority

#### HTTP/2 Protocol Errors on Video Streaming
- **Status**: Open (root cause not yet identified)
- **Description**: The video proxy occasionally returns `ERR_HTTP2_PROTOCOL_ERROR`
  on 206 Partial Content responses.
- **Investigation so far**: The January HAR capture kept for this issue turned out to
  contain only page-load traffic — 19 entries, no `/api/proxy` requests, no range
  requests and no 206 responses — so it cannot show the failure. Evidence is now
  collected server-side instead: every proxied transfer records host, status, byte
  offset, bytes sent against content-length, upstream latency and how the transfer
  ended. A short transfer against a known length is classified as `truncated`, which
  is what this failure looks like from the client.
- **Next step**: Reproduce, then read `GET /api/metrics/proxy` and check whether
  failures cluster by host, byte offset, or elapsed time. One hypothesis worth
  testing first: signed CDN URLs are IP-bound and expire, so a long transfer may be
  cut off upstream rather than by any layer of ours.
- **Workarounds in place**: `Connection: close` on proxy responses, chunked encoding
  disabled for the video proxy, and 600s nginx timeouts. If it persists, disable
  "HTTP/2 to Origin" in Cloudflare.

### Medium Priority

#### Rate Limiter Is Process-Local
- **Status**: Open (by design for now)
- **Description**: The upload rate limiter counts requests in this process's memory.
  It resets on restart and does not coordinate across replicas.
- **Impact**: None in the supported deployment, which is a single worker. Startup now
  refuses to run with more than one worker, so this cannot silently degrade.
- **Fix if multi-worker deployment is ever wanted**: back the limiter — and room
  state, and the caches — with shared storage.

## Fixed Issues

Verified fixed, each with a test that fails against the old behaviour:

- **Identity Was a Forgeable Header** — the backend trusted
  `Cf-Access-Authenticated-User-Email`, which anyone reaching the origin directly can
  send, and identity selects which user's stored cookies are used. The signed
  `Cf-Access-Jwt-Assertion` is now verified against the team JWKS (signature,
  audience, issuer, expiry). `/api/proxy` and the WebSocket handshake also required no
  identity at all; both do now.
- **SSRF: Trusted-CDN Bypass** — the allowlist returned before any address check, so an
  attacker-controlled subdomain of an allowlisted CDN skipped validation entirely. The
  allowlist is gone; every host is validated.
- **SSRF: Unvalidated Redirects** — the HTTP client followed redirects, so a URL that
  validated as public could bounce to a private address. Redirects are followed by the
  proxy itself with every hop validated.
- **SSRF: DNS Rebinding** — validation and the request each resolved DNS separately. The
  address that passes validation is now the address connected to, with Host and TLS SNI
  preserving the hostname.
- **Cross-User Credential Bleed** — one global cookie jar was sent upstream for every
  user, and cache entries were keyed by URL alone. Cookies are per user and per request,
  and any fetch carrying cookies is cached under a key including the user's identity.
- **Unvalidated Prefetching** — the prefetcher fetched manifest-derived URLs with no
  validation, reachable through any submitted video. It uses the validated path now.
- **A/V Drift by Design** — two media elements cannot be kept frame-accurate. Adaptive
  streams are described by a generated DASH manifest and played through one element via
  MSE. The two-element path, its drift-correction hooks and its engine flag are deleted,
  so there is no second playback path to keep working.
- **Dead WebSocket Hook** — `lib/hooks/useRoomSync.ts` was exported but never imported
  while the room page carried its own copy. The unused hook is deleted.
- **Extension Sync Had No Rate Limit** — the limiter was private to the cookie routes.
  It is shared from `core/` and applied to both, under separate scopes.
- **Cookie Files Were World-Readable** — written with the default umask; now owner-only
  on every path that writes them.
- **In-Flight Cache Lock Race** — results were published outside the lock guarding the
  table. Both writes moved under it.
- **Silent Multi-Worker Corruption** — extra workers each got their own copy of room
  state, splitting rooms in a way that looked like a sync bug. Startup refuses.
- **Connection Limit Race Condition** — limit checks are inside `_state_lock`.
- **Unbounded In-Flight Cache** — bounded with a TTL, cleaned under the lock.
- **Room Lock Memory Leak** — locks are deleted with their rooms and orphans swept.
- **Incomplete Cookie Validation** — every data line is validated.
- **WebSocket Message Validation** — type checked, length capped, frames capped.
- **Sidebar Resize Race / useDashSync Interval Collision** — stable callbacks; the old
  interval is cleared before a new one is created.

## Tech Debt

### Completed
- [x] Module extraction, component decomposition, hook extraction
- [x] Non-root containers, image pinning, resource limits, nginx security headers
- [x] Cache request deduplication and bounded in-flight tracking
- [x] Security hardening: Access JWT verification, SSRF closure, per-user cookies,
      connection limits, shared rate limiting, cookie file permissions
- [x] **Test coverage for critical paths** — 195 backend tests covering SSRF, upstream
      pinning and redirects, Access JWT verification, connection limits under
      concurrency, WebSocket sync, cookie isolation, manifest generation and hardening
- [x] **End-to-end tests** — Playwright covers two-client room sync through the real UI
      and MSE playback of a generated manifest in a real browser
- [x] Test isolation from the real data directory; CI runs on the production Python
- [x] DASH manifest generation and single-element MSE playback

### Pending
- [ ] **HTTP/2 streaming root cause** — reproduce and read the new proxy metrics
- [ ] **Encrypt cookies at rest** — currently plaintext files with owner-only permissions
- [ ] **Make the shared-cookie fallback opt-in** — resolution deliberately falls back to
      another user's cookies, which should be a visible setting rather than a default

## Reporting Issues

Please use GitHub Issues to report bugs or request features:

1. **Bug Reports**:
   - Clear description of the issue
   - Steps to reproduce
   - Expected vs actual behavior
   - Browser and OS version
   - Console errors (F12 → Console)

2. **Feature Requests**:
   - Description of the feature
   - Use case / why it's needed
   - Any implementation ideas

3. **Questions**:
   - Check existing issues first
   - Include relevant context
