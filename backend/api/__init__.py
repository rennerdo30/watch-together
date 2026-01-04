"""
API routes module.
"""
from api.routes.cookies import router as cookies_router
from api.routes.rooms import router as rooms_router

__all__ = ["cookies_router", "rooms_router"]
