# Issues & Roadmap Tracker

## Active Issues (Bugs & Tech Debt)

### Tech Debt
- [x] **[BACKEND] Module Extraction**: Split `main.py` into modular structure with `core/`, `services/`, and `api/routes/`.
- [ ] **[BACKEND] Database Migration**: Replace JSON file persistence with SQLite for room state management.
- [x] **[BACKEND] Cache Request Deduplication**: Implement a tracker to prevent concurrent downloads of the same segment URL.
- [ ] **[BACKEND] Proxy Cookie Isolation**: Ensure HLS segment proxy uses user-specific cookies when available.
- [x] **[FRONTEND] Component Decomposition**: Break down `RoomPage` and `CustomPlayer` into smaller, focused components.
- [x] **[FRONTEND] Sync Hook Extraction**: Move WebSocket logic into a custom `useRoomSync` hook.
- [x] **[FRONTEND] Settings Hook Extraction**: Move settings/theme logic into a custom `useRoomSettings` hook.
- [x] **[SECURITY] Non-Root Containers**: Update Dockerfiles to run backend/frontend services as non-root users.

## Resolved

Resolved issues are now tracked in [CHANGELOG.md](CHANGELOG.md).

## Planned Features

- [x] **Drag-and-Drop Queue**: Improved native DnD with handles and visual cues.
