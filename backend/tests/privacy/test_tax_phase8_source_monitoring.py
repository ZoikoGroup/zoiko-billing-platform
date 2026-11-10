"""ZB-TAX-ARCH-001 Phase 8 PR 5: source change detection and review cadence.
No network: an httpx MockTransport and a fake resolver stand in for the web."""
import io
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import httpx
import pytest

from app.core.exceptions import BadRequestException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus
from app.modules.tax import source_parsers
from app.modules.tax.enums import RateKind, StagingOrigin
from app.modules.tax.registry_models import TaxLegalSourceRevision, TaxRateStaging, TaxRateVersion, TaxSourceArtifact
from app.modules.tax.registry_service import MakerCheckerError, RegistryStateError, TaxRegistryPipeline
from app.modules.tax.source_fetch import FetchRefused, SafeFetcher, retry_after_seconds, user_agent
from app.modules.tax.source_monitor_models import (
    ObservationImmutableError, TaxReviewDue, TaxSourceMonitor, TaxSourceObservation, TaxSourceReview,
)
from app.modules.tax.source_monitor_service import SourceMonitorService, run_source_monitoring, view_monitor
from app.modules.tax.source_normalize import PDF_LABEL, RAW_LABEL, normalize
from tests.test_tax_phase3b_packs import _user, build_world

UTC = timezone.utc
T0 = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
URL = "https://www.gov.uk/vat-rates"
PUBLIC = ["151.101.0.144"]


class Web:
    """A tiny fake web: per-path responses, and a log of every request."""

    def __init__(self):
        self.pages = {"/robots.txt": (404, "text/plain", b""), "/vat-rates": (200, "text/html", b"<p>VAT 20%</p>")}
        self.seen = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        status, ctype, body = self.pages.get(request.url.path, (404, "text/plain", b""))
        headers = {"content-type": ctype}
        if isinstance(body, dict):
            headers.update(body["headers"])
            body = body.get("body", b"")
        return httpx.Response(status, headers=headers, content=body)

    def fetcher(self, resolver=None):
        return SafeFetcher(transport=httpx.MockTransport(self.handler), resolver=resolver or (lambda host: PUBLIC))


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P8M")
    w["reviewer2"] = _user(db_session, "rev2@p8m.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_REVIEWER)
    return w


@pytest.fixture()
def web():
    return Web()


def monitor(w, web, tier="NATIONAL_VAT_GST", url=URL, **kw):
    return SourceMonitorService(w["db"], fetcher=web.fetcher(), now=lambda: T0).create(
        actor_id=w["reviewer"].id, title="HMRC VAT rates", monitoring_url=url, risk_tier=tier,
        handoff_ref=kw.get("handoff_ref", "S11"), jurisdiction_id=kw.get("jurisdiction_id"))


def check(w, web, m, at, resolver=None):
    return SourceMonitorService(w["db"], fetcher=web.fetcher(resolver), now=lambda: at).check(m)


def fetch_page(w, web, m, at=T0):
    """robots.txt first (deferred: one request per host per minute), then the page."""
    assert check(w, web, m, at) == "DEFERRED"
    return check(w, web, m, at + timedelta(minutes=2))


# ── fetching: allowlist, DNS rebinding, redirects, limits (fix A) ───────

def test_only_https_allowlisted_hosts_on_the_standard_port(web):
    f = web.fetcher()
    for bad in ("http://www.gov.uk/x", "https://evil.example/x", "https://www.gov.uk:8443/x",
                "https://user:pw@www.gov.uk/x"):
        with pytest.raises(FetchRefused):
            f.get(bad)
    assert web.seen == []


def test_connects_to_the_validated_ip_with_sni_host_and_user_agent(web):
    calls = []

    def rebinding(host):                      # public for the check, private on any later lookup
        calls.append(host)
        return PUBLIC if len(calls) == 1 else ["10.0.0.5"]

    result = web.fetcher(rebinding).get(URL)
    request = web.seen[-1]
    assert result.status == 200 and calls == ["www.gov.uk"]                 # resolved once
    assert request.url.host == PUBLIC[0] and request.headers["host"] == "www.gov.uk"
    assert request.extensions["sni_hostname"] == "www.gov.uk"
    assert request.headers["user-agent"] == user_agent() == \
        "ZoikoBillingTaxMonitor/1.0 (+https://zoikobilling.com/tax-source-monitoring)"   # no personal data


@pytest.mark.parametrize("bad_ip", ["10.0.0.5", "127.0.0.1", "169.254.169.254", "224.0.0.1", "0.0.0.0", "::1",
                                    "fd00::1", "240.0.0.1"])
def test_non_public_addresses_are_refused(web, bad_ip):
    with pytest.raises(FetchRefused, match="non-public"):
        web.fetcher(lambda host: [PUBLIC[0], bad_ip]).get(URL)
    assert web.seen == []


def test_every_redirect_hop_is_checked(web):
    web.pages["/vat-rates"] = (301, "text/html", {"headers": {"location": "https://www.legislation.gov.uk/x"}, "body": b""})
    resolver = lambda host: PUBLIC if host == "www.gov.uk" else ["192.168.1.9"]       # noqa: E731
    with pytest.raises(FetchRefused, match="non-public"):
        web.fetcher(resolver).get(URL)
    web.pages["/vat-rates"] = (302, "text/html", {"headers": {"location": "https://evil.example/x"}, "body": b""})
    with pytest.raises(FetchRefused, match="not an allowlisted"):
        web.fetcher().get(URL)


def test_size_cap_and_retry_after_bounds(web):
    web.pages["/vat-rates"] = (200, "text/html", b"x" * 2048)
    with pytest.raises(FetchRefused, match="larger than"):
        SafeFetcher(transport=httpx.MockTransport(web.handler), resolver=lambda h: PUBLIC, max_bytes=1024).get(URL)
    assert retry_after_seconds("5", T0) == 60 and retry_after_seconds("999999", T0) == 86400
    assert retry_after_seconds("Wed, 11 Nov 2026 09:00:00 GMT", T0) == 86400          # an HTTP date, bounded
    assert retry_after_seconds(None, T0) == 3600


# ── normalization (fix F) ────────────────────────────────────────────────

def test_normalization_by_content_type():
    a = normalize(b"<html><head><title>t</title><script>x=1</script></head><body><p>VAT  20%</p></body></html>",
                  "text/html; charset=utf-8")
    b = normalize(b"<div class='new-chrome'><p>VAT 20%</p></div>", "text/html")
    assert a[0] == "html-text-v1" and a[1] == "VAT 20%" and a[2] == b[2]              # markup churn: same hash
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(100, 750, "Standard rate 20 per cent")
    c.save()
    label, text, digest = normalize(buf.getvalue(), "application/pdf")
    assert label == PDF_LABEL and "Standard rate 20 per cent" in text and digest
    assert normalize(b"\x00\x01", "application/octet-stream") == (RAW_LABEL, None, None)


# ── detection only ──────────────────────────────────────────────────────

def test_baseline_unchanged_churn_and_change(w, web):
    db = w["db"]
    sources, staged, rates = (db.query(TaxLegalSourceRevision).count(), db.query(TaxRateStaging).count(),
                              db.query(TaxRateVersion).count())
    m = monitor(w, web)
    assert fetch_page(w, web, m) == "BASELINE"
    first = db.get(TaxSourceObservation, m.last_observation_id)
    assert first.artifact_sha256 and first.normalization == "html-text-v1"
    assert fetch_page(w, web, m, T0 + timedelta(days=8)) == "UNCHANGED"
    web.pages["/vat-rates"] = (200, "text/html", b"<div><span><p>VAT 20%</p></span></div>")          # markup only
    assert fetch_page(w, web, m, T0 + timedelta(days=16)) == "UNCHANGED"
    unchanged = db.get(TaxSourceObservation, m.last_observation_id)
    assert unchanged.artifact_sha256 is None                       # answer 4: no artifact without a change
    web.pages["/vat-rates"] = (200, "text/html", b"<p>VAT 21%</p><script>alert(1)</script>")
    assert fetch_page(w, web, m, T0 + timedelta(days=24)) == "CHANGED"
    review = db.query(TaxSourceReview).filter(TaxSourceReview.kind == "SOURCE_CHANGED").one()
    assert "-VAT 20%" in review.diff and "+VAT 21%" in review.diff and "alert" not in review.diff
    assert db.get(TaxSourceObservation, m.last_observation_id).artifact_sha256
    assert (db.query(TaxLegalSourceRevision).count(), db.query(TaxRateStaging).count(),
            db.query(TaxRateVersion).count()) == (sources, staged, rates)                 # detection only
    assert db.query(TaxSourceArtifact).filter(TaxSourceArtifact.sha256 == first.raw_sha256).count() == 1


def test_unsupported_types_still_open_reviews_on_raw_change(w, web):
    db = w["db"]
    web.pages["/vat-rates"] = (200, "application/octet-stream", b"\x00v1")
    m = monitor(w, web)
    fetch_page(w, web, m)
    web.pages["/vat-rates"] = (200, "application/octet-stream", b"\x00v2")
    assert fetch_page(w, web, m, T0 + timedelta(days=8)) == "CHANGED"
    review = db.query(TaxSourceReview).filter(TaxSourceReview.kind == "SOURCE_CHANGED").one()
    assert "raw-bytes" in review.diff and "raw content hash changed" in review.diff


def test_observations_are_append_only(w, web):
    db = w["db"]
    m = monitor(w, web)
    fetch_page(w, web, m)
    o = db.get(TaxSourceObservation, m.last_observation_id)
    o.error = "edited"
    with pytest.raises(ObservationImmutableError):
        db.flush()
    db.rollback()


# ── refusals, rate limits, robots, courtesy (fixes C, D) ────────────────

def test_403_switches_to_manual_at_once_and_reminds_at_the_cadence(w, web):
    db = w["db"]
    web.pages["/vat-rates"] = (403, "text/html", b"Forbidden")
    m = monitor(w, web)
    assert fetch_page(w, web, m) == "REFUSED"
    assert m.access_mode == "MANUAL_CHECK" and "HTTP 403" in m.manual_reason
    run_source_monitoring(db, now=m.next_check_due, fetcher=web.fetcher())
    reminder = db.query(TaxSourceReview).filter(TaxSourceReview.kind == "MANUAL_CHECK_DUE").one()
    requests_before = len(web.seen)
    run_source_monitoring(db, now=m.next_check_due + timedelta(minutes=5), fetcher=web.fetcher())
    assert len(web.seen) == requests_before                                       # no automated retries
    with pytest.raises(BadRequestException):
        SourceMonitorService(db).close_review(actor_id=w["reviewer"].id, review_id=reminder.id, outcome="CHECKED")
    SourceMonitorService(db, now=lambda: T0 + timedelta(days=9)).close_review(
        actor_id=w["reviewer"].id, review_id=reminder.id, outcome="CHECKED", reason="Checked the page by hand: 20%")
    assert m.next_check_due.replace(tzinfo=UTC) == T0 + timedelta(days=16)


def test_429_backs_off_then_switches_after_three(w, web):
    web.pages["/vat-rates"] = (429, "text/html", {"headers": {"retry-after": "120"}, "body": b""})
    m = monitor(w, web)
    assert fetch_page(w, web, m) == "RATE_LIMITED"
    assert m.access_mode == "AUTOMATED" and m.consecutive_429 == 1
    assert m.retry_after_until.replace(tzinfo=UTC) == T0 + timedelta(minutes=2, seconds=120)
    assert check(w, web, m, T0 + timedelta(minutes=10)) == "RATE_LIMITED"
    assert m.access_mode == "AUTOMATED"
    assert check(w, web, m, T0 + timedelta(minutes=20)) == "RATE_LIMITED"
    assert m.access_mode == "MANUAL_CHECK" and "three checks in a row" in m.manual_reason


def test_robots_txt_and_one_request_per_host_per_minute(w, web):
    web.pages["/robots.txt"] = (200, "text/plain", b"User-agent: ZoikoBillingTaxMonitor\nDisallow: /vat-rates\n")
    m = monitor(w, web)
    assert check(w, web, m, T0) == "DEFERRED"                                     # robots.txt fetched
    assert check(w, web, m, T0 + timedelta(seconds=30)) == "DEFERRED"             # same host within a minute
    assert check(w, web, m, T0 + timedelta(minutes=2)) == "ROBOTS_DISALLOWED"
    assert m.access_mode == "MANUAL_CHECK" and "robots.txt" in m.manual_reason
    assert [r.url.path for r in web.seen] == ["/robots.txt"]                      # the page was never requested


# ── change control (answer 1) ───────────────────────────────────────────

def test_weakening_changes_need_a_second_person(w, web):
    db = w["db"]
    m = monitor(w, web)
    svc = SourceMonitorService(db, now=lambda: T0)
    with pytest.raises(RegistryStateError, match="second person"):
        svc.raise_tier(actor_id=w["reviewer"].id, monitor_id=m.id, risk_tier="RESEARCH_ONLY")
    svc.raise_tier(actor_id=w["reviewer"].id, monitor_id=m.id, risk_tier="HIGH_VOLATILITY")
    assert m.risk_tier == "HIGH_VOLATILITY"
    with pytest.raises(BadRequestException, match="allowlisted"):
        svc.propose_change(actor_id=w["reviewer"].id, monitor_id=m.id, action="CHANGE_URL", reason="move",
                           value="https://evil.example/x")
    c = svc.propose_change(actor_id=w["reviewer"].id, monitor_id=m.id, action="DISABLE", reason="noisy")
    with pytest.raises(MakerCheckerError):
        svc.decide_change(actor_id=w["reviewer"].id, change_id=c.id, approve=True)
    svc.decide_change(actor_id=w["reviewer2"].id, change_id=c.id, approve=True)
    assert m.enabled is False
    with pytest.raises(BadRequestException):
        monitor(w, web, url="https://www.gov.uk:444/x")


def test_dismissals_are_counted_and_flapping_shows(w, web):
    db = w["db"]
    m = monitor(w, web)
    fetch_page(w, web, m)
    for n in range(3):
        web.pages["/vat-rates"] = (200, "text/html", f"<p>Updated {n}</p>".encode())
        fetch_page(w, web, m, T0 + timedelta(days=8 * (n + 1)))
        review = db.query(TaxSourceReview).filter(TaxSourceReview.status == "OPEN").one()
        SourceMonitorService(db).close_review(actor_id=w["reviewer"].id, review_id=review.id, outcome="DISMISSED",
                                              reason=f"timestamp only {n}")
    view = view_monitor(m, db)
    assert view["dismissals"] == 3 and view["flapping"] is True and view["recent_dismissal_reasons"][0] == "timestamp only 2"


# ── reminders, review dues, alerts (answers 5, 6; fix E) ────────────────

def test_rate_published_inside_the_window_is_reminded_at_once(w):
    db = w["db"]
    p = TaxRegistryPipeline(db)
    row = p.stage(actor_id=w["reviewer"].id, origin=StagingOrigin.MANUAL, component_id=w["gb"]["component"].id,
                  tax_code="reduced", rate_kind=RateKind.STANDARD, rate_percent=Decimal("5"),
                  valid_from=datetime.now(UTC).date() + timedelta(days=5), valid_to=None,
                  source_revision_id=w["gb"]["source"].id, owner="Tax compliance operations")
    p.validate(actor_id=w["reviewer"].id, staged_id=row.id)
    p.submit(actor_id=w["reviewer"].id, staged_id=row.id, reason="new reduced rate")
    p.approve(actor_id=w["publisher"].id, staged_id=row.id)
    version = p.publish(actor_id=w["publisher"].id, staged_id=row.id)
    reminders = db.query(TaxSourceReview).filter(TaxSourceReview.kind == "PRE_EFFECTIVE_CHECK").all()
    assert [r.rate_version_id for r in reminders] == [version.id]
    run_source_monitoring(db, now=datetime.now(UTC), fetcher=None)
    assert db.query(TaxSourceReview).filter(TaxSourceReview.kind == "PRE_EFFECTIVE_CHECK").count() == 1   # once


def _item(db, key):
    return db.query(AttentionItem).filter(AttentionItem.source_key == f"tax:{key}",
                                          AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED])).first()


def test_review_dues_overdue_and_stale_and_failing_alerts(w, web):
    db = w["db"]
    m = monitor(w, web, jurisdiction_id=w["gb"]["jurisdiction"].id)
    run_source_monitoring(db, now=T0, fetcher=web.fetcher())
    dues = {d.subject_kind: d for d in db.query(TaxReviewDue)}
    assert dues["source"].tier == "NATIONAL_VAT_GST" and dues["availability"].tier == "NATIONAL_VAT_GST"
    later = T0 + timedelta(days=30)
    web.pages["/robots.txt"] = (404, "text/plain", b"")
    m.consecutive_failures, m.next_check_due = 3, T0 - timedelta(days=10)
    db.flush()
    from app.modules.tax.monitoring import publish
    from app.modules.tax.source_monitor_service import alerts

    publish(db, alerts(db, later))
    overdue = _item(db, "tax.review_overdue")
    assert overdue is not None and overdue.severity == AttentionSeverity.P2
    assert _item(db, "tax.source_stale:NATIONAL_VAT_GST").severity == AttentionSeverity.P2
    assert _item(db, "tax.source_fetch_failing").severity == AttentionSeverity.P3
    svc = SourceMonitorService(db, now=lambda: later)
    for d in db.query(TaxReviewDue):
        svc.mark_reviewed(actor_id=w["reviewer"].id, due_id=d.id, note="Re-read the source; unchanged")
    m.consecutive_failures, m.next_check_due = 0, later
    db.flush()
    publish(db, alerts(db, later))
    assert _item(db, "tax.review_overdue") is None and _item(db, "tax.source_fetch_failing") is None


def test_research_only_jurisdictions_are_labelled(w, web, client_for):
    from app.modules.tax.registry_models import TaxJurisdiction

    nz = TaxJurisdiction(code="NZ", name="New Zealand", level="country", country_code="NZ", timezone="Pacific/Auckland")
    w["db"].add(nz)
    w["db"].flush()
    monitor(w, web, tier="RESEARCH_ONLY", jurisdiction_id=nz.id, handoff_ref="S99")
    monitor(w, web, tier="RESEARCH_ONLY", jurisdiction_id=w["aus"]["jurisdiction"].id, handoff_ref="S16")
    w["db"].commit()
    body = client_for(w["reviewer"]).get("/api/v1/tax/jurisdictions").json()["items"]
    labels = {j["code"]: j["billing_clearance"] for j in body}
    assert labels["NZ"] == "Research only: not cleared for billing"
    assert labels["AU"] == "Cleared for billing in published markets"         # a calculating market is published


# ── the optional parser interface ───────────────────────────────────────

def test_a_parser_stages_official_feed_drafts_only(w, web, monkeypatch):
    db = w["db"]
    assert source_parsers.SOURCE_PARSERS == {}                                    # none registered

    class Fixture(source_parsers.SourceParser):
        def parse(self, monitor, text):
            return [source_parsers.ProposedRate(component_id=w["gb"]["component"].id, tax_code="reduced",
                                                rate_percent=Decimal("5"), valid_from=date(2031, 1, 1),
                                                source_revision_id=w["gb"]["source"].id)]

    monkeypatch.setitem(source_parsers.SOURCE_PARSERS, "S11", Fixture())
    m = monitor(w, web)
    fetch_page(w, web, m)
    web.pages["/vat-rates"] = (200, "text/html", b"<p>Reduced 5%</p>")
    fetch_page(w, web, m, T0 + timedelta(days=8))
    staged = db.query(TaxRateStaging).filter(TaxRateStaging.origin == StagingOrigin.OFFICIAL_FEED).one()
    assert staged.status.name not in ("APPROVED", "PUBLISHED")                    # still needs two people


def test_http_roles(w, web, client_for):
    base = "/api/v1/super-admin/tax-registry"
    body = {"title": "HMRC VAT", "monitoring_url": URL, "risk_tier": "NATIONAL_VAT_GST", "handoff_ref": "S11"}
    assert client_for(w["publisher"]).post(f"{base}/source-monitors", json=body).status_code == 403   # reviewers create
    created = client_for(w["reviewer"]).post(f"{base}/source-monitors", json=body)
    assert created.status_code == 201, created.text
    mid = created.json()["id"]
    change = client_for(w["reviewer"]).post(f"{base}/source-monitors/{mid}/changes",
                                            json={"action": "LOWER_TIER", "value": "RESEARCH_ONLY", "reason": "quiet"})
    assert change.status_code == 201
    assert client_for(w["reviewer"]).post(f"{base}/source-monitor-changes/{change.json()['id']}/approve",
                                          json={}).status_code == 403              # the proposer can't decide
    done = client_for(w["publisher"]).post(f"{base}/source-monitor-changes/{change.json()['id']}/approve", json={})
    assert done.status_code == 200 and done.json()["status"] == "APPROVED"
    listed = client_for(w["publisher"]).get(f"{base}/source-monitors").json()["items"]
    assert listed[0]["risk_tier"] == "RESEARCH_ONLY"
