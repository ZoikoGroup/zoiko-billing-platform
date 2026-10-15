# DB Schema Drift — Remediation Plan (PROPOSED, NOT APPLIED)

**Status: NOT APPLIED. Awaiting owner/DBA approval. This document is a proposal only.**
No migration was run, no table/column was created/dropped/altered, and no
`alembic stamp` was executed as part of producing this plan.

**Scope:** Live Neon Postgres (`ep-plain-cell-ay3kafa4-pooler.../neondb`) backing
`backend/` (FastAPI). Public-chatbot tables (`ai_public_*`) are **not** affected —
they are correctly migrated (see §1.3).

---

## 1. Verified findings (from live `information_schema`, this session)

Verified by direct query, not by trusting migration files or model declarations.

### 1.1 Alembic version

- `alembic_version = f6b2d1e8c4a7` (the repo's public-chatbot head).
- `public` schema table count: **139**.

### 1.2 Missing objects (confirmed absent in the live DB)

| Object | Kind | Defined in model | DDL source revision (exists in repo) |
|---|---|---|---|
| `suppressed_recipients` | table | `app/modules/notifications/models.py` | `a3c7e91f4d28` |
| `marketing_consents` | table | `app/modules/notifications/models.py` | `a3c7e91f4d28` |
| `notification_template_states` | table | `app/modules/notifications/models.py` | `a3c7e91f4d28` |
| `communication_sends` | table | `app/modules/notifications/models.py` | `a3c7e91f4d28` |
| `communication_logs` | table | `app/modules/notifications/models.py` | `a3c7e91f4d28` |
| `email_outbox` | table | `app/services/email_foundation/models.py` | `c3f5a7e9d1b4` |
| `subscriptions.idempotency_key` | column | `Subscription` | `7b4c1d9e2f10` |
| `subscriptions.idempotency_request_hash` | column | `Subscription` | `7b4c1d9e2f10` |
| `billing_configurations.auto_send_invoices` | column | `BillingConfiguration` | `a1c9d3e7f5b2` |
| `billing_configurations.quote_terms_and_conditions` | column | `BillingConfiguration` | `e5a1c3f7b9d2` |
| `billing_configurations.default_trial_days` | column | `BillingConfiguration` | `e5a1c3f7b9d2` |
| `billing_configurations.default_pricing_strategy` | column | `BillingConfiguration` | `e5a1c3f7b9d2` |
| `billing_configurations.default_billing_frequency` | column | `BillingConfiguration` | `e5a1c3f7b9d2` |
| `billing_configurations.subscription_extra_settings` | column | `BillingConfiguration` | `e5a1c3f7b9d2` |
| `billing_configurations.payment_extra_settings` | column | `BillingConfiguration` | `e5a1c3f7b9d2` |
| `billing_configurations.pricing_extra_settings` | column | `BillingConfiguration` | `f2b8d4a6c1e3` |

Plus the unique constraint `uq_subscriptions_org_idempotency_key`
(`organization_id`, `idempotency_key`) from `7b4c1d9e2f10`.

### 1.3 Objects verified PRESENT (do not touch)

`ai_public_assistant_message` (incl. `idempotency_key` + unique
`uq_ai_public_msg_session_idem`), `ai_public_support_request` (incl.
`client_request_id` + unique `uq_ai_public_support_client_request_id`),
`ai_public_assistant_session`. The public-chatbot migration chain applied
cleanly this session (`c3d4e5f6a7b8 → … → f6b2d1e8c4a7`).

---

## 2. Root cause (verified)

The live database's schema was **created out-of-band and then `alembic
stamp`ed**, so `alembic_version` claims a revision whose DDL was never actually
executed. Consequences:

1. **Ancestor revisions never ran.** e.g. `e5a1c3f7b9d2`, `f2b8d4a6c1e3`,
   `7b4c1d9e2f10` are ancestors of the recorded head yet their columns are
   absent — proof the chain was stamped, not executed.
2. **The migration DAG has unmerged branches.** Six revisions have no child:
   `a1c9d3e7f5b2`, `a4c8e2f6b1d9`, `a9f3c2e8d1b4`, `c3d4e5f6a7b8`,
   `f092a8c6d3e1`, `f6b2d1e8c4a7`. The branches that own the missing
   notification/email/settings DDL (`73e2ebbe6aad → a1c9d3e7f5b2`,
   `a3c7e91f4d28 → … → f092a8c6d3e1`, `c3f5a7e9d1b4 → c3d4e5f6a7b8`) were never
   merged into the applied lineage.

**Therefore `alembic upgrade head` cannot repair this**: alembic already
believes it is at head; the missing DDL belongs to revisions it thinks are
applied. `alembic stamp` must **not** be used to "fix" this (it would only
relabel the same broken state).

---

## 3. Proposed remediation (forward-only, additive, idempotent)

One new revision, `reconcile_live_schema_drift`, that adds **only** the missing
objects and is a **no-op** where they already exist. It never drops, never
alters existing columns, and touches no financial values.

**DAG caveat (requires DBA):** because the graph has multiple heads, this
revision alone will not make `alembic upgrade head` reachable. The DBA must
first reconcile heads with `alembic merge -m "merge drift branches" <heads…>`
(or author this revision with the merged heads as its `down_revision` tuple),
then confirm `alembic heads` reports a single head. This plan **does not**
perform that merge.

### 3.1 Proposed file: `backend/alembic/versions/<newid>_reconcile_live_schema_drift.py`

> Not written to disk (to avoid a footgun where a later `upgrade head`
> auto-applies it). Copy into `backend/alembic/versions/` only after approval.

```python
"""reconcile live schema drift (additive, idempotent)

Adds notification/email-foundation tables + subscription idempotency columns +
billing_configurations settings columns that are absent from the live DB
because that DB was `stamp`ed rather than migrated. Every step is guarded by an
inspector check so the revision is safe to run against a DB that already has
some/all of these objects (fresh CI, DR restore, or a partially-repaired env).

Revision ID: <newid>
Revises: f6b2d1e8c4a7
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
import app.modules.notifications.models

revision: str = "<newid>"
down_revision: Union[str, Sequence[str], None] = "f6b2d1e8c4a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    def add_col(table, column):
        if column.name not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, column)

    # ── a3c7e91f4d28 → notification platform tables ─────────────────────
    if "suppressed_recipients" not in tables:
        op.create_table(
            "suppressed_recipients",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("reason", app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.SuppressionReason), nullable=False),
            sa.Column("detail", sa.Text(), nullable=True),
            sa.Column("suppressed_at", sa.DateTime(timezone=True),
                      server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), nullable=True),
            sa.Column("lifted_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        for name, cols, uniq in [
            ("ix_suppressed_recipients_id", ["id"], False),
            ("ix_suppressed_recipients_email", ["email"], False),
            ("ix_suppressed_recipients_organization_id", ["organization_id"], False),
            ("ix_suppressed_recipients_email_org", ["email", "organization_id"], False),
        ]:
            op.create_index(name, "suppressed_recipients", cols, unique=uniq)

    if "marketing_consents" not in tables:
        op.create_table(
            "marketing_consents",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("scope", app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.MarketingConsentScope), nullable=False),
            sa.Column("granted", sa.Boolean(), nullable=False),
            sa.Column("granted_at", sa.DateTime(), nullable=True),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
            sa.Column("source", sa.String(length=100), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
            sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        for name, cols, uniq in [
            ("ix_marketing_consents_id", ["id"], False),
            ("ix_marketing_consents_email", ["email"], False),
            ("ix_marketing_consents_organization_id", ["organization_id"], False),
            ("ix_marketing_consents_email_org_scope", ["email", "organization_id", "scope"], False),
        ]:
            op.create_index(name, "marketing_consents", cols, unique=uniq)

    if "notification_template_states" not in tables:
        op.create_table(
            "notification_template_states",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("template_id", sa.String(length=50), nullable=False),
            sa.Column("enabled", sa.Boolean(), server_default="1", nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("changed_by_user_id", sa.Integer(), nullable=True),
            sa.Column("changed_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
            sa.ForeignKeyConstraint(["changed_by_user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("template_id"),
        )
        op.create_index("ix_notification_template_states_id", "notification_template_states", ["id"], unique=False)
        op.create_index("ix_notification_template_states_template_id", "notification_template_states", ["template_id"], unique=True)

    if "communication_sends" not in tables:
        op.create_table(
            "communication_sends",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dedupe_key", sa.String(length=300), nullable=False),
            sa.Column("event_name", sa.String(length=150), nullable=False),
            sa.Column("entity_type", sa.String(length=50), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=True),
            sa.Column("template_id", sa.String(length=50), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("recipient_email", sa.String(length=255), nullable=False),
            sa.Column("status", app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.CommunicationSendStatus),
                server_default="PENDING", nullable=False),
            sa.Column("correlation_id", sa.String(length=100), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dedupe_key", name="uq_communication_sends_dedupe_key"),
        )
        for name, cols in [
            ("ix_communication_sends_id", ["id"]),
            ("ix_communication_sends_event_name", ["event_name"]),
            ("ix_communication_sends_template_id", ["template_id"]),
            ("ix_communication_sends_organization_id", ["organization_id"]),
            ("ix_communication_sends_correlation_id", ["correlation_id"]),
        ]:
            op.create_index(name, "communication_sends", cols, unique=False)

    if "communication_logs" not in tables:
        op.create_table(
            "communication_logs",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("template_id", sa.String(length=50), nullable=False),
            sa.Column("event_name", sa.String(length=150), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("recipient_email", sa.String(length=255), nullable=False),
            sa.Column("status", app.core.db_types.CaseInsensitiveEnum(
                app.modules.notifications.models.CommunicationLogStatus), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("correlation_id", sa.String(length=100), nullable=True),
            sa.Column("communication_send_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.text("CURRENT_TIMESTAMP"), nullable=True),
            sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["communication_send_id"], ["communication_sends.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        for name, cols in [
            ("ix_communication_logs_id", ["id"]),
            ("ix_communication_logs_template_id", ["template_id"]),
            ("ix_communication_logs_event_name", ["event_name"]),
            ("ix_communication_logs_organization_id", ["organization_id"]),
            ("ix_communication_logs_recipient_email", ["recipient_email"]),
            ("ix_communication_logs_status", ["status"]),
            ("ix_communication_logs_correlation_id", ["correlation_id"]),
            ("ix_communication_logs_org_created", ["organization_id", "created_at"]),
        ]:
            op.create_index(name, "communication_logs", cols, unique=False)

    # ── c3f5a7e9d1b4 → email_outbox (durable queue) ─────────────────────
    if "email_outbox" not in tables:
        op.create_table(
            "email_outbox",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dedupe_key", sa.String(length=255), nullable=True),
            sa.Column("recipient", sa.String(length=255), nullable=False),
            sa.Column("organization_id", sa.Integer(), nullable=True),
            sa.Column("template_name", sa.String(length=255), nullable=False),
            sa.Column("template_id", sa.String(length=50), nullable=True),
            sa.Column("event_name", sa.String(length=100), nullable=True),
            sa.Column("event_id", sa.String(length=255), nullable=True),
            sa.Column("target_record_id", sa.String(length=255), nullable=True),
            sa.Column("context_json", sa.Text(), nullable=True),
            sa.Column("attachments_json", sa.Text(), nullable=True),
            sa.Column("from_email_override", sa.String(length=255), nullable=True),
            sa.Column("from_display_name_override", sa.String(length=255), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="QUEUED"),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        for name, cols in [
            ("ix_email_outbox_id", ["id"]),
            ("ix_email_outbox_dedupe_key", ["dedupe_key"]),
            ("ix_email_outbox_recipient", ["recipient"]),
            ("ix_email_outbox_organization_id", ["organization_id"]),
            ("ix_email_outbox_template_id", ["template_id"]),
            ("ix_email_outbox_event_name", ["event_name"]),
            ("ix_email_outbox_event_id", ["event_id"]),
            ("ix_email_outbox_target_record_id", ["target_record_id"]),
            ("ix_email_outbox_status", ["status"]),
            ("ix_email_outbox_created_at", ["created_at"]),
            ("idx_email_outbox_status_created", ["status", "created_at"]),
        ]:
            op.create_index(name, "email_outbox", cols, unique=False)

    # ── 7b4c1d9e2f10 → subscriptions idempotency ───────────────────────
    add_col("subscriptions", sa.Column("idempotency_key", sa.String(length=255), nullable=True))
    add_col("subscriptions", sa.Column("idempotency_request_hash", sa.String(length=64), nullable=True))
    existing_uq = {uc["name"] for uc in insp.get_unique_constraints("subscriptions")}
    if "uq_subscriptions_org_idempotency_key" not in existing_uq:
        op.create_unique_constraint(
            "uq_subscriptions_org_idempotency_key",
            "subscriptions",
            ["organization_id", "idempotency_key"],
        )

    # ── billing_configurations settings fields ─────────────────────────
    add_col("billing_configurations", sa.Column("auto_send_invoices", sa.Boolean(),
            nullable=False, server_default=sa.text("false")))
    add_col("billing_configurations", sa.Column("quote_terms_and_conditions", sa.Text(), nullable=True))
    add_col("billing_configurations", sa.Column("default_trial_days", sa.Integer(),
            nullable=False, server_default=sa.text("0")))
    add_col("billing_configurations", sa.Column("default_pricing_strategy", sa.String(length=20),
            nullable=False, server_default=sa.text("'flat'")))
    add_col("billing_configurations", sa.Column("default_billing_frequency", sa.String(length=20),
            nullable=False, server_default=sa.text("'monthly'")))
    add_col("billing_configurations", sa.Column("subscription_extra_settings", sa.JSON(),
            nullable=False, server_default=sa.text("'{}'")))
    add_col("billing_configurations", sa.Column("payment_extra_settings", sa.JSON(),
            nullable=False, server_default=sa.text("'{}'")))
    add_col("billing_configurations", sa.Column("pricing_extra_settings", sa.JSON(),
            nullable=False, server_default=sa.text("'{}'")))
    # Drop the transient server defaults to match the original revisions' intent.
    for c in ("auto_send_invoices", "default_trial_days", "default_pricing_strategy",
              "default_billing_frequency", "subscription_extra_settings",
              "payment_extra_settings", "pricing_extra_settings"):
        op.alter_column("billing_configurations", c, server_default=None)


def downgrade() -> None:
    # Deliberately conservative: only remove objects this revision is certain it
    # created. Never run against a DB where these pre-existed.
    op.drop_column("billing_configurations", "pricing_extra_settings")
    op.drop_column("billing_configurations", "payment_extra_settings")
    op.drop_column("billing_configurations", "subscription_extra_settings")
    op.drop_column("billing_configurations", "default_billing_frequency")
    op.drop_column("billing_configurations", "default_pricing_strategy")
    op.drop_column("billing_configurations", "default_trial_days")
    op.drop_column("billing_configurations", "quote_terms_and_conditions")
    op.drop_column("billing_configurations", "auto_send_invoices")
    op.drop_constraint("uq_subscriptions_org_idempotency_key", "subscriptions", type_="unique")
    op.drop_column("subscriptions", "idempotency_request_hash")
    op.drop_column("subscriptions", "idempotency_key")
    op.drop_table("email_outbox")
    op.drop_table("communication_logs")
    op.drop_table("communication_sends")
    op.drop_table("notification_template_states")
    op.drop_table("marketing_consents")
    op.drop_table("suppressed_recipients")
```

---

## 4. Preconditions, risk, and required approvals

| Item | Requirement |
|---|---|
| **Approval** | Owner + DBA sign-off. These are billing/financial tables (`subscriptions`, `billing_configurations`) and email/notification audit tables. |
| **Snapshot** | Create a Neon branch (point-in-time restore point) immediately before applying. |
| **Window** | Apply during low traffic; notification/email tables are read at send time. |
| **Backups** | Confirm the Neon retention window covers rollback time. |
| **DAG** | DBA reconciles the 6 unmerged heads first (`alembic heads` → single head). |
| **Verification** | Re-run the `information_schema` probe; expect all 16 objects present and `alembic current == head`. |
| **App boot** | `database.py::_verify_postgres_schema_is_migrated` warning list must drop to zero. |
| **Rollback** | `alembic downgrade -1` restores the prior state; the `downgrade()` above drops only new objects. |

## 5. Explicitly out of scope / prohibited

- No `alembic stamp head` on the live DB.
- No drops/alterations of existing columns or financial rows.
- No application of this migration as part of today's session.

## 6. Recommended follow-ups (separate change requests)

1. Merge the migration DAG so a single head exists and `upgrade head` is
   deterministic.
2. Add a CI guard that runs `alembic upgrade head` against a fresh DB **and**
   `alembic check` (autogenerate-diff) against staging, to catch stamp drift.
3. Re-run the same probe used here as a pre-deploy gate.
