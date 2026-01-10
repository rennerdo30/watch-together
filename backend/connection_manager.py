import json
import os
import time
import asyncio
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)
from fastapi import WebSocket
from services.database import save_room, get_all_rooms, delete_room

class ConnectionManager:
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

    def get_active_rooms(self) -> List[dict]:
        rooms = []
        for rid, state in self.room_states.items():
            # Only show rooms that either have active connections OR have a queue/video
            active_count = len(self.active_connections.get(rid, []))
            if active_count > 0 or state.get("video_data") or state.get("queue"):
                rooms.append({
                    "id": rid,
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
            if state.get("is_playing") and state.get("video_data"):
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
        if state.get("is_playing") and state.get("video_data"):
            is_live = state["video_data"].get("is_live", False)
            if not is_live:
                elapsed = time.time() - state.get("last_sync_time", time.time())
                state["timestamp"] = state.get("timestamp", 0) + elapsed

        # Don't send internal tracking info to clients
        state.pop("last_sync_time", None)
        return state

    async def connect(self, websocket: WebSocket, room_id: str, user_email: str):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
            
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
                "permanent": False
            }
        
        # Ensure 'members' and 'last_sync_time' exist in state
        if "members" not in self.room_states[room_id]:
            self.room_states[room_id]["members"] = []
        if "last_sync_time" not in self.room_states[room_id]:
            self.room_states[room_id]["last_sync_time"] = time.time()
        # Clear empty_since flag since someone has rejoined
        if "empty_since" in self.room_states[room_id]:
            del self.room_states[room_id]["empty_since"]

        # Assign role if needed
        current_roles = self.room_states[room_id].get("roles", {})
        if not current_roles:
            # First user becomes admin
            current_roles[user_email] = "admin"
        elif user_email not in current_roles:
            # Default to user
            current_roles[user_email] = "user"
        
        self.room_states[room_id]["roles"] = current_roles
        await self._save_room_state(room_id)

        self.active_connections[room_id].append(websocket)
        setattr(websocket, "user_email", user_email)
        
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

        for rid in stale_rooms:
            # Re-check before deletion to avoid TOCTOU race
            if rid not in self.active_connections or not self.active_connections[rid]:
                if rid in self.room_states:
                    del self.room_states[rid]
                if rid in self._room_locks:
                    del self._room_locks[rid]
                await delete_room(rid)
                logger.info(f"Cleaned up stale room: {rid}")
    
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

    async def add_to_queue(self, room_id: str, video_data: dict):
        if room_id in self.room_states:
            self.room_states[room_id]["queue"].append(video_data)
            await self._save_room_state(room_id)
            return self.room_states[room_id]["queue"]
        return []

    async def prepend_to_queue(self, room_id: str, video_data: dict):
        """Adds a video to the front of the queue."""
        if room_id in self.room_states:
            state = self.room_states[room_id]
            state["queue"].insert(0, video_data)
            state["playing_index"] = 0
            state["video_data"] = video_data
            state["timestamp"] = 0
            state["is_playing"] = True
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

    async def next_video(self, room_id: str):
        """Called when video ends - remove finished video (unless pinned), play next if available."""
        if room_id in self.room_states:
            state = self.room_states[room_id]
            queue = state["queue"]
            playing_index = state.get("playing_index", -1)

            # Check if the finished video is pinned
            was_pinned = False
            if playing_index >= 0 and playing_index < len(queue):
                was_pinned = queue[playing_index].get("pinned", False)
                if not was_pinned:
                    # Remove the finished video from queue only if not pinned
                    queue.pop(playing_index)

            # Calculate next index
            if was_pinned:
                # If pinned, move to next item
                next_index = playing_index + 1 if playing_index + 1 < len(queue) else 0
            else:
                # If removed, next item is now at same index
                next_index = min(playing_index, len(queue) - 1) if queue else -1

            if queue and next_index >= 0:
                next_v = queue[next_index]
                state["video_data"] = next_v
                state["timestamp"] = 0
                state["last_sync_time"] = time.time()
                state["is_playing"] = True
                state["playing_index"] = next_index
                await self._save_room_state(room_id)
                return next_v, queue, next_index
            else:
                # No more videos in queue
                state["video_data"] = None
                state["is_playing"] = False
                state["playing_index"] = -1
                state["last_sync_time"] = time.time()
                await self._save_room_state(room_id)
                return None, queue, -1
        return None, [], -1

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
                state["playing_index"] = index
                await self._save_room_state(room_id)
                return target_v, queue, index
        return None, [], -1

manager = ConnectionManager()
