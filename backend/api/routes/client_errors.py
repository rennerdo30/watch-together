"""Authenticated ingestion; reports are visible only through the admin API."""
from fastapi import APIRouter, HTTPException, Request, Response
from core.security import get_user_from_request
from services.client_errors import ClientError, history

router = APIRouter()


@router.post('/api/client-errors', status_code=202)
async def client_error(report: ClientError, request: Request, response: Response):
    member = get_user_from_request(request)
    if not member:
        raise HTTPException(status_code=401, detail='User identity required')
    response.headers['Cache-Control'] = 'private, no-store'
    if not history.record(member, report):
        raise HTTPException(status_code=429, detail='Client error report limit reached',
                            headers={'Retry-After': '60'})
    return {'accepted': True}
