"""
app/modules/tax/source_fetch.py
-------------------------------
The only HTTP client that fetches official tax sources (ZB-TAX-ARCH-001
Phase 8 PR 5). Detection only; nothing it fetches is trusted.

Rules:
  * https only, on the code-defined OFFICIAL_SOURCE_HOSTS (no tenant or user
    input reaches it; a monitor's URL must be on an allowlisted host);
  * DNS rebinding (fix A): the hostname is resolved ONCE per hop and every
    resolved address must be public (not private, loopback, link-local,
    multicast, reserved or unspecified). The connection then goes to that
    validated IP, with the TLS SNI and the Host header set to the hostname,
    so the certificate is still verified for the hostname and no second
    lookup can redirect the connection. Every redirect hop repeats this and
    must stay on the allowlist (at most 3 hops);
  * environment proxies are ignored (trust_env=False), so the pinned address
    is the one connected to. If production must egress through a proxy, that
    proxy has to enforce the same host allowlist (TAX_PHASE8.md);
  * 20-second timeout, 5 MB cap, a User-Agent naming Zoiko with an
    organisational contact URL (TAX_SOURCE_MONITOR_CONTACT_URL), no personal
    data, no credentials.
"""
import ipaddress
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Callable, Optional
from urllib.parse import urljoin

import httpx

from app.config import settings

#: Official sources the monitor may fetch. Changing this list is a reviewed
#: code change; the tax lead confirms it (TAX_PHASE8.md).
OFFICIAL_SOURCE_HOSTS = frozenset({
    "www.gov.uk", "www.legislation.gov.uk", "www.ato.gov.au", "www.legislation.gov.au", "www.canada.ca",
    "www.revenuquebec.ca",
})
REDIRECTS = {301, 302, 303, 307, 308}
MAX_HOPS = 3
UA_TOKEN = "ZoikoBillingTaxMonitor"


class FetchRefused(Exception):
    """The request was not made (or not followed): a policy refusal."""


@dataclass
class FetchResult:
    status: int
    content_type: Optional[str]
    body: bytes
    url: str
    retry_after: Optional[str] = None


def user_agent() -> str:
    contact = getattr(settings, "TAX_SOURCE_MONITOR_CONTACT_URL", "https://zoikobilling.com/tax-source-monitoring")
    return f"{UA_TOKEN}/1.0 (+{contact})"


def check_url(url: str) -> httpx.URL:
    """An allowlisted https URL, or FetchRefused."""
    try:
        parsed = httpx.URL(url)
    except Exception:                                           # noqa: BLE001
        raise FetchRefused("not a valid URL")
    if parsed.scheme != "https":
        raise FetchRefused("only https sources are fetched")
    if parsed.userinfo:
        raise FetchRefused("URLs with credentials are refused")
    if parsed.port not in (None, 443):
        raise FetchRefused("only the standard https port is allowed")
    if (parsed.host or "").lower() not in OFFICIAL_SOURCE_HOSTS:
        raise FetchRefused(f"{parsed.host} is not an allowlisted official source host")
    return parsed


def system_resolver(host: str) -> list:
    return sorted({info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})


def public_addresses(host: str, resolver: Callable) -> list:
    try:
        addresses = resolver(host)
    except OSError as exc:
        raise FetchRefused(f"{host} could not be resolved: {exc}")
    if not addresses:
        raise FetchRefused(f"{host} did not resolve")
    for raw in addresses:
        ip = ipaddress.ip_address(str(raw).split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or not ip.is_global):
            raise FetchRefused(f"{host} resolves to a non-public address; refused")
    return list(addresses)


class SafeFetcher:
    def __init__(self, transport: Optional[httpx.BaseTransport] = None, resolver: Optional[Callable] = None,
                 timeout: Optional[float] = None, max_bytes: Optional[int] = None):
        self.transport = transport
        self.resolver = resolver or system_resolver
        self.timeout = timeout or float(getattr(settings, "TAX_SOURCE_FETCH_TIMEOUT_SECONDS", 20))
        self.max_bytes = max_bytes or int(getattr(settings, "TAX_SOURCE_MAX_BYTES", 5 * 1024 * 1024))

    def _one(self, url: httpx.URL) -> tuple:
        """(status, headers, body) for one hop, connected to the validated IP."""
        host = url.host.lower()
        ip = public_addresses(host, self.resolver)[0]               # resolved once, validated, pinned
        pinned = url.copy_with(host=ip)
        headers = {"Host": host, "User-Agent": user_agent(),
                   "Accept": "text/html, application/pdf, text/plain;q=0.9, */*;q=0.5"}
        with httpx.Client(transport=self.transport, timeout=self.timeout, follow_redirects=False,
                          trust_env=False) as client:
            request = client.build_request("GET", pinned, headers=headers, extensions={"sni_hostname": host})
            response = client.send(request, stream=True)
            try:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > self.max_bytes:
                        raise FetchRefused(f"the response is larger than {self.max_bytes} bytes")
                return response.status_code, response.headers, bytes(body)
            finally:
                response.close()

    def get(self, url: str) -> FetchResult:
        current = check_url(url)
        for _ in range(MAX_HOPS + 1):
            status, headers, body = self._one(current)
            if status in REDIRECTS and headers.get("location"):
                current = check_url(urljoin(str(current), headers["location"]))
                continue
            return FetchResult(status=status, content_type=headers.get("content-type"), body=body, url=str(current),
                               retry_after=headers.get("retry-after"))
        raise FetchRefused(f"more than {MAX_HOPS} redirects")


def retry_after_seconds(value: Optional[str], now: datetime) -> int:
    """Retry-After (seconds or an HTTP date), bounded to [60 s, 24 h]."""
    seconds = 3600
    if value:
        value = value.strip()
        if value.isdigit():
            seconds = int(value)
        else:
            try:
                when = parsedate_to_datetime(value)
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
                seconds = int((when - now).total_seconds())
            except (TypeError, ValueError):
                seconds = 3600
    return max(60, min(seconds, 24 * 3600))
