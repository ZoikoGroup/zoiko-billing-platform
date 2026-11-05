"""
app/modules/tax/pagination.py
-----------------------------
Additive cursor pagination for the tax list endpoints (Tax Control Center,
backend gap B3).

Contract (every list that uses it):
  * query params: `limit` (optional; default 50, max 200) and `cursor`
    (optional, opaque; the `next_cursor` of the previous page);
  * the response keeps every existing field and adds `next_cursor`, which is
    null on the last page.

The order of each list is unchanged. A cursor names the last item of the
previous page, and the next page continues right after it. A cursor whose
item no longer exists is rejected (400): restart from the first page.
Endpoints that already had a `limit` keep their own default and maximum, so
no existing client changes behaviour.
"""
import base64
import json
from typing import Callable, Optional, Sequence

from fastapi import Query

from app.core.exceptions import BadRequestException

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def encode_cursor(value) -> str:
    raw = json.dumps({"after": value}, separators=(",", ":"), default=str).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(token: Optional[str]):
    if not isinstance(token, str) or not token:          # absent, or a FastAPI default on a direct call
        return None
    try:
        padded = token + "=" * (-len(token) % 4)
        return json.loads(base64.urlsafe_b64decode(padded.encode()))["after"]
    except Exception:
        raise BadRequestException("Invalid cursor: restart from the first page.")


class PageParams:
    def __init__(self, limit: Optional[int] = Query(None, ge=1, le=MAX_LIMIT,
                                                    description=f"Page size (default {DEFAULT_LIMIT}, max {MAX_LIMIT})"),
                 cursor: Optional[str] = Query(None, max_length=512, description="next_cursor of the previous page")):
        self.limit = limit or DEFAULT_LIMIT
        self.cursor = cursor


def paginate(items: Sequence, params: PageParams, key: Callable = lambda item: item.id) -> tuple[list, Optional[str]]:
    """One page of an already-ordered list, continuing after the cursor's item.
    A direct Python call that leaves `page` at its FastAPI default (a
    Depends marker) gets the defaults, so existing in-process callers keep
    working unchanged."""
    if not isinstance(params, PageParams):
        params = PageParams(limit=None, cursor=None)
    items = list(items)
    after = decode_cursor(params.cursor)
    start = 0
    if after is not None:
        keys = [key(item) for item in items]
        if after not in keys:
            raise BadRequestException("The cursor no longer matches an item: restart from the first page.")
        start = keys.index(after) + 1
    page = items[start:start + params.limit]
    has_more = start + params.limit < len(items)
    return page, (encode_cursor(key(page[-1])) if has_more and page else None)
