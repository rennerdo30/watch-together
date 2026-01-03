import json
import os
import time
from typing import Dict, List
from fastapi import WebSocket

DATA_FILE = "data/rooms.json"

class ConnectionManager:
    def __init__(self):
        # Map room_id -> List of WebSockets (volatile)
        self.active_connections: Dict[str, List[WebSocket]] = {}
        # Map room_id -> current room state (persistent)
        self.room_states: Dict[str, dict] = self._load_states()

    def promote_user(self, room_id: str, requester_email: str, target_email: str, new_role: str) -> bool:
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
        self._save_states()
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

    def _load_states(self) -> dict:
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r") as f:
                    states = json.load(f)
                    # Initialize last_sync_time for loaded states
                    for rid in states:
                        states[rid]["last_sync_time"] = time.time()
                    return states
            except Exception as e:
                print(f"Error loading states: {e}")
        return {}

    def _save_states(self):
        try:
            # We don't save volatile bits like 'members' or 'last_sync_time' to disk as they are runtime-based
            serializable_states = {}
            now = time.time()
            for rid, state in self.room_states.items():
                # Calculate current timestamp based on elapsed time if playing
                saved_timestamp = state.get("timestamp", 0)
                if state.get("is_playing") and state.get("video_data"):
                    is_live = state["video_data"].get("is_live", False)
                    if not is_live:
                        elapsed = now - state.get("last_sync_time", now)
                        saved_timestamp = saved_timestamp + elapsed
                
                serializable_states[rid] = {
                    "video_data": state.get("video_data"),
                    "is_playing": state.get("is_playing", False),
                    "timestamp": saved_timestamp,
                    "queue": state.get("queue", []),
                    "playing_index": state.get("playing_index", -1),
                    "playing_index": state.get("playing_index", -1),
                    "roles": state.get("roles", {}),
                    "saved_at": now  # Track when this was saved for accurate resume
                }
            
            with open(DATA_FILE, "w") as f:
                json.dump(serializable_states, f)
        except Exception as e:
            print(f"Error saving states: {e}")

    def get_sync_payload(self, room_id: str) -> dict:
        """Returns the current state, adjusting timestamp for elapsed time if playing."""
        if room_id not in self.room_states:
            return {}
        
        state = self.room_states[room_id].copy()
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
                "members": [],
                "queue": [],
                "roles": {},
                "playing_index": -1
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
        self._save_states()

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

    def disconnect(self, websocket: WebSocket, room_id: str):
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
                    self._save_states()  # Save state before potential cleanup
    
    def cleanup_stale_rooms(self, ttl_seconds: int = 300):
        """Remove room states that have been empty for longer than TTL (default 5 min)."""
        now = time.time()
        stale_rooms = []
        for rid, state in self.room_states.items():
            empty_since = state.get("empty_since")
            if empty_since and (now - empty_since) > ttl_seconds:
                # No one has reconnected within TTL
                if rid not in self.active_connections or not self.active_connections[rid]:
                    stale_rooms.append(rid)
        
        for rid in stale_rooms:
            del self.room_states[rid]
            print(f"Cleaned up stale room: {rid}")
        
        if stale_rooms:
            self._save_states()
    
    async def disconnect_and_notify(self, websocket: WebSocket, room_id: str):
        self.disconnect(websocket, room_id)
        if room_id in self.room_states:
             await self.broadcast({
                "type": "user_left",
                "payload": {"members": self.room_states[room_id]["members"]}
             }, room_id) 

    async def broadcast(self, message: dict, room_id: str, exclude: WebSocket = None):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                if connection != exclude:
                    try:
                        await connection.send_json(message)
                    except Exception:
                        pass

    def update_state(self, room_id: str, updates: dict):
        if room_id in self.room_states:
            self.room_states[room_id].update(updates)
            # Always update last_sync_time when state changes
            self.room_states[room_id]["last_sync_time"] = time.time()
            self._save_states()

    def add_to_queue(self, room_id: str, video_data: dict):
        if room_id in self.room_states:
            self.room_states[room_id]["queue"].append(video_data)
            self._save_states()
            return self.room_states[room_id]["queue"]
        return []

    def prepend_to_queue(self, room_id: str, video_data: dict):
        """Adds a video to the front of the queue."""
        if room_id in self.room_states:
            state = self.room_states[room_id]
            state["queue"].insert(0, video_data)
            state["playing_index"] = 0
            state["video_data"] = video_data
            state["timestamp"] = 0
            state["is_playing"] = True
            state["last_sync_time"] = time.time()
            self._save_states()
            return video_data, state["queue"], 0
        return None, [], -1

    def remove_from_queue(self, room_id: str, index: int):
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

                self._save_states()
            return queue
        return []

    def reorder_queue(self, room_id: str, old_index: int, new_index: int):
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

                self._save_states()
            return queue
        return []

    def next_video(self, room_id: str):
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
                self._save_states()
                return next_v, queue, next_index
            else:
                # No more videos in queue
                state["video_data"] = None
                state["is_playing"] = False
                state["playing_index"] = -1
                state["last_sync_time"] = time.time()
                self._save_states()
                return None, queue, -1
        return None, [], -1

    def toggle_pin(self, room_id: str, index: int):
        """Toggle the pinned status of a queue item."""
        if room_id in self.room_states:
            queue = self.room_states[room_id]["queue"]
            if 0 <= index < len(queue):
                queue[index]["pinned"] = not queue[index].get("pinned", False)
                self._save_states()
            return queue
        return []

    def play_from_queue(self, room_id: str, index: int):
        """Play a specific item from queue - keeps it in queue until finished."""
        if room_id in self.room_states:
            state = self.room_states[room_id]
            queue = state["queue"]
            old_playing_index = state.get("playing_index", -1)

            # Remove previously playing video if it was in queue and not pinned
            if old_playing_index >= 0 and old_playing_index < len(queue):
                if not queue[old_playing_index].get("pinned", False):
                    queue.pop(old_playing_index)
                    # Adjust target index if it was after the removed item
                    if index > old_playing_index:
                        index -= 1

            if 0 <= index < len(queue):
                target_v = queue[index]
                state["video_data"] = target_v
                state["timestamp"] = 0
                state["last_sync_time"] = time.time()
                state["is_playing"] = True
                state["playing_index"] = index
                self._save_states()
                return target_v, queue, index
        return None, [], -1

manager = ConnectionManager()
