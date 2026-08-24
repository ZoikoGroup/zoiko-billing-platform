# Zoiko Billing Super Admin — Information Architecture (IA)

**Document ID:** ZB-SA-IA-001  
**Authoritative Baseline:** ZB-SA-CMD-003 v3.0 / ZB-COM-BILL-001  
**Status:** Approved Canonical IA  

---

## 1. Top-Level Navigation Hierarchy

The Super Admin navigation is organized into 7 primary sections. Only one top-level group may be expanded at a time (accordion behavior).

```
Command Center  [/super-admin/dashboard]

Platform  [Group]
├── Organizations                 [/super-admin/organizations]
├── Administrators & Users        [/super-admin/users]
├── Lifecycle & Onboarding        [/super-admin/platform/lifecycle]
├── Tenant Health                 [/super-admin/tenant-health]
└── Support Access                [/super-admin/support-access]

Platform Commercial  [Group]
├── Commercial Accounts           [/super-admin/commercial/accounts]
├── Products & Price Book         [/super-admin/commercial/plans]
├── Plans, Offers & Trials        [/super-admin/commercial/offers]
├── Platform Subscriptions        [/super-admin/commercial/subscriptions]
├── Entitlements                  [/super-admin/commercial/entitlements]
└── Platform Invoices & Collections [/super-admin/commercial/invoices]

Financial Operations  [Group]
├── Invoice Engine                [/super-admin/financial/invoice-engine]
├── Payments & Disputes           [/super-admin/financial/payments]
├── Balances & Allocations        [/super-admin/financial/balances]
├── Reconciliation                [/super-admin/financial/reconciliation]
├── Credits, Adjustments & Refunds [/super-admin/financial/credits]
├── Usage & Metering              [/super-admin/financial/usage]
└── Tax & E-Invoicing             [/super-admin/financial/tax]

Integrations & Automation  [Group]
├── Payment Gateways              [/super-admin/integrations/gateways]
├── Accounting / ERP / Tax Connectors [/super-admin/integrations/connectors]
├── API & Webhooks                [/super-admin/integrations/webhooks]
├── Jobs & Queues                 [/super-admin/integrations/jobs]
└── Imports & Exports             [/super-admin/integrations/imports-exports]

Governance & Security  [Group]
├── Approval Center               [/super-admin/approval-queue]
├── Audit & Evidence              [/super-admin/audit-logs]
├── Roles & Access                [/super-admin/governance/roles]
├── Privileged Sessions           [/super-admin/governance/privileged-sessions]
├── Security Events               [/super-admin/governance/security-events]
└── Data Governance               [/super-admin/governance/data]

Reliability & Operations  [Group]
├── System Health                 [/super-admin/reliability]
├── Incidents                     [/super-admin/reliability/incidents]
├── Processing Failures & Reprocessing [/super-admin/reliability/reprocessing]
├── Data Quality                  [/super-admin/reliability/data-quality]
└── Release Control               [/super-admin/production-readiness]
```

---

## 2. Navigation Rules & Constraints

1. **Single Group Expansion**: Clicking a navigation group expands it and collapses any previously expanded group.
2. **Direct Object Search**: Deep links, tenant invoices, transactions, and audit records are accessed via the identifier-first Global Search (`Cmd/Ctrl + K`) rather than cluttered sidebar menus.
3. **No Duplicate Top-Level Pages**:
   - Disputes is consolidated under Payments & Disputes.
   - Trials is consolidated under Plans, Offers & Trials.
   - Kill Switch is consolidated under Safety Controls in Reliability & Operations / Command Center.
   - Production Readiness and Launch Readiness are consolidated under Release Control.
4. **Preserved Deep Links**: Legacy URLs are mapped to canonical destinations through redirects.
