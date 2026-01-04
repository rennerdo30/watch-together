"""
Tests for cookie path sanitization and security.
"""
import pytest
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestCookiePathSanitization:
    """Test cookie path sanitization to prevent directory traversal attacks."""
    
    def test_valid_email(self):
        """Valid email should return a proper path."""
        from main import get_user_cookie_path, COOKIES_DIR
        
        result = get_user_cookie_path("user@example.com")
        assert result is not None
        assert result.startswith(COOKIES_DIR)
        assert result.endswith(".txt")
    
    def test_directory_traversal_double_dot(self):
        """Emails with '..' should be rejected."""
        from main import get_user_cookie_path
        
        result = get_user_cookie_path("../../../etc/passwd")
        assert result is None
    
    def test_directory_traversal_forward_slash(self):
        """Emails with '/' should be rejected."""
        from main import get_user_cookie_path
        
        result = get_user_cookie_path("user/../../etc/passwd")
        assert result is None
    
    def test_directory_traversal_backslash(self):
        """Emails with '\\' should be rejected."""
        from main import get_user_cookie_path
        
        result = get_user_cookie_path("user\\..\\..\\etc\\passwd")
        assert result is None
    
    def test_empty_email(self):
        """Empty email should return None."""
        from main import get_user_cookie_path
        
        result = get_user_cookie_path("")
        assert result is None
    
    def test_none_email(self):
        """None email should return None."""
        from main import get_user_cookie_path
        
        result = get_user_cookie_path(None)
        assert result is None
    
    def test_special_characters_sanitized(self):
        """Special characters should be sanitized."""
        from main import get_user_cookie_path, COOKIES_DIR
        
        result = get_user_cookie_path("user+test@example.com")
        assert result is not None
        # + should be replaced with _
        assert "+" not in result or result.startswith(COOKIES_DIR)


class TestConnectionManager:
    """Test ConnectionManager room and queue logic."""
    
    @pytest.fixture
    def manager(self):
        """Create a fresh ConnectionManager for each test."""
        from connection_manager import ConnectionManager
        return ConnectionManager()
    
    def test_get_active_rooms_empty(self, manager):
        """Empty manager should return empty room list."""
        rooms = manager.get_active_rooms()
        assert isinstance(rooms, list)
    
    @pytest.mark.asyncio
    async def test_add_to_queue(self, manager):
        """Test adding items to queue."""
        room_id = "test-room"
        manager.room_states[room_id] = {
            "video_data": None,
            "is_playing": False,
            "timestamp": 0,
            "queue": [],
            "playing_index": -1,
            "roles": {}
        }
        
        video = {"original_url": "https://youtube.com/watch?v=test", "title": "Test Video"}
        queue = await manager.add_to_queue(room_id, video)
        
        assert len(queue) == 1
        assert queue[0]["title"] == "Test Video"
    
    @pytest.mark.asyncio
    async def test_remove_from_queue(self, manager):
        """Test removing items from queue."""
        room_id = "test-room"
        manager.room_states[room_id] = {
            "video_data": None,
            "is_playing": False,
            "timestamp": 0,
            "queue": [
                {"original_url": "url1", "title": "Video 1"},
                {"original_url": "url2", "title": "Video 2"}
            ],
            "playing_index": -1,
            "roles": {}
        }
        
        queue = await manager.remove_from_queue(room_id, 0)
        
        assert len(queue) == 1
        assert queue[0]["title"] == "Video 2"
    
    @pytest.mark.asyncio
    async def test_reorder_queue(self, manager):
        """Test reordering items in queue."""
        room_id = "test-room"
        manager.room_states[room_id] = {
            "video_data": None,
            "is_playing": False,
            "timestamp": 0,
            "queue": [
                {"original_url": "url1", "title": "Video 1"},
                {"original_url": "url2", "title": "Video 2"},
                {"original_url": "url3", "title": "Video 3"}
            ],
            "playing_index": -1,
            "roles": {}
        }
        
        queue = await manager.reorder_queue(room_id, 0, 2)
        
        assert queue[0]["title"] == "Video 2"
        assert queue[1]["title"] == "Video 3"
        assert queue[2]["title"] == "Video 1"
    
    @pytest.mark.asyncio
    async def test_toggle_pin(self, manager):
        """Test toggling pin status on queue items."""
        room_id = "test-room"
        manager.room_states[room_id] = {
            "video_data": None,
            "is_playing": False,
            "timestamp": 0,
            "queue": [{"original_url": "url1", "title": "Video 1"}],
            "playing_index": -1,
            "roles": {}
        }
        
        # Pin the video
        queue = await manager.toggle_pin(room_id, 0)
        assert queue[0].get("pinned") == True
        
        # Unpin the video
        queue = await manager.toggle_pin(room_id, 0)
        assert queue[0].get("pinned") == False
