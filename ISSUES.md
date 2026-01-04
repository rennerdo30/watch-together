# Issues & Roadmap Tracker

## Active Issues (Bugs & Tech Debt)

### Tech Debt
- [ ] **[BACKEND] Refactor main.py**: Split into modules (api, core, services, tasks) for better maintainability.
- [ ] **[BACKEND] Database Migration**: Replace JSON-based persistence in `ConnectionManager` with a robust database (e.g., SQLite).
- [ ] **[BACKEND] Cache Request Deduplication**: Implement a tracker to prevent concurrent downloads of the same segment URL.
- [ ] **[BACKEND] Proxy Cookie Isolation**: Ensure HLS segment proxy uses user-specific cookies when available.
- [ ] **[FRONTEND] Component Decomposition**: Break down `RoomPage` and `CustomPlayer` into smaller, focused components.
- [ ] **[FRONTEND] Sync Hook Extraction**: Move WebSocket logic into a custom `useRoomSync` hook.
- [ ] **[FRONTEND] Normalization Hook**: Move Web Audio compressor logic into a dedicated `useNormalization` hook.
- [ ] **[SECURITY] Non-Root Containers**: Update Dockerfiles to run backend/frontend services as non-root users.

## Resolved

Resolved issues are now tracked in [CHANGELOG.md](CHANGELOG.md).

## Planned Features

- [x] **Drag-and-Drop Queue**: Improved native DnD with handles and visual cues.
