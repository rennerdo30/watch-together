"""
Room listing API routes.
"""
from fastapi import APIRouter
from connection_manager import manager

router = APIRouter(prefix="/api", tags=["rooms"])


@router.get("/rooms")
def list_rooms():
    """Returns list of active rooms."""
    return manager.get_active_rooms()
