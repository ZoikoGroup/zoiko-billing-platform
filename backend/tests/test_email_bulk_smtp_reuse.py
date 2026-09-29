"""
tests/test_email_bulk_smtp_reuse.py
------------------------------------
B4 — SMTP connection reuse across bulk send loops.

open_bulk_smtp_connection() / smtp_connection= plumbing existed but no
production loop actually used it: the dunning sweeps still opened (and
TLS-handshaked, and authenticated) one SMTP connection per recipient. This
covers the two halves that make reuse real:

  - BulkSmtpConnection: the lazy batch holder. Opens on FIRST use (so a
    sweep that sends nothing never pays for a handshake), reuses that one
    connection for the rest of the batch, degrades to None (per-message
    fallback) when the connection can't be opened, and does not re-attempt
    the open once per recipient.
  - The wiring: process_dunning, process_due_reminders and the commercial
    N1 sweep actually pass a shared connection through to the send, and
    close it at the end of the batch.

The "don't retry the open" and "invalidate after a failed send" behaviors
are load-bearing, not incidental: without them a broken SMTP config costs
one 30s connect timeout per recipient, and a single mid-batch protocol
error poisons every later send on the dead socket.
"""
from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch

from app.core.security import hash_password
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import InvoiceStatus
from app.modules.billing.services.dunning_service import DunningService
from app.modules.commercial.dunning_service import CommercialDunningService
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.services.email_service import BulkSmtpConnection

from tests.conftest import make_customer, make_invoice, make_organization

USER_ID = 1

SMTP_SETTINGS = {
    "host": "smtp.example.test",
    "port": "587",
    "username": "user",
    "password": "pass",
    "from_email": "no-reply@example.test",
    "use_tls": "true",
}


def _backdate(db, invoice, days_overdue):
    invoice.due_date = date.today() - timedelta(days=days_overdue)
    db.commit()
    db.refresh(invoice)
    return invoice


def _make_user(db, *, email, org_id):
    user = User(
        email=email,
        hashed_password=hash_password("Sup3rSecret!"),
        role=UserRole.ORG_ADMIN,
        organization_id=org_id,
        first_name="Alex",
        last_name="Test",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


# ── A. The lazy batch holder ───────────────────────────────────────────────

class TestBulkSmtpConnectionHolder:
    def test_connection_is_opened_once_and_reused(self):
        """Three gets across a batch == exactly one connect/login, and the
        same live connection handed back each time."""
        with patch("app.services.email_service._get_smtp_settings", return_value=SMTP_SETTINGS), \
             patch("app.services.email_service.smtplib.SMTP") as mock_smtp:
            mock_smtp.return_value = MagicMock()
            bulk = BulkSmtpConnection()

            first = bulk.get()
            second = bulk.get()
            third = bulk.get()

            assert first is not None
            assert first is second is third
            # The whole point: ONE handshake for the batch, not three.
            assert mock_smtp.call_count == 1
            assert first.starttls.call_count == 1
            assert first.login.call_count == 1

    def test_unavailable_connection_falls_back_to_per_message_and_does_not_retry(self):
        """A broken SMTP config must cost ONE connect attempt for the whole
        batch, not one per recipient — and must surface as None so every
        send falls back to its own connection, exactly as pre-B4."""
        with patch("app.services.email_service._get_smtp_settings", return_value=SMTP_SETTINGS), \
             patch("app.services.email_service.smtplib.SMTP", side_effect=OSError("connection refused")):
            bulk = BulkSmtpConnection()

            assert bulk.get() is None
            assert bulk.get() is None
            assert bulk.get() is None

        # Sender never sees a connection object => per-message path is used.
        with patch("app.services.email_service._get_smtp_settings", return_value=SMTP_SETTINGS), \
             patch("app.services.email_service.smtplib.SMTP", side_effect=OSError("connection refused")) as mock_smtp:
            bulk2 = BulkSmtpConnection()
            for _ in range(5):
                assert bulk2.get() is None
            assert mock_smtp.call_count == 1

    def test_invalidate_after_failed_send_reconnects(self):
        """A connection that failed mid-batch may be mid-transaction or
        closed by the server. The next send must get a FRESH connection, not
        the dead one — otherwise one bad recipient fails every later send."""
        with patch("app.services.email_service._get_smtp_settings", return_value=SMTP_SETTINGS), \
             patch("app.services.email_service.smtplib.SMTP") as mock_smtp:
            first_conn, second_conn = MagicMock(), MagicMock()
            mock_smtp.side_effect = [first_conn, second_conn]

            bulk = BulkSmtpConnection()
            conn = bulk.get()
            assert conn is first_conn

            bulk.invalidate()

            assert bulk.get() is second_conn
            assert mock_smtp.call_count == 2
            # The discarded connection is released, not leaked.
            assert first_conn.quit.call_count == 1

    def test_close_is_idempotent_and_releases_the_connection(self):
        with patch("app.services.email_service._get_smtp_settings", return_value=SMTP_SETTINGS), \
             patch("app.services.email_service.smtplib.SMTP") as mock_smtp:
            conn = MagicMock()
            mock_smtp.return_value = conn

            bulk = BulkSmtpConnection()
            assert bulk.get() is conn

            bulk.close()
            bulk.close()  # safe to call twice (e.g. error path + finally)

            assert conn.quit.call_count == 1

    def test_sends_share_the_same_socket_across_a_batch(self):
        """The behavior the holder exists for: N sends in one batch traverse
        ONE connection — one connect, one TLS handshake, one login, and the
        socket is released only at close()."""
        with patch("app.services.email_service._get_smtp_settings", return_value=SMTP_SETTINGS), \
             patch("app.services.email_service.smtplib.SMTP") as mock_smtp:
            conn = MagicMock()
            mock_smtp.return_value = conn

            bulk = BulkSmtpConnection()
            for _ in range(3):
                assert bulk.get() is conn
                conn.sendmail("from@example.test", "to@example.test", "body")
            bulk.close()

            assert mock_smtp.call_count == 1
            assert conn.starttls.call_count == 1
            assert conn.login.call_count == 1
            assert conn.sendmail.call_count == 3
            # Still open for the whole batch; released exactly once at the end.
            assert conn.quit.call_count == 1


# ── B. The loops actually pass it through ───────────────────────────────────

class TestDunningLoopsWireTheConnection:
    def _level(self, db, org_id, min_days=0, max_days=30):
        return DunningService(db).create_level(
            organization_id=org_id, created_by=USER_ID,
            level_number=1, name="Reminder",
            min_days_overdue=min_days, max_days_overdue=max_days,
            action_type="email_reminder",
        )

    def test_process_dunning_shares_one_connection_across_recipients(self, db_session):
        """Two overdue invoices for two different customers => two sends on
        ONE connection, not a handshake each."""
        org = make_organization(db_session)
        cust_a = make_customer(db_session, org.id, code="CUST_A", email="a@example.test")
        cust_b = make_customer(db_session, org.id, code="CUST_B", email="b@example.test")
        inv_a = make_invoice(db_session, org.id, cust_a.id, status=InvoiceStatus.SENT, total_amount="100.00")
        inv_b = make_invoice(db_session, org.id, cust_b.id, status=InvoiceStatus.SENT, total_amount="200.00")
        _backdate(db_session, inv_a, days_overdue=10)
        _backdate(db_session, inv_b, days_overdue=10)

        svc = DunningService(db_session)
        self._level(db_session, org.id)

        bulk = MagicMock()
        bulk.get.return_value = "SHARED-CONNECTION"
        with patch("app.modules.billing.services.dunning_service.BulkSmtpConnection", return_value=bulk), \
             patch("app.modules.billing.services.dunning_service.send_dunning_reminder_email",
                   return_value=True) as mock_send:
            results = svc.process_dunning(org.id)

        assert len(results) == 2
        assert mock_send.call_count == 2
        sent_connections = [c.kwargs["smtp_connection"] for c in mock_send.call_args_list]
        assert sent_connections == ["SHARED-CONNECTION", "SHARED-CONNECTION"]
        # One holder for the whole run, and always released.
        assert bulk.close.call_count == 1

    def test_process_dunning_never_hands_out_a_dead_connection(self, db_session):
        """A failed send invalidates the batch connection so the next
        recipient's send can reconnect rather than reuse a broken socket."""
        org = make_organization(db_session)
        cust_a = make_customer(db_session, org.id, code="CUST_A", email="a@example.test")
        cust_b = make_customer(db_session, org.id, code="CUST_B", email="b@example.test")
        inv_a = make_invoice(db_session, org.id, cust_a.id, status=InvoiceStatus.SENT, total_amount="100.00")
        inv_b = make_invoice(db_session, org.id, cust_b.id, status=InvoiceStatus.SENT, total_amount="200.00")
        _backdate(db_session, inv_a, days_overdue=10)
        _backdate(db_session, inv_b, days_overdue=10)

        svc = DunningService(db_session)
        self._level(db_session, org.id)

        bulk = MagicMock()
        bulk.get.side_effect = ["FIRST-CONNECTION", "SECOND-CONNECTION"]
        with patch("app.modules.billing.services.dunning_service.BulkSmtpConnection", return_value=bulk), \
             patch("app.modules.billing.services.dunning_service.send_dunning_reminder_email") as mock_send:
            mock_send.side_effect = [OSError("server disconnected mid-transaction"), True]
            svc.process_dunning(org.id)

        # The dunning loop still isolated the failure per-invoice...
        assert mock_send.call_count == 2
        # ...and dropped the poisoned connection rather than reusing it.
        assert bulk.invalidate.call_count == 1
        assert [c.kwargs["smtp_connection"] for c in mock_send.call_args_list] == [
            "FIRST-CONNECTION", "SECOND-CONNECTION",
        ]

    def test_process_dunning_falls_back_when_no_connection_available(self, db_session):
        """bulk.get() returning None must be passed straight through as
        None — that is the documented signal for 'use a per-message
        connection', not a reason to skip or fail the send."""
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id, email="a@example.test")
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="100.00")
        _backdate(db_session, inv, days_overdue=10)

        svc = DunningService(db_session)
        self._level(db_session, org.id)

        bulk = MagicMock()
        bulk.get.return_value = None
        with patch("app.modules.billing.services.dunning_service.BulkSmtpConnection", return_value=bulk), \
             patch("app.modules.billing.services.dunning_service.send_dunning_reminder_email",
                   return_value=True) as mock_send:
            results = svc.process_dunning(org.id)

        assert len(results) == 1
        assert mock_send.call_count == 1
        assert mock_send.call_args.kwargs["smtp_connection"] is None
        assert bulk.close.call_count == 1

    def test_process_due_reminders_shares_one_connection(self, db_session):
        org = make_organization(db_session)
        cust_a = make_customer(db_session, org.id, code="CUST_A", email="a@example.test")
        cust_b = make_customer(db_session, org.id, code="CUST_B", email="b@example.test")
        inv_a = make_invoice(db_session, org.id, cust_a.id, status=InvoiceStatus.SENT, total_amount="100.00")
        inv_b = make_invoice(db_session, org.id, cust_b.id, status=InvoiceStatus.SENT, total_amount="200.00")
        for inv in (inv_a, inv_b):
            inv.due_date = date.today() + timedelta(days=3)
        db_session.commit()

        svc = DunningService(db_session)
        bulk = MagicMock()
        bulk.get.return_value = "SHARED-CONNECTION"
        with patch("app.modules.billing.services.dunning_service.BulkSmtpConnection", return_value=bulk), \
             patch("app.modules.billing.services.dunning_service.send_dunning_reminder_email",
                   return_value=True) as mock_send:
            results = svc.process_due_reminders(org.id)

        assert len(results) == 2
        assert [c.kwargs["smtp_connection"] for c in mock_send.call_args_list] == [
            "SHARED-CONNECTION", "SHARED-CONNECTION",
        ]
        assert bulk.close.call_count == 1

    def test_manual_send_reminder_stays_a_one_off(self, db_session):
        """A single manual send is a genuine one-off: it must NOT open a
        batch connection (B4 is opt-in, never forced onto every call)."""
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id, email="a@example.test")
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="100.00")
        _backdate(db_session, inv, days_overdue=10)

        svc = DunningService(db_session)
        svc.create_level(
            organization_id=org.id, created_by=USER_ID,
            level_number=1, name="Reminder", min_days_overdue=0, max_days_overdue=30,
            action_type="email_reminder",
        )
        case = svc.open_dunning_case(org.id, cust.id, inv.id, created_by=USER_ID)

        with patch("app.modules.billing.services.dunning_service.BulkSmtpConnection") as mock_bulk, \
             patch("app.modules.billing.services.dunning_service.send_dunning_reminder_email",
                   return_value=True) as mock_send:
            svc.send_reminder(case.id, org.id, updated_by=USER_ID)

        mock_bulk.assert_not_called()
        assert mock_send.call_count == 1
        # Untouched call site: the kwarg is not even passed, so the wrapper's
        # own None default applies.
        assert "smtp_connection" not in mock_send.call_args.kwargs


# ── C. The commercial (Plane 1) N1 sweep ────────────────────────────────────

class TestCommercialSweepWiresTheConnection:
    """The commercial sweep imports its email dependency lazily inside the
    loop, so both patches target app.services.email_service (the import
    site), not the commercial module namespace."""

    def _past_due_subscription(self, db, org, email, days):
        _make_user(db, email=email, org_id=org.id)
        acct = CommercialAccount(organization_id=org.id)
        db.add(acct)
        db.flush()
        sub = CommercialSubscription(
            commercial_account_id=acct.id,
            commercial_plan_id=1,
            status=CommercialSubscriptionStatus.ACTIVE,
            payment_failed_at=datetime.utcnow() - timedelta(days=days),
        )
        db.add(sub)
        db.commit()
        return sub

    def test_sweep_shares_one_connection_across_subscriptions(self, db_session):
        org_a = make_organization(db_session, code="ORGA", name="Org A")
        org_b = make_organization(db_session, code="ORGB", name="Org B")
        self._past_due_subscription(db_session, org_a, "a@example.test", days=1)
        self._past_due_subscription(db_session, org_b, "b@example.test", days=1)

        bulk = MagicMock()
        bulk.get.return_value = "SHARED-CONNECTION"
        with patch("app.services.email_service.BulkSmtpConnection", return_value=bulk), \
             patch("app.services.email_service.send_past_due_suspension_warning_email",
                   return_value=True) as mock_send:
            summary = CommercialDunningService(db_session).sweep(db_session)

        assert summary["past_due"] == 2
        assert mock_send.call_count == 2
        assert [c.kwargs["smtp_connection"] for c in mock_send.call_args_list] == [
            "SHARED-CONNECTION", "SHARED-CONNECTION",
        ]
        assert bulk.close.call_count == 1

    def test_sweep_never_hands_out_a_dead_connection(self, db_session):
        """A failed warning email drops the shared connection so the next
        subscription's send can reconnect rather than reuse a dead socket."""
        org_a = make_organization(db_session, code="ORGA", name="Org A")
        org_b = make_organization(db_session, code="ORGB", name="Org B")
        self._past_due_subscription(db_session, org_a, "a@example.test", days=1)
        self._past_due_subscription(db_session, org_b, "b@example.test", days=1)

        bulk = MagicMock()
        bulk.get.side_effect = ["FIRST-CONNECTION", "SECOND-CONNECTION"]
        with patch("app.services.email_service.BulkSmtpConnection", return_value=bulk), \
             patch("app.services.email_service.send_past_due_suspension_warning_email") as mock_send:
            mock_send.side_effect = [OSError("server disconnected mid-transaction"), True]
            summary = CommercialDunningService(db_session).sweep(db_session)

        # The sweep still completed both status transitions...
        assert summary["past_due"] == 2
        # ...the mail failure was contained, not escalated...
        assert summary["errors"] == []
        # ...and the poisoned connection was dropped.
        assert bulk.invalidate.call_count == 1
        assert [c.kwargs["smtp_connection"] for c in mock_send.call_args_list] == [
            "FIRST-CONNECTION", "SECOND-CONNECTION",
        ]
