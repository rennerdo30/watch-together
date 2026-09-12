import json
import os
import time
import asyncio
import logging
import uuid
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)
from fastapi import WebSocket
from services.database import save_room, get_all_rooms, delete_room
from services.sponsorblock import SETTINGS_KEY as SPONSORBLOCK_KEY, normalize_settings

class ConnectionManager:
    ACTIVITY_LOG_LIMIT = 200

    def __init__(self):
        # Map room_id -> List of WebSockets (volatile)
        self.active_connections: Dict[str, List[WebSocket]] = {}
        # Map room_id -> current room state (persistent)
        self.room_states: Dict[str, dict] = {}
        # Lock for thread-safe access to room_states
        self._state_lock = asyncio.Lock()
        # Per-room locks for more granular locking
        self._room_locks: Dict[str, asyncio.Lock] = {}

    def _get_room_lock(self, room_id: str) -> asyncio.Lock:
        """Get or create a lock for a specific room."""
        if room_id not in self._room_locks:
            self._room_locks[room_id] = asyncio.Lock()
        return self._room_locks[room_id]

    async def initialize(self):
        """Load room states from database."""
        self.room_states = await get_all_rooms()
        # Initialize runtime fields
        for rid in self.room_states:
            self.room_states[rid]["last_sync_time"] = time.time()
            self.room_states[rid]["members"] = []  # Explicitly reset members on restart
            activity_log = self.room_states[rid].get("activity_log", [])
            self.room_states[rid]["activity_log"] = (
                activity_log[-self.ACTIVITY_LOG_LIMIT:]
                if isinstance(activity_log, list) else []
            )
            self.room_states[rid][SPONSORBLOCK_KEY] = normalize_settings(
                self.room_states[rid].get(SPONSORBLOCK_KEY))
            self._room_locks[rid] = asyncio.Lock()

    async def promote_user(self, room_id: str, requester_email: str, target_email: str, new_role: str) -> bool:
        if room_id not in self.room_states:
            return False
        
        state = self.room_states[room_id]
        current_roles = state.get("roles", {})
        
        # Check permissions
        requester_role = current_roles.get(requester_email)
        if requester_role != "admin":
            return False
            
        if new_role not in ["admin", "moderator", "user"]:
            return False
            
        # Update role
        current_roles[target_email] = new_role
        state["roles"] = current_roles
        await self._save_room_state(room_id)
        return True

    async def toggle_permanent(self, room_id: str, requester_email: str) -> bool:
        """Toggle the permanent status of a room. Only admins can do this."""
        if room_id not in self.room_states:
            return False
        
        state = self.room_states[room_id]
        current_roles = state.get("roles", {})
        
        # Check permissions - only admin can toggle
        requester_role = current_roles.get(requester_email)
        if requester_role != "admin":
            return False
        
        # Toggle permanent status
        state["permanent"] = not state.get("permanent", False)
        await self._save_room_state(room_id)
        logger.info(f"Room {room_id} permanent status: {state['permanent']}")
        return True

    # A display name is free text shown in headers and lists; the length cap
    # keeps it a label rather than a message board.
    ROOM_NAME_MAX_LENGTH = 60

    async def rename_room(self, room_id: str, requester_email: str, name) -> bool:
        """Set a room's display name. Only admins can rename.

        The id stays the address — links, persistence and reconnects all key
        on it — so renaming changes what people see, never where they go.
        """
        if room_id not in self.room_states or not isinstance(name, str):
            return False

        state = self.room_states[room_id]
        if state.get("roles", {}).get(requester_email) != "admin":
            return False

        state["name"] = name.strip()[: self.ROOM_NAME_MAX_LENGTH]
        await self._save_room_state(room_id)
        logger.info(f"Room {room_id} renamed to {state['name']!r}")
        return True

    async def set_sponsorblock(self, room_id: str, requester_email: str, settings) -> Optional[dict]:
        """Set which SponsorBlock segments the room skips. Admins only.

        Returns the normalised settings that were applied, or None when the
        request was refused.
        """
        if room_id not in self.room_states:
            return None
        state = self.room_states[room_id]
        if state.get("roles", {}).get(requester_email) != "admin":
            return None
        applied = normalize_settings(settings)
        state[SPONSORBLOCK_KEY] = applied
        await self._save_room_state(room_id)
        logger.info(f"Room {room_id} SponsorBlock settings: {applied}")
        return applied

    def get_active_rooms(self) -> List[dict]:
        rooms = []
        for rid, state in self.room_states.items():
            # Only show rooms that either have active connections OR have a queue/video
            active_count = len(self.active_connections.get(rid, []))
            if active_count > 0 or state.get("video_data") or state.get("queue"):
                rooms.append({
                    "id": rid,
                    "name": state.get("name", ""),
                    "active_users": active_count,
                    "current_video": state.get("video_data", {}).get("title") if state.get("video_data") else None,
                    "queue_size": len(state.get("queue", []))
                })
        return rooms

    async def _save_room_state(self, room_id: str):
        """Save a single room's state to the database."""
        if room_id not in self.room_states:
            return
            
        try:
            state = self.room_states[room_id]
            # Calculate current timestamp based on elapsed time if playing
            saved_timestamp = state.get("timestamp", 0)
            if state.get("is_playing") and state.get("video_data") and not state.get("startup_pending"):
                is_live = state["video_data"].get("is_live", False)
                if not is_live:
                    elapsed = time.time() - state.get("last_sync_time", time.time())
                    saved_timestamp = saved_timestamp + elapsed
            
            # Prepare state for saving (using current in-memory state as base)
            state_to_save = state.copy()
            state_to_save["timestamp"] = saved_timestamp
            
            await save_room(room_id, state_to_save)
        except Exception as e:
            logger.error(f"Error saving room {room_id}: {e}")

    def get_sync_payload(self, room_id: str) -> dict:
        """Returns the current state, adjusting timestamp for elapsed time if playing.

        Note: This is a synchronous method for compatibility with the heartbeat task.
        It makes a copy of the state to avoid race conditions with state updates.
        """
        if room_id not in self.room_states:
            return {}

        # Make a deep copy to avoid races
        state = self.room_states[room_id].copy()
        if state.get("video_data"):
            state["video_data"] = state["video_data"].copy()

        # If playing and NOT a livestream, adjust timestamp based on elapsed wall clock time
        if state.get("is_playing") and state.get("video_data") and not state.get("startup_pending"):
            is_live = state["video_data"].get("is_live", False)
            if not is_live:
                elapsed = time.time() - state.get("last_sync_time", time.time())
                state["timestamp"] = state.get("timestamp", 0) + elapsed

        # Don't send internal tracking info to clients
        state.pop("last_sync_time", None)
        state.pop("sponsor_video", None)
        return state

    async def connect(self, websocket: WebSocket, room_id: str, user_email: str,
                      max_per_room: int = 50, max_per_user: int = 10) -> bool:
        """Connect a websocket to a room. Returns False if connection limits exceeded."""
        await websocket.accept()

        # Use state lock for atomic room creation + role assignment + connection limit checks
        async with self._state_lock:
            if room_id not in self.active_connections:
                self.active_connections[room_id] = []

            # Connection limit checks (inside lock to prevent TOCTOU race)
            room_connections = len(self.active_connections.get(room_id, []))
            if room_connections >= max_per_room:
                await websocket.close(code=4001, reason="Room is full")
                return False

            user_connection_count = sum(
                1 for conns in self.active_connections.values()
                for ws in conns if getattr(ws, "user_email", None) == user_email
            )
            if user_connection_count >= max_per_user:
                await websocket.close(code=4002, reason="Too many connections")
                return False

            if room_id not in self.room_states:
                self.room_states[room_id] = {
                    "video_data": None,
                    "is_playing": False,
                    "timestamp": 0,
                    "last_sync_time": time.time(),
                    "members": [],
                    "queue": [],
                    "roles": {},
                    "playing_index": -1,
                    "permanent": False,
                    "name": "",
                    "activity_log": [],
                    SPONSORBLOCK_KEY: normalize_settings(None),
                }

            # Ensure per-room lock exists
            if room_id not in self._room_locks:
                self._room_locks[room_id] = asyncio.Lock()

            # Ensure 'members' and 'last_sync_time' exist in state
            if "members" not in self.room_states[room_id]:
                self.room_states[room_id]["members"] = []
            if "last_sync_time" not in self.room_states[room_id]:
                self.room_states[room_id]["last_sync_time"] = time.time()
            if SPONSORBLOCK_KEY not in self.room_states[room_id]:
                self.room_states[room_id][SPONSORBLOCK_KEY] = normalize_settings(None)
            # Clear empty_since flag since someone has rejoined
            if "empty_since" in self.room_states[room_id]:
                del self.room_states[room_id]["empty_since"]

            # Assign role if needed (atomic with room creation)
            current_roles = self.room_states[room_id].get("roles", {})
            if not current_roles:
                # First user becomes admin
                current_roles[user_email] = "admin"
            elif user_email not in current_roles:
                # Default to user
                current_roles[user_email] = "user"

            self.room_states[room_id]["roles"] = current_roles

            # Append connection inside lock to prevent race condition
            self.active_connections[room_id].append(websocket)
            setattr(websocket, "user_email", user_email)

        await self._save_room_state(room_id)

        # Update members list based on current active connections
        active_emails = [getattr(ws, "user_email", "Guest") for ws in self.active_connections[room_id]]
        self.room_states[room_id]["members"] = [{"email": email} for email in sorted(list(set(active_emails)))]

        # Send adjusted current room state to the new user
        sync_payload = self.get_sync_payload(room_id)
        sync_payload["your_email"] = user_email
        await websocket.send_json({
            "type": "sync",
            "payload": sync_payload
        })

        await self.broadcast({
            "type": "user_joined",
            "payload": {"email": user_email, "members": self.room_states[room_id]["members"]}
        }, room_id)

        return True

    async def disconnect(self, websocket: WebSocket, room_id: str):
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
            
            # Update members list
            active_emails = [getattr(ws, "user_email", "Guest") for ws in self.active_connections[room_id]]
            if room_id in self.room_states:
                self.room_states[room_id]["members"] = [{"email": email} for email in sorted(list(set(active_emails)))]

            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
                # Mark room as empty with timestamp for TTL-based cleanup
                # Room state is kept for 5 minutes to allow quick reconnects
                if room_id in self.room_states:
                    self.room_states[room_id]["empty_since"] = time.time()
                    await self._save_room_state(room_id)  # Save state before potential cleanup
    
    async def cleanup_stale_rooms(self, ttl_seconds: int = 300):
        """Remove room states that have been empty for longer than TTL (default 5 min).
        Permanent rooms are never cleaned up."""
        now = time.time()
        stale_rooms = []
        for rid, state in list(self.room_states.items()):
            # Skip permanent rooms
            if state.get("permanent", False):
                continue
            empty_since = state.get("empty_since")
            if empty_since and (now - empty_since) > ttl_seconds:
                # No one has reconnected within TTL
                if rid not in self.active_connections or not self.active_connections[rid]:
                    stale_rooms.append(rid)

        # Delete stale rooms under _state_lock to prevent TOCTOU with new connections
        async with self._state_lock:
            for rid in stale_rooms:
                if rid not in self.active_connections or not self.active_connections[rid]:
                    if rid in self.room_states:
                        del self.room_states[rid]
                    if rid in self._room_locks:
                        del self._room_locks[rid]
                    await delete_room(rid)
                    logger.info(f"Cleaned up stale room: {rid}")

            # Clean orphan locks for rooms that no longer exist in room_states
            orphan_locks = [rid for rid in self._room_locks if rid not in self.room_states]
            for rid in orphan_locks:
                del self._room_locks[rid]
            if orphan_locks:
                logger.info(f"Cleaned up {len(orphan_locks)} orphan room locks")
    
    async def close_room(self, room_id: str) -> bool:
        """Force-close a room: disconnect everyone, drop its state and row.

        Admin operation. Returns False when no such room exists.
        """
        known = room_id in self.room_states or room_id in self.active_connections
        if not known:
            return False
        # Tell every member first: without an explicit notice a client
        # cannot distinguish this from a network drop, reconnects three
        # seconds later, and resurrects the room the admin just closed.
        await self.broadcast({
            "type": "room_closed",
            "payload": {"message": "This room was closed by an administrator"},
        }, room_id)
        for ws in list(self.active_connections.get(room_id, [])):
            try:
                await ws.close(code=4001, reason="Room closed by an administrator")
            except Exception:
                pass
        self.active_connections.pop(room_id, None)
        async with self._state_lock:
            self.room_states.pop(room_id, None)
            self._room_locks.pop(room_id, None)
        await delete_room(room_id)
        logger.info(f"Room {room_id} force-closed by an administrator")
        return True

    async def disconnect_and_notify(self, websocket: WebSocket, room_id: str):
        await self.disconnect(websocket, room_id)
        if room_id in self.room_states:
             await self.broadcast({
                "type": "user_left",
                "payload": {"members": self.room_states[room_id]["members"]}
             }, room_id) 

    async def broadcast(self, message: dict, room_id: str, exclude: WebSocket = None):
        """Broadcast message to all connections in a room, removing dead connections."""
        if room_id not in self.active_connections:
            return

        dead_connections = []
        for connection in self.active_connections[room_id]:
            if connection != exclude:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.warning(f"Failed to send to connection in room {room_id}: {e}")
                    dead_connections.append(connection)

        # Clean up dead connections and update members list
        if dead_connections:
            for conn in dead_connections:
                try:
                    await self.disconnect(conn, room_id)
                except Exception as e:
                    logger.warning(f"Error cleaning up dead connection: {e}")

            # Notify remaining clients of updated members list after cleanup
            if room_id in self.room_states and room_id in self.active_connections:
                try:
                    # Send updated members list to remaining connections
                    members_update = {
                        "type": "user_left",
                        "payload": {"members": self.room_states[room_id]["members"]}
                    }
                    for connection in self.active_connections[room_id]:
                        try:
                            await connection.send_json(members_update)
                        except Exception:
                            pass  # Don't recursively clean, we already identified dead ones
                except Exception as e:
                    logger.warning(f"Error sending members update: {e}")

    async def update_state(self, room_id: str, updates: dict):
        """Update room state with proper locking and sync time management."""
        if room_id not in self.room_states:
            return

        async with self._get_room_lock(room_id):
            old_state = self.room_states[room_id]
            old_state.update(updates)

            # Only update last_sync_time when playback state changes (play/pause) or timestamp is explicitly set
            # This prevents drift when seeking - the elapsed time calculation should use the original sync time
            if "is_playing" in updates or "timestamp" in updates:
                old_state["last_sync_time"] = time.time()

            await self._save_room_state(room_id)

    async def record_activity(
        self,
        room_id: str,
        action: str,
        actor: Optional[str] = None,
        video: Optional[dict] = None,
        **details,
    ) -> Optional[dict]:
        """Append one bounded, server-authored room activity entry."""
        if room_id not in self.room_states:
            return None

        entry = {
            "id": uuid.uuid4().hex,
            "action": action,
            "actor": actor,
            "created_at": time.time(),
        }
        if video:
            title = video.get("title")
            original_url = video.get("original_url")
            if isinstance(title, str) and title:
                entry["title"] = title[:300]
            if isinstance(original_url, str) and original_url:
                entry["original_url"] = original_url[:2048]

        allowed_details = {
            "position", "target", "role", "name", "enabled", "timestamp"
        }
        entry.update({key: value for key, value in details.items() if key in allowed_details})

        async with self._get_room_lock(room_id):
            state = self.room_states.get(room_id)
            if state is None:
                return None
            activity_log = state.setdefault("activity_log", [])
            activity_log.append(entry)
            del activity_log[:-self.ACTIVITY_LOG_LIMIT]
            await self._save_room_state(room_id)
        return entry

    async def playback_ready(self, room_id: str, original_url: str) -> bool:
        """Start the room clock once the first viewer actually plays the video."""
        async with self._get_room_lock(room_id):
            state = self.room_states.get(room_id, {})
            if (not state.get("startup_pending") or not state.get("is_playing") or
                    (state.get("video_data") or {}).get("original_url") != original_url):
                return False
            state["startup_pending"] = False
            state["last_sync_time"] = time.time()
            await self._save_room_state(room_id)
            return True

    @staticmethod
    def _take_existing(queue: list, video_data: dict) -> Optional[dict]:
        """Remove and return the queue's entry for this video, if it has one.

        A video is identified by its original URL. Keeping one entry per
        video is what lets "play now" and "queue" be repeated without the
        queue filling up with copies that outlive the one that was watched.
        """
        url = video_data.get("original_url")
        if not url:
            return None
        for i, item in enumerate(queue):
            if item.get("original_url") == url:
                return queue.pop(i)
        return None

    async def add_to_queue(self, room_id: str, video_data: dict):
        if room_id in self.room_states:
            state = self.room_states[room_id]
            queue = state["queue"]
            existing = self._take_existing(queue, video_data)
            if existing is not None:
                # Re-queued: the one entry moves to the back and keeps its pin.
                video_data = {**existing, **video_data, "pinned": existing.get("pinned", False)}
            queue.append(video_data)
            self._resync_playing_index(state)
            await self._save_room_state(room_id)
            return queue
        return []

    @staticmethod
    def _resync_playing_index(state: dict) -> None:
        """Point `playing_index` at the entry of the video that is playing."""
        current = (state.get("video_data") or {}).get("original_url")
        if not current:
            state["playing_index"] = -1
            return
        for i, item in enumerate(state["queue"]):
            if item.get("original_url") == current:
                state["playing_index"] = i
                return
        state["playing_index"] = -1

    async def prepend_to_queue(self, room_id: str, video_data: dict):
        """Play a video now: it moves to the front of the queue and starts."""
        if room_id in self.room_states:
            state = self.room_states[room_id]
            existing = self._take_existing(state["queue"], video_data)
            if existing is not None:
                video_data = {**existing, **video_data, "pinned": existing.get("pinned", False)}
            state["queue"].insert(0, video_data)
            state["playing_index"] = 0
            state["video_data"] = video_data
            state["timestamp"] = 0
            state["is_playing"] = True
            state["startup_pending"] = True
            state["last_sync_time"] = time.time()
            await self._save_room_state(room_id)
            return video_data, state["queue"], 0
        return None, [], -1

    async def remove_from_queue(self, room_id: str, index: int):
        if room_id in self.room_states:
            state = self.room_states[room_id]
            queue = state["queue"]
            playing_index = state.get("playing_index", -1)

            if 0 <= index < len(queue):
                # Don't allow removing the currently playing item
                if index == playing_index:
                    return queue

                queue.pop(index)

                # Adjust playing_index if we removed an item before it
                if playing_index > index:
                    state["playing_index"] = playing_index - 1

                await self._save_room_state(room_id)
            return queue
        return []

    async def reorder_queue(self, room_id: str, old_index: int, new_index: int):
        if room_id in self.room_states:
            state = self.room_states[room_id]
            queue = state["queue"]
            playing_index = state.get("playing_index", -1)

            if 0 <= old_index < len(queue) and 0 <= new_index < len(queue):
                item = queue.pop(old_index)
                queue.insert(new_index, item)

                # Update playing_index if the playing item was moved
                if playing_index == old_index:
                    state["playing_index"] = new_index
                elif old_index < playing_index <= new_index:
                    state["playing_index"] = playing_index - 1
                elif new_index <= playing_index < old_index:
                    state["playing_index"] = playing_index + 1

                await self._save_room_state(room_id)
            return queue
        return []

    async def next_video(self, room_id: str, ended_url: Optional[str] = None):
        """A video finished: drop it from the queue (unless pinned) and play the next.

        Every member's player fires `ended` on its own, so this is called
        once per member for one finished video. Only the first call may act:
        the caller says which video ended, and once the room has moved on
        that URL no longer matches, so the stragglers are ignored instead of
        each popping one more video off the queue. A call without a URL (the
        "Play next" button) always advances.

        Returns (next_video, queue, playing_index, advanced).
        """
        if room_id not in self.room_states:
            return None, [], -1, False
        async with self._get_room_lock(room_id):
            state = self.room_states[room_id]
            queue = state["queue"]
            playing_index = state.get("playing_index", -1)
            current = state.get("video_data") or {}

            if ended_url is not None and current.get("original_url") != ended_url:
                logger.info(f"Room {room_id}: ignoring video_ended for {ended_url!r}, "
                            f"playing {current.get('original_url')!r}")
                return current or None, queue, playing_index, False

            self._resync_playing_index(state)
            playing_index = state["playing_index"]

            # Check if the finished video is pinned
            was_pinned = False
            if playing_index >= 0 and playing_index < len(queue):
                was_pinned = queue[playing_index].get("pinned", False)
                if not was_pinned:
                    # Remove the finished video from queue only if not pinned
                    queue.pop(playing_index)

            # Calculate next index. A pinned video stays in the queue but is
            # not replayed: reaching the end of the queue stops the room.
            if was_pinned:
                next_index = playing_index + 1 if playing_index + 1 < len(queue) else -1
            elif not queue:
                next_index = -1
            else:
                # Removed, so the next item now sits at the same index. When
                # the finished video was last, everything left is unwatched
                # and the queue starts over from the front.
                next_index = playing_index if 0 <= playing_index < len(queue) else 0

            if queue and next_index >= 0:
                next_v = queue[next_index]
                state["video_data"] = next_v
                state["timestamp"] = 0
                state["last_sync_time"] = time.time()
                state["is_playing"] = True
                state["startup_pending"] = True
                state["playing_index"] = next_index
                await self._save_room_state(room_id)
                return next_v, queue, next_index, True
            else:
                # No more videos in queue
                state["video_data"] = None
                state["startup_pending"] = False
                state["timestamp"] = 0
                state["is_playing"] = False
                state["playing_index"] = -1
                state["last_sync_time"] = time.time()
                await self._save_room_state(room_id)
                return None, queue, -1, True

    async def toggle_pin(self, room_id: str, index: int):
        """Toggle the pinned status of a queue item."""
        if room_id in self.room_states:
            queue = self.room_states[room_id]["queue"]
            if 0 <= index < len(queue):
                queue[index]["pinned"] = not queue[index].get("pinned", False)
                await self._save_room_state(room_id)
            return queue
        return []

    async def play_from_queue(self, room_id: str, index: int):
        """Play a specific item from queue - keeps it in queue until finished."""
        if room_id in self.room_states:
            state = self.room_states[room_id]
            queue = state["queue"]

            if 0 <= index < len(queue):
                target_v = queue[index]
                state["video_data"] = target_v
                state["timestamp"] = 0
                state["last_sync_time"] = time.time()
                state["is_playing"] = True
                state["startup_pending"] = True
                state["playing_index"] = index
                await self._save_room_state(room_id)
                return target_v, queue, index
        return None, [], -1

manager = ConnectionManager()
