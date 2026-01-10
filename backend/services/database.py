"""
SQLite database service for Watch Together.

Handles persistent storage for:
- Room state (video, queue, roles, permanent flag)
- User cookies

Includes automatic migration from legacy JSON/file storage.
"""
import os
import json
import glob
import sqlite3
import logging
import aiosqlite
from typing import Optional, Dict, List, Any
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)

# Database configuration
DB_DIR = "data"
DB_FILE = os.path.join(DB_DIR, "watchtogether.db")
LEGACY_ROOMS_FILE = os.path.join(DB_DIR, "rooms.json")
LEGACY_COOKIES_DIR = os.path.join(DB_DIR, "cookies")

# Ensure data directory exists
if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)


def get_db_connection() -> sqlite3.Connection:
    """Get a synchronous database connection (for init/migration)."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


@asynccontextmanager
async def get_async_db():
    """Get an async database connection."""
    db = await aiosqlite.connect(DB_FILE)
    db.row_factory = aiosqlite.Row
    try:
        yield db
    finally:
        await db.close()


def init_database():
    """Initialize database schema and run migrations."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Create schema_version table first (for tracking migrations)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at REAL
        )
    """)
    
    # Get current schema version
    cursor.execute("SELECT MAX(version) FROM schema_version")
    row = cursor.fetchone()
    current_version = row[0] if row and row[0] else 0
    
    # Run migrations
    migrations = [
        # Version 1: Initial schema
        """
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            video_data TEXT,
            is_playing INTEGER DEFAULT 0,
            timestamp REAL DEFAULT 0,
            queue TEXT DEFAULT '[]',
            playing_index INTEGER DEFAULT -1,
            roles TEXT DEFAULT '{}',
            permanent INTEGER DEFAULT 0,
            created_at REAL,
            updated_at REAL
        )
        """,
        # Version 2: User cookies
        """
        CREATE TABLE IF NOT EXISTS user_cookies (
            user_email TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            created_at REAL,
            updated_at REAL
        )
        """,
        # Version 3: Format cache
        """
        CREATE TABLE IF NOT EXISTS format_cache (
            original_url TEXT PRIMARY KEY,
            video_data TEXT NOT NULL,
            expires_at REAL,
            created_at REAL
        )
        """,
        # Version 4: API tokens for browser extension
        """
        CREATE TABLE IF NOT EXISTS api_tokens (
            id TEXT PRIMARY KEY,
            user_email TEXT NOT NULL,
            name TEXT DEFAULT 'default',
            created_at REAL,
            last_used_at REAL,
            last_sync_at REAL,
            revoked INTEGER DEFAULT 0,
            sync_count INTEGER DEFAULT 0
        )
        """,
        # Version 5: Index for api_tokens user lookup
        """
        CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_email)
        """,
    ]
    
    import time
    now = time.time()
    
    for i, migration_sql in enumerate(migrations, start=1):
        if i > current_version:
            logger.info(f"Running database migration v{i}...")
            cursor.execute(migration_sql)
            cursor.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (i, now)
            )
            conn.commit()
            logger.info(f"Migration v{i} complete")
    
    conn.close()
    
    logger.info(f"Database initialized: {DB_FILE} (schema v{len(migrations)})")
    
    # Run data migrations from legacy storage
    _migrate_legacy_data()


def _migrate_legacy_data():
    """Migrate data from legacy JSON/file storage to SQLite."""
    _migrate_legacy_rooms()
    _migrate_legacy_cookies()


def _migrate_legacy_rooms():
    """Migrate rooms from legacy rooms.json to SQLite."""
    if not os.path.exists(LEGACY_ROOMS_FILE):
        return
    
    try:
        with open(LEGACY_ROOMS_FILE, 'r') as f:
            legacy_rooms = json.load(f)
        
        if not legacy_rooms:
            return
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        import time
        now = time.time()
        migrated = 0
        
        for room_id, state in legacy_rooms.items():
            # Check if room already exists
            cursor.execute("SELECT id FROM rooms WHERE id = ?", (room_id,))
            if cursor.fetchone():
                continue
            
            cursor.execute("""
                INSERT INTO rooms (id, video_data, is_playing, timestamp, queue, 
                                   playing_index, roles, permanent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                room_id,
                json.dumps(state.get("video_data")),
                1 if state.get("is_playing") else 0,
                state.get("timestamp", 0),
                json.dumps(state.get("queue", [])),
                state.get("playing_index", -1),
                json.dumps(state.get("roles", {})),
                1 if state.get("permanent") else 0,
                state.get("saved_at", now),
                now
            ))
            migrated += 1
        
        conn.commit()
        conn.close()
        
        if migrated > 0:
            logger.info(f"Migrated {migrated} rooms from legacy JSON")
            # Backup the old file
            backup_path = LEGACY_ROOMS_FILE + ".bak"
            os.rename(LEGACY_ROOMS_FILE, backup_path)
            logger.info(f"Legacy rooms.json backed up to {backup_path}")
    
    except Exception as e:
        logger.error(f"Error migrating legacy rooms: {e}")


def _migrate_legacy_cookies():
    """Migrate cookies from legacy filesystem to SQLite."""
    if not os.path.exists(LEGACY_COOKIES_DIR):
        return
    
    cookie_files = glob.glob(os.path.join(LEGACY_COOKIES_DIR, "*.txt"))
    if not cookie_files:
        return
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        import time
        now = time.time()
        migrated = 0
        
        for cookie_file in cookie_files:
            # Extract email from filename (filename is sanitized email + .txt)
            filename = os.path.basename(cookie_file)
            user_email = filename[:-4]  # Remove .txt
            
            # Check if already migrated
            cursor.execute("SELECT user_email FROM user_cookies WHERE user_email = ?", (user_email,))
            if cursor.fetchone():
                continue
            
            with open(cookie_file, 'r') as f:
                content = f.read()
            
            if content.strip():
                cursor.execute("""
                    INSERT INTO user_cookies (user_email, content, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                """, (user_email, content, now, now))
                migrated += 1
        
        conn.commit()
        conn.close()
        
        if migrated > 0:
            logger.info(f"Migrated {migrated} cookie files from legacy filesystem")
            # Backup the directory
            backup_dir = LEGACY_COOKIES_DIR + ".bak"
            if not os.path.exists(backup_dir):
                os.rename(LEGACY_COOKIES_DIR, backup_dir)
                logger.info(f"Legacy cookies directory backed up to {backup_dir}")
    
    except Exception as e:
        logger.error(f"Error migrating legacy cookies: {e}")


# ============================================================================
# Room Operations
# ============================================================================

async def get_room(room_id: str) -> Optional[Dict[str, Any]]:
    """Get room state from database."""
    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT * FROM rooms WHERE id = ?", (room_id,)
        )
        row = await cursor.fetchone()
        
        if not row:
            return None
        
        return {
            "id": row["id"],
            "video_data": json.loads(row["video_data"]) if row["video_data"] else None,
            "is_playing": bool(row["is_playing"]),
            "timestamp": row["timestamp"],
            "queue": json.loads(row["queue"]) if row["queue"] else [],
            "playing_index": row["playing_index"],
            "roles": json.loads(row["roles"]) if row["roles"] else {},
            "permanent": bool(row["permanent"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


async def save_room(room_id: str, state: Dict[str, Any]) -> None:
    """Save room state to database."""
    import time
    now = time.time()
    
    async with get_async_db() as db:
        await db.execute("""
            INSERT INTO rooms (id, video_data, is_playing, timestamp, queue, 
                               playing_index, roles, permanent, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                video_data = excluded.video_data,
                is_playing = excluded.is_playing,
                timestamp = excluded.timestamp,
                queue = excluded.queue,
                playing_index = excluded.playing_index,
                roles = excluded.roles,
                permanent = excluded.permanent,
                updated_at = excluded.updated_at
        """, (
            room_id,
            json.dumps(state.get("video_data")),
            1 if state.get("is_playing") else 0,
            state.get("timestamp", 0),
            json.dumps(state.get("queue", [])),
            state.get("playing_index", -1),
            json.dumps(state.get("roles", {})),
            1 if state.get("permanent") else 0,
            now,
            now
        ))
        await db.commit()


async def delete_room(room_id: str) -> None:
    """Delete room from database."""
    async with get_async_db() as db:
        await db.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        await db.commit()


async def get_all_rooms() -> Dict[str, Dict[str, Any]]:
    """Get all rooms from database."""
    async with get_async_db() as db:
        cursor = await db.execute("SELECT * FROM rooms")
        rows = await cursor.fetchall()
        
        rooms = {}
        for row in rows:
            rooms[row["id"]] = {
                "video_data": json.loads(row["video_data"]) if row["video_data"] else None,
                "is_playing": bool(row["is_playing"]),
                "timestamp": row["timestamp"],
                "queue": json.loads(row["queue"]) if row["queue"] else [],
                "playing_index": row["playing_index"],
                "roles": json.loads(row["roles"]) if row["roles"] else {},
                "permanent": bool(row["permanent"]),
            }
        return rooms


# ============================================================================
# Cookie Operations
# ============================================================================

async def get_user_cookies(user_email: str) -> Optional[str]:
    """Get user cookies from database."""
    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT content FROM user_cookies WHERE user_email = ?", (user_email,)
        )
        row = await cursor.fetchone()
        return row["content"] if row else None


async def save_user_cookies(user_email: str, content: str) -> None:
    """Save user cookies to database."""
    import time
    now = time.time()
    
    async with get_async_db() as db:
        await db.execute("""
            INSERT INTO user_cookies (user_email, content, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_email) DO UPDATE SET
                content = excluded.content,
                updated_at = excluded.updated_at
        """, (user_email, content, now, now))
        await db.commit()


async def delete_user_cookies(user_email: str) -> None:
    """Delete user cookies from database."""
    async with get_async_db() as db:
        await db.execute("DELETE FROM user_cookies WHERE user_email = ?", (user_email,))
        await db.commit()


async def user_has_cookies(user_email: str) -> bool:
    """Check if user has cookies stored."""
    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT 1 FROM user_cookies WHERE user_email = ?", (user_email,)
        )
        return await cursor.fetchone() is not None


# ============================================================================
# Format Cache Operations
# ============================================================================

async def get_cached_format(original_url: str) -> Optional[Dict[str, Any]]:
    """Get cached format if available and not expired."""
    import time
    now = time.time()
    
    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT video_data, expires_at FROM format_cache WHERE original_url = ?",
            (original_url,)
        )
        row = await cursor.fetchone()
        
        if not row:
            return None
        
        # Check if expired
        if row["expires_at"] and now > row["expires_at"]:
            # Expired, delete and return None
            await db.execute("DELETE FROM format_cache WHERE original_url = ?", (original_url,))
            await db.commit()
            logger.info(f"Format cache expired for: {original_url[:60]}...")
            return None
        
        logger.info(f"Format cache HIT for: {original_url[:60]}...")
        return json.loads(row["video_data"])


async def cache_format(original_url: str, video_data: Dict[str, Any], ttl_seconds: int = None) -> None:
    """Cache video format with TTL. Default uses FORMAT_CACHE_TTL_SECONDS from config (2 hours)."""
    from core.config import FORMAT_CACHE_TTL_SECONDS
    if ttl_seconds is None:
        ttl_seconds = FORMAT_CACHE_TTL_SECONDS
    import time
    now = time.time()
    expires_at = now + ttl_seconds
    
    async with get_async_db() as db:
        await db.execute("""
            INSERT INTO format_cache (original_url, video_data, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(original_url) DO UPDATE SET
                video_data = excluded.video_data,
                expires_at = excluded.expires_at
        """, (original_url, json.dumps(video_data), expires_at, now))
        await db.commit()
    
    logger.info(f"Cached format for: {original_url[:60]}... (expires in {ttl_seconds}s)")


async def cleanup_expired_format_cache() -> int:
    """Clean expired format cache entries. Returns count of cleaned entries."""
    import time
    now = time.time()

    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM format_cache WHERE expires_at < ?", (now,)
        )
        row = await cursor.fetchone()
        count = row[0] if row else 0

        if count > 0:
            await db.execute("DELETE FROM format_cache WHERE expires_at < ?", (now,))
            await db.commit()

        return count


# ============================================================================
# API Token Operations (Browser Extension)
# ============================================================================

def generate_token_id() -> str:
    """Generate a unique API token ID."""
    import secrets
    return f"wt_ext_{secrets.token_urlsafe(32)}"


async def create_token(user_email: str, name: str = "default") -> Dict[str, Any]:
    """Create a new API token for user."""
    import time
    now = time.time()
    token_id = generate_token_id()

    async with get_async_db() as db:
        await db.execute("""
            INSERT INTO api_tokens (id, user_email, name, created_at, last_used_at, revoked, sync_count)
            VALUES (?, ?, ?, ?, ?, 0, 0)
        """, (token_id, user_email, name, now, now))
        await db.commit()

    logger.info(f"Created API token for user: {user_email}")
    return {
        "id": token_id,
        "user_email": user_email,
        "name": name,
        "created_at": now,
        "last_used_at": now,
        "last_sync_at": None,
        "revoked": False,
        "sync_count": 0,
    }


async def get_token(token_id: str) -> Optional[Dict[str, Any]]:
    """Get token by ID."""
    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT * FROM api_tokens WHERE id = ? AND revoked = 0", (token_id,)
        )
        row = await cursor.fetchone()

        if not row:
            return None

        return {
            "id": row["id"],
            "user_email": row["user_email"],
            "name": row["name"],
            "created_at": row["created_at"],
            "last_used_at": row["last_used_at"],
            "last_sync_at": row["last_sync_at"],
            "revoked": bool(row["revoked"]),
            "sync_count": row["sync_count"],
        }


async def get_user_token(user_email: str) -> Optional[Dict[str, Any]]:
    """Get active token for user (most recent non-revoked)."""
    async with get_async_db() as db:
        cursor = await db.execute(
            """SELECT * FROM api_tokens
               WHERE user_email = ? AND revoked = 0
               ORDER BY created_at DESC LIMIT 1""",
            (user_email,)
        )
        row = await cursor.fetchone()

        if not row:
            return None

        return {
            "id": row["id"],
            "user_email": row["user_email"],
            "name": row["name"],
            "created_at": row["created_at"],
            "last_used_at": row["last_used_at"],
            "last_sync_at": row["last_sync_at"],
            "revoked": bool(row["revoked"]),
            "sync_count": row["sync_count"],
        }


async def validate_token(token_id: str) -> Optional[str]:
    """Validate token and return user_email if valid. Updates last_used_at."""
    import time
    now = time.time()

    async with get_async_db() as db:
        cursor = await db.execute(
            "SELECT user_email FROM api_tokens WHERE id = ? AND revoked = 0",
            (token_id,)
        )
        row = await cursor.fetchone()

        if not row:
            return None

        # Update last_used_at
        await db.execute(
            "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
            (now, token_id)
        )
        await db.commit()

        return row["user_email"]


async def update_token_sync(token_id: str) -> None:
    """Update token's last_sync_at and increment sync_count."""
    import time
    now = time.time()

    async with get_async_db() as db:
        await db.execute(
            """UPDATE api_tokens
               SET last_sync_at = ?, sync_count = sync_count + 1
               WHERE id = ?""",
            (now, token_id)
        )
        await db.commit()


async def revoke_token(token_id: str) -> bool:
    """Revoke a token. Returns True if token was found and revoked."""
    async with get_async_db() as db:
        cursor = await db.execute(
            "UPDATE api_tokens SET revoked = 1 WHERE id = ? AND revoked = 0",
            (token_id,)
        )
        await db.commit()
        return cursor.rowcount > 0


async def revoke_user_tokens(user_email: str) -> int:
    """Revoke all tokens for a user. Returns count of revoked tokens."""
    async with get_async_db() as db:
        cursor = await db.execute(
            "UPDATE api_tokens SET revoked = 1 WHERE user_email = ? AND revoked = 0",
            (user_email,)
        )
        await db.commit()
        return cursor.rowcount


async def get_or_create_token(user_email: str) -> Dict[str, Any]:
    """Get existing token or create new one for user."""
    token = await get_user_token(user_email)
    if token:
        return token
    return await create_token(user_email)

