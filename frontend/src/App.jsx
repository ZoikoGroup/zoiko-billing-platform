import React, { Suspense, lazy, useEffect } from "react";
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
import OrgAdminDashboardPage from "./modules/organization-admin/DashboardPage";
import OrgAdminOrganizationPage from "./modules/organization-admin/OrganizationPage";
import OrgAdminUserManagementPage from "./modules/organization-admin/UserManagementPage";
import { ROLE_DEFAULT_REDIRECT, VALID_ROLES } from "./config/roles";

const BillingAdminWorkspaceDashboard = lazy(() => import("./modules/billing-admin/WorkspaceDashboardPage"));
const BillingAdminWorkspaceOrganization = lazy(() => import("./modules/billing-admin/WorkspaceOrganizationPage"));
const BillingAdminWorkspaceSubscription = lazy(() => import("./modules/billing-admin/WorkspaceSubscriptionPage"));
const BillingAdminWorkspaceActivity = lazy(() => import("./modules/billing-admin/WorkspaceActivityPage"));
const BillingAdminWorkspaceNotifications = lazy(() => import("./modules/billing-admin/WorkspaceNotificationsPage"));
const BillingAdminWorkspaceHelp = lazy(() => import("./modules/billing-admin/WorkspaceHelpPage"));

// Platform pages pull in billing-shared.jsx's shared component kit; lazy
// loading keeps that out of the eagerly-loaded main bundle (matches every
// other route below).
const UsersPage = lazy(() => import("./pages/UsersPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const BillingDashboard = lazy(() => import("./modules/billing/dashboard/dashboard"));
const ReportsPage = lazy(() => import("./modules/billing/dashboard/reports"));
const ForecastReport = lazy(() => import("./modules/billing/dashboard/forecast-report"));
const BillingSettingsPage = lazy(() => import("./modules/billing/dashboard/settings"));
const CustomerDashboardPage = lazy(() => import("./modules/billing/customers/customer-dashboard"));
const CustomerListPage = lazy(() => import("./modules/billing/customers/customer-list"));
const CustomerProfilePage = lazy(() => import("./modules/billing/customers/customer-profile"));
const CustomerBillingHistoryPage = lazy(() => import("./modules/billing/customers/billing-history"));
const CustomerReportsPage = lazy(() => import("./modules/billing/customers/reports"));
const CustomerProfitabilityReport = lazy(() => import("./modules/billing/customers/profitability-report"));
const CustomerSettingsPage = lazy(() => import("./modules/billing/customers/settings"));
const ProductDashboardPage = lazy(() => import("./modules/billing/products/dashboard"));
const ProductListPage = lazy(() => import("./modules/billing/products/product-list"));
const ProductProfilePage = lazy(() => import("./modules/billing/products/product-profile"));
const ProductCategoriesPage = lazy(() => import("./modules/billing/products/categories"));
const UsageBillingPage = lazy(() => import("./modules/billing/products/usage-billing"));
const ProductPricingPlansPage = lazy(() => import("./modules/billing/products/pricing-plans"));
const ProductReportsPage = lazy(() => import("./modules/billing/products/reports"));
const ProductSettingsPage = lazy(() => import("./modules/billing/products/settings"));
const PricingDashboardPage = lazy(() => import("./modules/billing/pricing/dashboard"));
const PricingPlansPage = lazy(() => import("./modules/billing/pricing/pricing-plans"));
const TierManagementPage = lazy(() => import("./modules/billing/pricing/tier-management"));
const PricingReportsPage = lazy(() => import("./modules/billing/pricing/reports"));
const PricingSettingsPage = lazy(() => import("./modules/billing/pricing/settings"));
const PriceListsPage = lazy(() => import("./modules/billing/pricing/price-lists"));
const PricingRulesPage = lazy(() => import("./modules/billing/pricing/pricing-rules"));
const DiscountEnginePage = lazy(() => import("./modules/billing/pricing/discount-engine"));
const CurrencyPricingPage = lazy(() => import("./modules/billing/pricing/currency-pricing"));
const TaxPricingPage = lazy(() => import("./modules/billing/pricing/tax-pricing"));
const QuotationListPage = lazy(() => import("./modules/billing/quotations/quotation-list"));
const QuotationDashboardPage = lazy(() => import("./modules/billing/quotations/dashboard"));
const QuotationDetailPage = lazy(() => import("./modules/billing/quotations/quotation-detail"));
const QuotationWizardPage = lazy(() => import("./modules/billing/quotations/quotation-create"));
const QuotationReportsPage = lazy(() => import("./modules/billing/quotations/reports"));
const QuotationSettingsPage = lazy(() => import("./modules/billing/quotations/settings"));
const ContractListPage = lazy(() => import("./modules/billing/contracts/contract-list"));
const ContractDashboardPage = lazy(() => import("./modules/billing/contracts/dashboard"));
const ContractDetailPage = lazy(() => import("./modules/billing/contracts/contract-detail"));
const ContractCreateWizardPage = lazy(() => import("./modules/billing/contracts/contract-create"));
const ContractEditPage = lazy(() => import("./modules/billing/contracts/contract-edit"));
const ContractReportsPage = lazy(() => import("./modules/billing/contracts/reports"));
const ContractSettingsPage = lazy(() => import("./modules/billing/contracts/settings"));
const RetainersPage = lazy(() => import("./modules/billing/contracts/retainers"));
const SubscriptionsPage = lazy(() => import("./modules/billing/subscriptions/subscription-list"));
const SubscriptionDashboardPage = lazy(() => import("./modules/billing/subscriptions/dashboard"));
const SubscriptionDetailPage = lazy(() => import("./modules/billing/subscriptions/subscription-detail"));
const CreateSubscriptionWizardPage = lazy(() => import("./modules/billing/subscriptions/subscription-create"));
const SubscriptionReportsPage = lazy(() => import("./modules/billing/subscriptions/reports"));
const SubscriptionSettingsPage = lazy(() => import("./modules/billing/subscriptions/settings"));
const InvoiceSchedulesPage = lazy(() => import("./modules/billing/subscriptions/invoice-schedules"));
const InvoicingPage = lazy(() => import("./modules/billing/invoicing/invoice-list"));
const InvoiceDashboardPage = lazy(() => import("./modules/billing/invoicing/invoice-dashboard"));
const CreateInvoiceWizardPage = lazy(() => import("./modules/billing/invoicing/create-invoice-wizard"));
const InvoiceDetailPage = lazy(() => import("./modules/billing/invoicing/invoice-detail"));
const CreditNotesPage = lazy(() => import("./modules/billing/invoicing/credit-notes"));
const CreditNoteDashboardPage = lazy(() => import("./modules/billing/invoicing/credit-note-dashboard"));
const CreditNoteDetailPage = lazy(() => import("./modules/billing/invoicing/credit-note-detail"));
const InvoiceReportsPage = lazy(() => import("./modules/billing/invoicing/reports"));
const InvoiceSettingsPage = lazy(() => import("./modules/billing/invoicing/settings"));
const MoneyInPage = lazy(() => import("./modules/billing/payments/payment-list"));
const PaymentDashboardPage = lazy(() => import("./modules/billing/payments/payment-dashboard"));
const PaymentDetailPage = lazy(() => import("./modules/billing/payments/payment-detail"));
const PaymentReportsPage = lazy(() => import("./modules/billing/payments/reports"));
const PaymentSettingsPage = lazy(() => import("./modules/billing/payments/settings"));
const CollectionsReceivablesPage = lazy(() => import("./modules/billing/payments/collections-receivables"));
const CollectionsDashboardPage = lazy(() => import("./modules/billing/payments/collections-dashboard"));
const CollectionsCaseDetailPage = lazy(() => import("./modules/billing/payments/collections-case-detail"));
const DunningPage = lazy(() => import("./modules/billing/payments/dunning"));
const DunningCaseDetailPage = lazy(() => import("./modules/billing/payments/dunning-case-detail"));
const DunningLevelsPage = lazy(() => import("./modules/billing/payments/dunning-levels"));
const PromiseToPayPage = lazy(() => import("./modules/billing/payments/promise-to-pay"));
const CreditsPage = lazy(() => import("./modules/billing/payments/credits"));
const RefundsPage = lazy(() => import("./modules/billing/payments/refunds"));
const RefundDashboardPage = lazy(() => import("./modules/billing/payments/refund-dashboard"));
const RefundDetailPage = lazy(() => import("./modules/billing/payments/refund-detail"));
const WriteOffsPage = lazy(() => import("./modules/billing/payments/write-offs"));
const WriteOffDashboardPage = lazy(() => import("./modules/billing/payments/write-off-dashboard"));
const WriteOffDetailPage = lazy(() => import("./modules/billing/payments/write-off-detail"));
const TaxPage = lazy(() => import("./modules/billing/tax/tax-rates"));
const TaxDashboardPage = lazy(() => import("./modules/billing/tax/dashboard"));
const TaxConfigurationPage = lazy(() => import("./modules/billing/tax/tax-configuration"));
const TaxReportsPage = lazy(() => import("./modules/billing/tax/reports"));
const TaxSettingsPage = lazy(() => import("./modules/billing/tax/settings"));

const CommercialOrganizationsPage = lazy(() => import("./modules/super-admin/OrganizationsPage"));
const CommercialOrganizationDetailPage = lazy(() => import("./modules/super-admin/OrganizationDetailPage"));
const CommercialPlansPage = lazy(() => import("./modules/super-admin/PlansPage"));
const CommercialSubscriptionsPage = lazy(() => import("./modules/super-admin/SubscriptionsPage"));
const CommercialEntitlementsPage = lazy(() => import("./modules/super-admin/EntitlementsPage"));
const Plane1BillingPage = lazy(() => import("./modules/super-admin/Plane1BillingPage"));
const CommercialAuditLogsPage = lazy(() => import("./modules/super-admin/AuditLogsPage"));
const CommercialPlanVersionsPage = lazy(() => import("./modules/super-admin/CommercialPlanVersionsPage"));
const ApprovalQueuePage = lazy(() => import("./modules/super-admin/ApprovalQueuePage"));
const KillSwitchPage = lazy(() => import("./modules/super-admin/KillSwitchPage"));
const ProductionAcceptancePage = lazy(() => import("./modules/super-admin/ProductionAcceptancePage"));
const PlatformDashboardPage = lazy(() => import("./modules/super-admin/PlatformDashboardPage"));
const SupportAccessPage = lazy(() => import("./modules/super-admin/SupportAccessPage"));
const TenantHealthPage = lazy(() => import("./modules/super-admin/TenantHealthPage"));
const LifecycleOnboardingPage = lazy(() => import("./modules/super-admin/LifecycleOnboardingPage"));
const GovernancePage = lazy(() => import("./modules/super-admin/GovernancePage"));
const ConfigurationGovernancePage = lazy(() => import("./modules/super-admin/ConfigurationGovernancePage"));
const ReliabilityPage = lazy(() => import("./modules/super-admin/ReliabilityPage"));
const LaunchReadinessPage = lazy(() => import("./modules/super-admin/LaunchReadinessPage"));
const TriagePage = lazy(() => import("./modules/super-admin/TriagePage"));
const CommandCenterHubPage = lazy(() => import("./modules/super-admin/CommandCenterHubPage"));
const FinancialOperationsPage = lazy(() => import("./modules/super-admin/FinancialOperationsPage"));
const BillingCommandCenterPage = lazy(() => import("./modules/super-admin/BillingCommandCenterPage"));
const OrgAdminPrivilegedAccessLogPage = lazy(() => import("./modules/organization-admin/PrivilegedAccessLogPage"));

const BILLING_ROUTES = [
  { path: "/billing", element: <BillingDashboard /> },
  { path: "/billing/reports", element: <ReportsPage /> },
  { path: "/billing/reports/forecast", element: <ForecastReport /> },
  { path: "/billing/settings", element: <BillingSettingsPage /> },
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
  { path: "/super-admin/settings", element: <SettingsPage /> },
  { path: "/super-admin/platform/lifecycle", element: <LifecycleOnboardingPage /> },
  { path: "/super-admin/support-access", element: <SupportAccessPage /> },
  { path: "/super-admin/tenant-health", element: <TenantHealthPage /> },
  { path: "/super-admin/commercial/accounts", element: <CommercialOrganizationsPage /> },
  { path: "/super-admin/commercial/plans", element: <CommercialPlansPage /> },
  { path: "/super-admin/commercial/plans/:planId/versions", element: <CommercialPlanVersionsPage /> },
  { path: "/super-admin/commercial/offers", element: <CommercialPlansPage /> },
  { path: "/super-admin/commercial/subscriptions", element: <CommercialSubscriptionsPage /> },
  { path: "/super-admin/commercial/entitlements", element: <CommercialEntitlementsPage /> },
  { path: "/super-admin/commercial/invoices", element: <Plane1BillingPage /> },
  { path: "/super-admin/financial/invoice-engine", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial/payments", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial/balances", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial/reconciliation", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial/credits", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial/usage", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial/tax", element: <FinancialOperationsPage /> },
  { path: "/super-admin/financial-operations", element: <FinancialOperationsPage /> },
  { path: "/super-admin/billing-command-center", element: <BillingCommandCenterPage /> },
  { path: "/super-admin/integrations", element: <ReliabilityPage /> },
  { path: "/super-admin/integrations/gateways", element: <ReliabilityPage /> },
  { path: "/super-admin/integrations/connectors", element: <ReliabilityPage /> },
  { path: "/super-admin/integrations/webhooks", element: <ReliabilityPage /> },
  { path: "/super-admin/integrations/jobs", element: <TenantHealthPage /> },
  { path: "/super-admin/integrations/imports-exports", element: <ReliabilityPage /> },
  { path: "/super-admin/approval-queue", element: <ApprovalQueuePage /> },
  { path: "/super-admin/audit-logs", element: <CommercialAuditLogsPage /> },
  { path: "/super-admin/governance", element: <GovernancePage /> },
  { path: "/super-admin/governance/roles", element: <UsersPage /> },
  { path: "/super-admin/governance/privileged-sessions", element: <SupportAccessPage /> },
  { path: "/super-admin/governance/security-events", element: <CommercialAuditLogsPage /> },
  { path: "/super-admin/governance/data", element: <GovernancePage /> },
{ path: "/super-admin/governance/configuration", element: <ConfigurationGovernancePage /> },
  { path: "/super-admin/reliability", element: <ReliabilityPage /> },
  { path: "/super-admin/reliability/incidents", element: <TriagePage /> },
  { path: "/super-admin/reliability/reprocessing", element: <TriagePage /> },
  { path: "/super-admin/reliability/data-quality", element: <ReliabilityPage /> },
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
  { from: "/settings", to: "/super-admin/settings" },
  { from: "/organizations", to: "/super-admin/organizations" },
  { from: "/admin/billing", to: "/super-admin/billing-command-center" },
  { from: "/super-admin/commercial/dashboard", to: "/super-admin/dashboard" },
  { from: "/super-admin/commercial/organizations", to: "/super-admin/organizations" },
  { from: "/super-admin/commercial/organizations/:organizationId", to: "/super-admin/organizations/:organizationId" },
  { from: "/super-admin/commercial/audit-logs", to: "/super-admin/audit-logs" },
  { from: "/super-admin/commercial/approvals", to: "/super-admin/approval-queue" },
  { from: "/super-admin/commercial/kill-switch", to: "/super-admin/kill-switch" },
  { from: "/super-admin/commercial/production-acceptance", to: "/super-admin/production-readiness" },
  { from: "/super-admin/command-center/triage", to: "/super-admin/triage" },
  { from: "/super-admin/command-center/commercial", to: "/super-admin/commercial/accounts" },
  { from: "/super-admin/command-center/financial", to: "/super-admin/financial-operations" },
  { from: "/super-admin/command-center/reliability", to: "/super-admin/reliability" },
  { from: "/super-admin/command-center/governance", to: "/super-admin/governance" },
];

function ModuleSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8F7F4]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#FF7A00] border-t-transparent" />
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
  return <Navigate to={`${resolved}${search}`} replace />;
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
