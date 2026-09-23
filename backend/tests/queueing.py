"""Queue a resolved video the way the room does: a placeholder by URL, then its resolve."""


async def enqueue(room, room_id: str, video: dict):
    queue, pending = await room.queue_url(room_id, video["original_url"],
                                          video.get("added_by", "member@example.com"))
    if pending is not None:
        await room.resolve_pending(room_id, video["original_url"], video)
    return queue
