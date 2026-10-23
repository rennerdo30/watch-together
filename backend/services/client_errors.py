"""Bounded client diagnostics, admin-only in memory and redacted in host logs."""
import json
import logging
import re
import time
from collections import OrderedDict, deque
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


def safe_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.hostname:
            return '[redacted]'
        return urlunsplit((parts.scheme, parts.hostname, parts.path, '', ''))[:500]
    except ValueError:
        return '[redacted]'


def redact(value: str) -> str:
    value = re.sub(r'https?://[^\s<>"\']+', lambda m: safe_url(m[0]), value)
    value = re.sub(r'(?i)(bearer\s+)\S+', r'\1[redacted]', value)
    value = re.sub(r'(?i)((?:token|signature|cookie|authorization|password|secret|key)\s*[=:]\s*)[^\s,;]+', r'\1[redacted]', value)
    return ''.join(c if c >= ' ' or c == '\n' else ' ' for c in value)


class ClientError(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    source: Literal['shaka', 'hls', 'media', 'runtime', 'promise', 'react']
    message: str = Field(min_length=1, max_length=2000)
    room: str = Field(default='', max_length=100, pattern=r'^[\w-]*$')
    code: int | None = Field(default=None, ge=0, le=100000)
    http_status: int | None = Field(default=None, ge=100, le=599)
    resource: str = Field(default='', max_length=2000)
    stack: str = Field(default='', max_length=4000)
    user_agent: str = Field(default='', max_length=500)


class ClientErrors:
    def __init__(self):
        self.events = deque(maxlen=500)
        self.rates = OrderedDict()

    def reset(self):
        self.events.clear()
        self.rates.clear()

    def record(self, member: str, report: ClientError) -> bool:
        now = time.time()
        started, count = self.rates.pop(member, (now, 0))
        if now - started >= 60:
            started, count = now, 0
        self.rates[member] = (started, count + 1)
        while len(self.rates) > 2000:
            self.rates.popitem(last=False)
        if count >= 20:
            return False
        data = report.model_dump()
        for key in ('message', 'stack', 'user_agent'):
            data[key] = redact(data[key])
        data['resource'] = safe_url(data['resource']) if data['resource'] else ''
        data['member'] = member
        for event in reversed(self.events):
            if now - event['at'] > 30:
                break
            if all(event[key] == value for key, value in data.items()):
                event['count'] += 1
                event['last_at'] = now
                return True
        event = {**data, 'at': now, 'last_at': now, 'count': 1}
        self.events.append(event)
        logger.warning('Client error: %s', json.dumps(event, ensure_ascii=True))
        return True

    def snapshot(self):
        return [dict(event) for event in self.events]


history = ClientErrors()
