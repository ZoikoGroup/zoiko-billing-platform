import React, { Suspense, useEffect } from "react";
import { lazyRoute, registerRoutePreloads } from "./routePrefetch";
import { Routes, Route, Navigate, useParams, useLocation } from "react-router-dom";

import { useAuth } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import BillingShell from "./components/BillingShell";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import RegistrationSuccessPage from "./pages/RegistrationSuccessPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import AcceptInvitePage from "./pages/AcceptInvitePage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import PublicEstimatePage from "./pages/PublicEstimatePage";
import PublicInvoicePage from "./pages/PublicInvoicePage";
import PublicPlatformQuotePage from "./pages/PublicPlatformQuotePage";
import PublicPlatformInvoicePage from "./pages/PublicPlatformInvoicePage";
import PaymentSuccessPage from "./pages/PaymentSuccessPage";
import PlatformCheckoutPage from "./pages/PlatformCheckoutPage";
import OrgAdminDashboardPage from "./modules/organization-admin/DashboardPage";
import OrgAdminOrganizationPage from "./modules/organization-admin/OrganizationPage";
import OrgAdminUserManagementPage from "./modules/organization-admin/UserManagementPage";
import { ROLE_DEFAULT_REDIRECT, VALID_ROLES } from "./config/roles";
import BillingSettingsErrorBoundary from "./modules/billing/dashboard/BillingSettingsErrorBoundary";

const BillingAdminWorkspaceDashboard = lazyRoute(() => import("./modules/billing-admin/WorkspaceDashboardPage"));
const BillingAdminWorkspaceOrganization = lazyRoute(() => import("./modules/billing-admin/WorkspaceOrganizationPage"));
const BillingAdminWorkspaceSubscription = lazyRoute(() => import("./modules/billing-admin/WorkspaceSubscriptionPage"));
const BillingAdminWorkspaceZoikoSubscription = lazyRoute(() => import("./modules/billing-admin/WorkspaceZoikoSubscriptionPage"));
const BillingAdminWorkspaceUsage = lazyRoute(() => import("./modules/billing-admin/WorkspaceUsagePage"));
const BillingAdminWorkspaceActivity = lazyRoute(() => import("./modules/billing-admin/WorkspaceActivityPage"));
const BillingAdminWorkspaceNotifications = lazyRoute(() => import("./modules/billing-admin/WorkspaceNotificationsPage"));
const BillingAdminWorkspaceHelp = lazyRoute(() => import("./modules/billing-admin/WorkspaceHelpPage"));

// Platform pages pull in billing-shared.jsx's shared component kit; lazy
// loading keeps that out of the eagerly-loaded main bundle (matches every
// other route below).
const UsersPage = lazyRoute(() => import("./pages/UsersPage"));

const BillingDashboard = lazyRoute(() => import("./modules/billing/dashboard/dashboard"));
const ReportsPage = lazyRoute(() => import("./modules/billing/dashboard/reports"));
const ForecastReport = lazyRoute(() => import("./modules/billing/dashboard/forecast-report"));
const BillingSettingsPage = lazyRoute(() => import("./modules/billing/dashboard/settings"));
const CustomerDashboardPage = lazyRoute(() => import("./modules/billing/customers/customer-dashboard"));
const CustomerListPage = lazyRoute(() => import("./modules/billing/customers/customer-list"));
const CustomerProfilePage = lazyRoute(() => import("./modules/billing/customers/customer-profile"));
const CustomerBillingHistoryPage = lazyRoute(() => import("./modules/billing/customers/billing-history"));
const CustomerReportsPage = lazyRoute(() => import("./modules/billing/customers/reports"));
const CustomerProfitabilityReport = lazyRoute(() => import("./modules/billing/customers/profitability-report"));
const CustomerSettingsPage = lazyRoute(() => import("./modules/billing/customers/settings"));
const ProductDashboardPage = lazyRoute(() => import("./modules/billing/products/dashboard"));
const ProductListPage = lazyRoute(() => import("./modules/billing/products/product-list"));
const ProductProfilePage = lazyRoute(() => import("./modules/billing/products/product-profile"));
const ProductCategoriesPage = lazyRoute(() => import("./modules/billing/products/categories"));
const UsageBillingPage = lazyRoute(() => import("./modules/billing/products/usage-billing"));
const ProductPricingPlansPage = lazyRoute(() => import("./modules/billing/products/pricing-plans"));
const ProductReportsPage = lazyRoute(() => import("./modules/billing/products/reports"));
const ProductSettingsPage = lazyRoute(() => import("./modules/billing/products/settings"));
const PricingDashboardPage = lazyRoute(() => import("./modules/billing/pricing/dashboard"));
const PricingPlansPage = lazyRoute(() => import("./modules/billing/pricing/pricing-plans"));
const TierManagementPage = lazyRoute(() => import("./modules/billing/pricing/tier-management"));
const PricingReportsPage = lazyRoute(() => import("./modules/billing/pricing/reports"));
const PricingSettingsPage = lazyRoute(() => import("./modules/billing/pricing/settings"));
const PriceListsPage = lazyRoute(() => import("./modules/billing/pricing/price-lists"));
const PricingRulesPage = lazyRoute(() => import("./modules/billing/pricing/pricing-rules"));
const DiscountEnginePage = lazyRoute(() => import("./modules/billing/pricing/discount-engine"));
const CurrencyPricingPage = lazyRoute(() => import("./modules/billing/pricing/currency-pricing"));
const TaxPricingPage = lazyRoute(() => import("./modules/billing/pricing/tax-pricing"));
const QuotationListPage = lazyRoute(() => import("./modules/billing/quotations/quotation-list"));
const QuotationDashboardPage = lazyRoute(() => import("./modules/billing/quotations/dashboard"));
const QuotationDetailPage = lazyRoute(() => import("./modules/billing/quotations/quotation-detail"));
const QuotationWizardPage = lazyRoute(() => import("./modules/billing/quotations/quotation-create"));
const QuotationReportsPage = lazyRoute(() => import("./modules/billing/quotations/reports"));
const QuotationSettingsPage = lazyRoute(() => import("./modules/billing/quotations/settings"));
const ContractListPage = lazyRoute(() => import("./modules/billing/contracts/contract-list"));
const ContractDashboardPage = lazyRoute(() => import("./modules/billing/contracts/dashboard"));
const ContractDetailPage = lazyRoute(() => import("./modules/billing/contracts/contract-detail"));
const ContractCreateWizardPage = lazyRoute(() => import("./modules/billing/contracts/contract-create"));
const ContractEditPage = lazyRoute(() => import("./modules/billing/contracts/contract-edit"));
const ContractReportsPage = lazyRoute(() => import("./modules/billing/contracts/reports"));
const ContractSettingsPage = lazyRoute(() => import("./modules/billing/contracts/settings"));
const RetainersPage = lazyRoute(() => import("./modules/billing/contracts/retainers"));
const SubscriptionsPage = lazyRoute(() => import("./modules/billing/subscriptions/subscription-list"));
const SubscriptionDashboardPage = lazyRoute(() => import("./modules/billing/subscriptions/dashboard"));
const SubscriptionDetailPage = lazyRoute(() => import("./modules/billing/subscriptions/subscription-detail"));
const CreateSubscriptionWizardPage = lazyRoute(() => import("./modules/billing/subscriptions/subscription-create"));
const SubscriptionPlansPage = lazyRoute(() => import("./modules/billing/subscriptions/subscription-plans"));
const SubscriptionReportsPage = lazyRoute(() => import("./modules/billing/subscriptions/reports"));
const SubscriptionSettingsPage = lazyRoute(() => import("./modules/billing/subscriptions/settings"));
const InvoiceSchedulesPage = lazyRoute(() => import("./modules/billing/subscriptions/invoice-schedules"));
const InvoicingPage = lazyRoute(() => import("./modules/billing/invoicing/invoice-list"));
const InvoiceDashboardPage = lazyRoute(() => import("./modules/billing/invoicing/invoice-dashboard"));
const CreateInvoiceWizardPage = lazyRoute(() => import("./modules/billing/invoicing/create-invoice-wizard"));
const InvoiceDetailPage = lazyRoute(() => import("./modules/billing/invoicing/invoice-detail"));
const CreditNotesPage = lazyRoute(() => import("./modules/billing/invoicing/credit-notes"));
const CreditNoteDashboardPage = lazyRoute(() => import("./modules/billing/invoicing/credit-note-dashboard"));
const CreditNoteDetailPage = lazyRoute(() => import("./modules/billing/invoicing/credit-note-detail"));
const InvoiceReportsPage = lazyRoute(() => import("./modules/billing/invoicing/reports"));
const InvoiceSettingsPage = lazyRoute(() => import("./modules/billing/invoicing/settings"));
const MoneyInPage = lazyRoute(() => import("./modules/billing/payments/payment-list"));
const PaymentDashboardPage = lazyRoute(() => import("./modules/billing/payments/payment-dashboard"));
const PaymentDetailPage = lazyRoute(() => import("./modules/billing/payments/payment-detail"));
const PaymentReportsPage = lazyRoute(() => import("./modules/billing/payments/reports"));
const PaymentSettingsPage = lazyRoute(() => import("./modules/billing/payments/settings"));
const StripeConnectSettingsPage = lazyRoute(() => import("./modules/billing/payments/stripe-connect"));
const StripeConnectCallbackPage = lazyRoute(() => import("./modules/billing/payments/stripe-connect-callback"));
const CollectionsReceivablesPage = lazyRoute(() => import("./modules/billing/payments/collections-receivables"));
const CollectionsDashboardPage = lazyRoute(() => import("./modules/billing/payments/collections-dashboard"));
const CollectionsCaseDetailPage = lazyRoute(() => import("./modules/billing/payments/collections-case-detail"));
const DunningPage = lazyRoute(() => import("./modules/billing/payments/dunning"));
const DunningCaseDetailPage = lazyRoute(() => import("./modules/billing/payments/dunning-case-detail"));
const DunningLevelsPage = lazyRoute(() => import("./modules/billing/payments/dunning-levels"));
const PromiseToPayPage = lazyRoute(() => import("./modules/billing/payments/promise-to-pay"));
const CreditsPage = lazyRoute(() => import("./modules/billing/payments/credits"));
const RefundsPage = lazyRoute(() => import("./modules/billing/payments/refunds"));
const RefundDashboardPage = lazyRoute(() => import("./modules/billing/payments/refund-dashboard"));
const RefundDetailPage = lazyRoute(() => import("./modules/billing/payments/refund-detail"));
const WriteOffsPage = lazyRoute(() => import("./modules/billing/payments/write-offs"));
const WriteOffDashboardPage = lazyRoute(() => import("./modules/billing/payments/write-off-dashboard"));
const WriteOffDetailPage = lazyRoute(() => import("./modules/billing/payments/write-off-detail"));
const TaxPage = lazyRoute(() => import("./modules/billing/tax/tax-rates"));
const TaxDashboardPage = lazyRoute(() => import("./modules/billing/tax/dashboard"));
const TaxConfigurationPage = lazyRoute(() => import("./modules/billing/tax/tax-configuration"));
const TaxReportsPage = lazyRoute(() => import("./modules/billing/tax/reports"));
const TaxSettingsPage = lazyRoute(() => import("./modules/billing/tax/settings"));

const CommercialOrganizationsPage = lazyRoute(() => import("./modules/super-admin/OrganizationsPage"));
const CommercialOrganizationDetailPage = lazyRoute(() => import("./modules/super-admin/OrganizationDetailPage"));
const CommercialPlansPage = lazyRoute(() => import("./modules/super-admin/PlansPage"));
const CommercialSubscriptionsPage = lazyRoute(() => import("./modules/super-admin/SubscriptionsPage"));
const CommercialEntitlementsPage = lazyRoute(() => import("./modules/super-admin/EntitlementsPage"));
const CommercialPlanEntitlementsPage = lazyRoute(() => import("./modules/super-admin/PlanEntitlementsPage"));
const CommercialOverridesPage = lazyRoute(() => import("./modules/super-admin/OverridesPage"));
const CommercialUsageDiagnosticsPage = lazyRoute(() => import("./modules/super-admin/UsageDiagnosticsPage"));
const CommercialPlanChangesPage = lazyRoute(() => import("./modules/super-admin/PlanChangesPage"));
const CommercialEvaluationProgramsPage = lazyRoute(() => import("./modules/super-admin/EvaluationProgramsPage"));
const Plane1BillingPage = lazyRoute(() => import("./modules/super-admin/Plane1BillingPage"));
const CommercialAuditLogsPage = lazyRoute(() => import("./modules/super-admin/AuditLogsPage"));
const CommercialPlanVersionsPage = lazyRoute(() => import("./modules/super-admin/CommercialPlanVersionsPage"));
const KillSwitchPage = lazyRoute(() => import("./modules/super-admin/KillSwitchPage"));
const ProductionAcceptancePage = lazyRoute(() => import("./modules/super-admin/ProductionAcceptancePage"));
const PlatformDashboardPage = lazyRoute(() => import("./modules/super-admin/PlatformDashboardPage"));
const SupportAccessPage = lazyRoute(() => import("./modules/super-admin/SupportAccessPage"));
const TenantHealthPage = lazyRoute(() => import("./modules/super-admin/TenantHealthPage"));
const SuperAdminNotificationsPage = lazyRoute(() => import("./modules/super-admin/NotificationsPage"));
const LifecycleOnboardingPage = lazyRoute(() => import("./modules/super-admin/LifecycleOnboardingPage"));
const GovernancePage = lazyRoute(() => import("./modules/super-admin/GovernancePage"));
const ConfigurationGovernancePage = lazyRoute(() => import("./modules/super-admin/ConfigurationGovernancePage"));
const ReliabilityPage = lazyRoute(() => import("./modules/super-admin/ReliabilityPage"));
const LaunchReadinessPage = lazyRoute(() => import("./modules/super-admin/LaunchReadinessPage"));
const EmailDeliveryPage = lazyRoute(() => import("./modules/super-admin/EmailDeliveryPage"));
const TriagePage = lazyRoute(() => import("./modules/super-admin/TriagePage"));
const CommandCenterHubPage = lazyRoute(() => import("./modules/super-admin/CommandCenterHubPage"));
const FinancialOperationsPage = lazyRoute(() => import("./modules/super-admin/FinancialOperationsPage"));
const OrgAdminPrivilegedAccessLogPage = lazyRoute(() => import("./modules/organization-admin/PrivilegedAccessLogPage"));
const OrgAdminNotificationsPage = lazyRoute(() => import("./modules/organization-admin/NotificationsPage"));

const BILLING_ROUTES = [
  { path: "/billing", element: <BillingDashboard /> },
  { path: "/billing/reports", element: <ReportsPage /> },
  { path: "/billing/reports/forecast", element: <ForecastReport /> },
  { path: "/billing/settings", element: <BillingSettingsErrorBoundary><BillingSettingsPage /></BillingSettingsErrorBoundary> },
  { path: "/billing/customers", element: <CustomerListPage /> },
  { path: "/billing/customers/dashboard", element: <CustomerDashboardPage /> },
  { path: "/billing/customers/:id", element: <CustomerProfilePage /> },
  { path: "/billing/customers/billing-history", element: <CustomerBillingHistoryPage /> },
  { path: "/billing/customers/reports", element: <CustomerReportsPage /> },
  { path: "/billing/customers/profitability", element: <CustomerProfitabilityReport /> },
  { path: "/billing/customers/settings", element: <CustomerSettingsPage /> },
  { path: "/billing/products", element: <ProductListPage /> },
  { path: "/billing/products/:id", element: <ProductProfilePage /> },
  { path: "/billing/products/dashboard", element: <ProductDashboardPage /> },
  { path: "/billing/products/categories", element: <ProductCategoriesPage /> },
  { path: "/billing/products/pricing-plans", element: <ProductPricingPlansPage /> },
  { path: "/billing/products/reports", element: <ProductReportsPage /> },
  { path: "/billing/products/settings", element: <ProductSettingsPage /> },
  { path: "/billing/usage-billing", element: <UsageBillingPage /> },
  { path: "/billing/pricing", element: <PricingPlansPage /> },
  { path: "/billing/pricing/dashboard", element: <PricingDashboardPage /> },
  { path: "/billing/pricing/tier-management", element: <TierManagementPage /> },
  { path: "/billing/pricing/reports", element: <PricingReportsPage /> },
  { path: "/billing/pricing/settings", element: <PricingSettingsPage /> },
  { path: "/billing/pricing/price-lists", element: <PriceListsPage /> },
  { path: "/billing/pricing/pricing-rules", element: <PricingRulesPage /> },
  { path: "/billing/pricing/discounts", element: <DiscountEnginePage /> },
  { path: "/billing/pricing/currency-pricing", element: <CurrencyPricingPage /> },
  { path: "/billing/pricing/tax-pricing", element: <TaxPricingPage /> },
  { path: "/billing/quotations", element: <QuotationListPage /> },
  { path: "/billing/quotations/dashboard", element: <QuotationDashboardPage /> },
  { path: "/billing/quotations/create", element: <QuotationWizardPage /> },
  { path: "/billing/quotations/:id", element: <QuotationDetailPage /> },
  { path: "/billing/quotations/reports", element: <QuotationReportsPage /> },
  { path: "/billing/quotations/settings", element: <QuotationSettingsPage /> },
  { path: "/billing/contracts", element: <ContractListPage /> },
  { path: "/billing/contracts/dashboard", element: <ContractDashboardPage /> },
  { path: "/billing/contracts/create", element: <ContractCreateWizardPage /> },
  { path: "/billing/contracts/:id", element: <ContractDetailPage /> },
  { path: "/billing/contracts/:id/edit", element: <ContractEditPage /> },
  { path: "/billing/contracts/reports", element: <ContractReportsPage /> },
  { path: "/billing/contracts/settings", element: <ContractSettingsPage /> },
  { path: "/billing/retainers", element: <RetainersPage /> },
  { path: "/billing/subscriptions", element: <SubscriptionsPage /> },
  { path: "/billing/subscriptions/dashboard", element: <SubscriptionDashboardPage /> },
  { path: "/billing/subscriptions/plans", element: <SubscriptionPlansPage /> },
  { path: "/billing/subscriptions/create", element: <CreateSubscriptionWizardPage /> },
  { path: "/billing/subscriptions/:id", element: <SubscriptionDetailPage /> },
  { path: "/billing/subscriptions/reports", element: <SubscriptionReportsPage /> },
  { path: "/billing/subscriptions/settings", element: <SubscriptionSettingsPage /> },
  { path: "/billing/invoices", element: <InvoicingPage /> },
  { path: "/billing/invoices/dashboard", element: <InvoiceDashboardPage /> },
  { path: "/billing/invoices/create", element: <CreateInvoiceWizardPage /> },
  { path: "/billing/invoices/:id", element: <InvoiceDetailPage /> },
  { path: "/billing/invoices/settings", element: <InvoiceSettingsPage /> },
  { path: "/billing/invoice-schedules", element: <InvoiceSchedulesPage /> },
  { path: "/billing/invoicing/reports", element: <InvoiceReportsPage /> },
  { path: "/billing/tax", element: <TaxPage /> },
  { path: "/billing/tax/dashboard", element: <TaxDashboardPage /> },
  { path: "/billing/tax/configuration", element: <TaxConfigurationPage /> },
  { path: "/billing/tax/reports", element: <TaxReportsPage /> },
  { path: "/billing/tax/settings", element: <TaxSettingsPage /> },
  { path: "/billing/collections-receivables", element: <CollectionsReceivablesPage /> },
  { path: "/billing/collections/dashboard", element: <CollectionsDashboardPage /> },
  { path: "/billing/collections/:id", element: <CollectionsCaseDetailPage /> },
  { path: "/billing/promise-to-pay", element: <PromiseToPayPage /> },
  { path: "/billing/credit-notes", element: <CreditNotesPage /> },
  { path: "/billing/credit-notes/dashboard", element: <CreditNoteDashboardPage /> },
  { path: "/billing/credit-notes/:id", element: <CreditNoteDetailPage /> },
  { path: "/billing/dunning", element: <DunningPage /> },
  { path: "/billing/dunning/levels", element: <DunningLevelsPage /> },
  { path: "/billing/dunning/:id", element: <DunningCaseDetailPage /> },
  { path: "/billing/payments", element: <MoneyInPage /> },
  { path: "/billing/payments/dashboard", element: <PaymentDashboardPage /> },
  { path: "/billing/payments/:id", element: <PaymentDetailPage /> },
  { path: "/billing/payments/reports", element: <PaymentReportsPage /> },
  { path: "/billing/payments/settings", element: <PaymentSettingsPage /> },
  { path: "/billing/payments/stripe-connect", element: <StripeConnectSettingsPage /> },
  { path: "/billing/payments/stripe-connect/callback", element: <StripeConnectCallbackPage /> },
  { path: "/billing/credits", element: <CreditsPage /> },
  { path: "/billing/refunds", element: <RefundsPage /> },
  { path: "/billing/refunds/dashboard", element: <RefundDashboardPage /> },
  { path: "/billing/refunds/:id", element: <RefundDetailPage /> },
  { path: "/billing/write-offs", element: <WriteOffsPage /> },
  { path: "/billing/write-offs/dashboard", element: <WriteOffDashboardPage /> },
  { path: "/billing/write-offs/:id", element: <WriteOffDetailPage /> },
];

// ONE canonical Super Admin route tree. Every page below is reachable at
// exactly one URL; the legacy paths that used to serve some of these same
// pages are registered separately, below, as redirects — never as a second
// live copy of the page.
const SUPER_ADMIN_ROUTES = [
  { path: "/super-admin/command-center", element: <CommandCenterHubPage /> },
  { path: "/super-admin/dashboard", element: <PlatformDashboardPage /> },
  { path: "/super-admin/organizations", element: <CommercialOrganizationsPage /> },
  { path: "/super-admin/organizations/:organizationId", element: <CommercialOrganizationDetailPage /> },
  { path: "/super-admin/users", element: <UsersPage /> },
  { path: "/super-admin/platform/lifecycle", element: <LifecycleOnboardingPage /> },
  { path: "/super-admin/support-access", element: <SupportAccessPage /> },
  { path: "/super-admin/tenant-health", element: <TenantHealthPage /> },
  { path: "/super-admin/notifications", element: <SuperAdminNotificationsPage /> },
  { path: "/super-admin/tenant-health/jobs", element: <Navigate to="/super-admin/tenant-health?tab=jobs" replace /> },
  { path: "/super-admin/commercial/plans", element: <CommercialPlansPage /> },
  { path: "/super-admin/commercial/plans/:planId/versions", element: <CommercialPlanVersionsPage /> },
  { path: "/super-admin/commercial/subscriptions", element: <CommercialSubscriptionsPage /> },
  { path: "/super-admin/commercial/entitlements", element: <CommercialEntitlementsPage /> },
  { path: "/super-admin/commercial/plan-entitlements", element: <CommercialPlanEntitlementsPage /> },
  { path: "/super-admin/commercial/overrides", element: <CommercialOverridesPage /> },
  { path: "/super-admin/commercial/usage-diagnostics", element: <CommercialUsageDiagnosticsPage /> },
  { path: "/super-admin/commercial/plan-changes", element: <CommercialPlanChangesPage /> },
  { path: "/super-admin/commercial/evaluation-programs", element: <CommercialEvaluationProgramsPage /> },
  { path: "/super-admin/commercial/invoices", element: <Plane1BillingPage /> },
  { path: "/super-admin/financial-operations", element: <FinancialOperationsPage /> },
  { path: "/super-admin/audit-logs", element: <CommercialAuditLogsPage /> },
  { path: "/super-admin/governance", element: <GovernancePage /> },
  { path: "/super-admin/governance/privileged-sessions", element: <SupportAccessPage /> },
  { path: "/super-admin/governance/data", element: <GovernancePage /> },
  { path: "/super-admin/governance/configuration", element: <ConfigurationGovernancePage /> },
  { path: "/super-admin/reliability", element: <ReliabilityPage /> },
  { path: "/super-admin/email-delivery", element: <EmailDeliveryPage /> },
  { path: "/super-admin/reliability/incidents", element: <TriagePage /> },
  { path: "/super-admin/reliability/reprocessing", element: <TriagePage /> },
  { path: "/super-admin/kill-switch", element: <KillSwitchPage /> },
  { path: "/super-admin/production-readiness", element: <ProductionAcceptancePage /> },
  { path: "/super-admin/triage", element: <TriagePage /> },
  { path: "/super-admin/launch-readiness", element: <LaunchReadinessPage /> },
];

// Legacy Super Admin paths that must keep working (bookmarks, old links)
// but no longer render their own copy of a page — they redirect to the one
// canonical location above.
const SUPER_ADMIN_LEGACY_REDIRECTS = [
  { from: "/dashboard", to: "/super-admin/dashboard" },
  { from: "/users", to: "/super-admin/users" },
  { from: "/settings", to: "/super-admin/dashboard" },
  // The Platform Settings page (and its MFA step-up card) was removed;
  // platform settings are still listed read-only under Configuration.
  { from: "/super-admin/settings", to: "/super-admin/dashboard" },
  { from: "/organizations", to: "/super-admin/organizations" },
  { from: "/admin/billing", to: "/super-admin/financial-operations?section=overview" },
  { from: "/super-admin/commercial/dashboard", to: "/super-admin/dashboard" },
  { from: "/super-admin/commercial/organizations", to: "/super-admin/organizations" },
  { from: "/super-admin/commercial/organizations/:organizationId", to: "/super-admin/organizations/:organizationId" },
  // Rendered the exact same OrganizationsPage as /super-admin/organizations
  // under a second URL — the "Commercial" lens link from the Command Center
  // hub. One canonical route now; this one redirects instead of serving a
  // second copy.
  { from: "/super-admin/commercial/accounts", to: "/super-admin/organizations" },
  { from: "/super-admin/commercial/audit-logs", to: "/super-admin/audit-logs" },
  { from: "/super-admin/commercial/kill-switch", to: "/super-admin/kill-switch" },
  { from: "/super-admin/commercial/production-acceptance", to: "/super-admin/production-readiness" },
  { from: "/super-admin/command-center/triage", to: "/super-admin/triage" },
  { from: "/super-admin/command-center/commercial", to: "/super-admin/organizations" },
  { from: "/super-admin/command-center/financial", to: "/super-admin/financial-operations" },
  { from: "/super-admin/command-center/reliability", to: "/super-admin/reliability" },
  { from: "/super-admin/command-center/governance", to: "/super-admin/governance" },
  // Sidebar audit cleanup: these labels had no backend feature behind them
  // (Usage & Metering, Payment Gateways, Connectors, API & Webhooks
  // management, Imports & Exports) or duplicated another surviving entry
  // (Roles & Access == Administrators & Users). Redirected, not deleted, so
  // old bookmarks/links still land somewhere sensible.
  { from: "/super-admin/financial/usage", to: "/super-admin/financial-operations" },
  { from: "/super-admin/integrations", to: "/super-admin/reliability" },
  { from: "/super-admin/integrations/gateways", to: "/super-admin/reliability" },
  { from: "/super-admin/integrations/connectors", to: "/super-admin/reliability" },
  { from: "/super-admin/integrations/webhooks", to: "/super-admin/reliability" },
  { from: "/super-admin/integrations/imports-exports", to: "/super-admin/reliability" },
  { from: "/super-admin/integrations/jobs", to: "/super-admin/tenant-health?tab=jobs" },
  { from: "/super-admin/governance/roles", to: "/super-admin/users" },
  // Standalone copies of the Financial Operations hub's tabs. Each rendered
  // the same component as its hub tab under a second URL with its own header,
  // so there were two homes for every finance view. They now land on the tab.
  { from: "/super-admin/billing-command-center", to: "/super-admin/financial-operations?section=overview" },
  { from: "/super-admin/financial/invoice-engine", to: "/super-admin/financial-operations?section=invoice-engine" },
  { from: "/super-admin/financial/payments", to: "/super-admin/financial-operations?section=payments-recovery" },
  { from: "/super-admin/financial/balances", to: "/super-admin/financial-operations?section=balances-allocations" },
  { from: "/super-admin/financial/reconciliation", to: "/super-admin/financial-operations?section=tenant-ledger-reconciliation" },
  { from: "/super-admin/financial/credits", to: "/super-admin/financial-operations?section=credits-refunds" },
  { from: "/super-admin/financial/tax", to: "/super-admin/financial-operations?section=tax" },
  // Two labels that described pages no distinct page ever backed:
  // "Security Events" rendered the identical audit feed as "Audit & Evidence"
  // (no filter in AUDIT_ACTION_OPTIONS / AUDIT_ENTITY_OPTIONS isolates
  // security-relevant events), and "Data Quality" rendered a permanent
  // "not implemented" placeholder. The features they promised do not exist
  // in this codebase, so both redirect to the real page instead of serving a
  // second, differently-titled copy or a dead end.
  { from: "/super-admin/governance/security-events", to: "/super-admin/audit-logs" },
  { from: "/super-admin/reliability/data-quality", to: "/super-admin/reliability" },
];

registerRoutePreloads([
  ...BILLING_ROUTES,
  ...SUPER_ADMIN_ROUTES,
  { path: "/organization-admin/privileged-access-log", element: <OrgAdminPrivilegedAccessLogPage /> },
  { path: "/organization-admin/notifications", element: <OrgAdminNotificationsPage /> },
  { path: "/billing/workspace/dashboard", element: <BillingAdminWorkspaceDashboard /> },
  { path: "/billing/workspace/organization", element: <BillingAdminWorkspaceOrganization /> },
  { path: "/billing/workspace/subscription", element: <BillingAdminWorkspaceSubscription /> },
  { path: "/billing/workspace/zoiko-subscription", element: <BillingAdminWorkspaceZoikoSubscription /> },
  { path: "/billing/workspace/usage", element: <BillingAdminWorkspaceUsage /> },
  { path: "/billing/workspace/activity", element: <BillingAdminWorkspaceActivity /> },
  { path: "/billing/workspace/notifications", element: <BillingAdminWorkspaceNotifications /> },
  { path: "/billing/workspace/help", element: <BillingAdminWorkspaceHelp /> },
]);

function ModuleSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8F7F4]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}

function LandingRedirectComp() {
  const { user, isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (user.role === "super_admin") {
    return <Navigate to="/super-admin/dashboard" replace />;
  }
  const target = VALID_ROLES.includes(user.role) ? ROLE_DEFAULT_REDIRECT[user.role] : "/login";
  return <Navigate to={target} replace />;
}

// Substitutes any `:param` segments in a legacy redirect target with the
// current route's matched params, and preserves the query string, so a
// bookmarked/shared legacy URL (including detail pages) still lands on the
// exact equivalent canonical page rather than a generic top-level route.
function LegacyRedirect({ to }) {
  const params = useParams();
  const { search } = useLocation();
  const resolved = to.replace(/:([A-Za-z0-9_]+)/g, (match, name) =>
    params[name] !== undefined ? params[name] : match
  );
  // A target that already carries a query (e.g. ?section=tax) gets the
  // incoming query appended with "&", not a second "?".
  const joined = search ? `${resolved}${resolved.includes("?") ? "&" : "?"}${search.slice(1)}` : resolved;
  return <Navigate to={joined} replace />;
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", background: "#fff", color: "#b00", minHeight: "100vh" }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>Render Error</h1>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, background: "#fee", padding: 16, borderRadius: 8, border: "1px solid #fcc" }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
    <Suspense fallback={<ModuleSpinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/register/success" element={<RegistrationSuccessPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/auth/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
        <Route path="/estimate/:token" element={<PublicEstimatePage />} />
        <Route path="/invoice/:id" element={<PublicInvoicePage />} />
        <Route path="/platform-quote/:token" element={<PublicPlatformQuotePage />} />
        <Route path="/platform-invoice/:token" element={<PublicPlatformInvoicePage />} />
        <Route path="/platform-invoice/:token/success" element={<PaymentSuccessPage />} />
        <Route path="/platform-invoice/:token/checkout" element={<PlatformCheckoutPage />} />
        <Route element={<ProtectedRoute />}>
          {SUPER_ADMIN_LEGACY_REDIRECTS.map(({ from, to }) => (
            <Route key={from} path={from} element={<LegacyRedirect to={to} />} />
          ))}
          {BILLING_ROUTES.map(({ path, element }) => (
            <Route key={path} path={path} element={<BillingShell>{element}</BillingShell>} />
          ))}
          {SUPER_ADMIN_ROUTES.map(({ path, element }) => (
            <Route key={path} path={path} element={<BillingShell>{element}</BillingShell>} />
          ))}
          <Route
            path="/organization-admin/dashboard"
            element={
              <BillingShell>
                <OrgAdminDashboardPage />
              </BillingShell>
            }
          />
          <Route
            path="/organization-admin/organization"
            element={
              <BillingShell>
                <OrgAdminOrganizationPage />
              </BillingShell>
            }
          />
          <Route
            path="/organization-admin/users"
            element={
              <BillingShell>
                <OrgAdminUserManagementPage />
              </BillingShell>
            }
          />
          <Route
            path="/organization-admin/privileged-access-log"
            element={
              <BillingShell>
                <OrgAdminPrivilegedAccessLogPage />
              </BillingShell>
            }
          />
          <Route
            path="/organization-admin/notifications"
            element={
              <BillingShell>
                <OrgAdminNotificationsPage />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/dashboard"
            element={
              <BillingShell>
                <BillingAdminWorkspaceDashboard />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/organization"
            element={
              <BillingShell>
                <BillingAdminWorkspaceOrganization />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/subscription"
            element={
              <BillingShell>
                <BillingAdminWorkspaceSubscription />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/zoiko-subscription"
            element={
              <BillingShell>
                <BillingAdminWorkspaceZoikoSubscription />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/usage"
            element={
              <BillingShell>
                <BillingAdminWorkspaceUsage />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/activity"
            element={
              <BillingShell>
                <BillingAdminWorkspaceActivity />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/notifications"
            element={
              <BillingShell>
                <BillingAdminWorkspaceNotifications />
              </BillingShell>
            }
          />
          <Route
            path="/billing/workspace/help"
            element={
              <BillingShell>
                <BillingAdminWorkspaceHelp />
              </BillingShell>
            }
          />
        </Route>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<LandingRedirectComp />} />
      </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
