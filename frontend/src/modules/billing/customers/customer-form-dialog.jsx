/**
 * customer-form-dialog.jsx
 * ------------------------
 * The customer create / edit form, built on the shared form pattern (the
 * reference screen for every create/edit form in the app):
 *  - shared Modal: full-screen sheet on phones with a back arrow, title and
 *    "Section X of Y"; centred dialog on tablet/desktop. Header and footer stay
 *    put while only the fields scroll, so Cancel + Save are always visible.
 *  - fields grouped into SectionCards; one column below sm, two from sm.
 *  - "*" on required fields plus one "* Required" note.
 *  - closing with unsaved edits (back, X, Cancel, Esc) asks first; reload /
 *    in-app links are guarded too. "Unsaved" means the values differ from
 *    what the form opened with, so the guard never fires after a save (the
 *    dialog unmounts) or when nothing was changed.
 *
 * State, validation and API calls stay in customer-list.jsx; this component
 * only renders the fields and wires them to the setters it is given.
 */

import { useRef, useState } from "react";
import { AlertCircle, CreditCard, FileText, MapPin, Receipt, Users } from "lucide-react";
import {
  Button,
  Field,
  FORM_CONTROL_CLASS,
  FormGrid,
  Modal,
  RequiredNote,
  FormSection,
  useActiveSection,
  useUnsavedChangesGuard,
} from "../../../components/billing-ui";
import { SubscriptionLimitReached } from "../../../components/billing-shared";
import { getCurrencySelectOptions, getCountrySelectOptions } from "../../../utils/currency";
import { getCustomerTaxFields } from "../utils/countryIntelligence";

const CUSTOMER_TYPES = [
  { value: "business", label: "Business" },
  { value: "individual", label: "Individual" },
  { value: "non_profit", label: "Non-Profit" },
  { value: "government", label: "Government" },
];

const PAYMENT_TERMS = [
  { value: "due_on_receipt", label: "Due on Receipt" },
  { value: "net_15", label: "Net 15" },
  { value: "net_30", label: "Net 30" },
  { value: "net_45", label: "Net 45" },
  { value: "net_60", label: "Net 60" },
  { value: "net_90", label: "Net 90" },
];

const SELECT_CLASS = `${FORM_CONTROL_CLASS} bg-white`;

/**
 * Props:
 *  mode            "create" | "edit"
 *  values, setValues    the form state and its setter (newCustomer / editCustomer)
 *  onSubmit        handleCreate / handleUpdate
 *  onCancel        closes the dialog (called only after unsaved edits are confirmed)
 *  confirm         useConfirmationDialog().confirm from the page
 *  loading, error, limitError, onDismissLimit
 *  singular, plural, defaultCustomerType, requireBillingAddress, requireTaxId
 *  paymentTermsCreditDays   PAYMENT_TERMS_CREDIT_DAYS map
 *  onBillingCountryChange   the page's existing billing-country handler (currency prompt)
 */
export default function CustomerFormDialog({
  mode,
  values,
  setValues,
  onSubmit,
  onCancel,
  confirm,
  loading,
  error,
  limitError,
  onDismissLimit,
  singular,
  plural,
  defaultCustomerType,
  requireBillingAddress,
  requireTaxId,
  paymentTermsCreditDays,
  onBillingCountryChange,
}) {
  const isCreate = mode === "create";
  const idp = isCreate ? "customer-new" : "customer-edit";
  const title = isCreate ? `New ${singular}` : `Edit ${singular}`;

  // Unsaved = differs from what the form opened with.
  const [baseline] = useState(() => JSON.stringify(values));
  const dirty = JSON.stringify(values) !== baseline;
  useUnsavedChangesGuard(dirty, `You have unsaved changes to this ${singular.toLowerCase()}. Leave and discard them?`);

  const pendingRef = useRef(false);
  const requestClose = async () => {
    if (loading || pendingRef.current) return;
    if (!dirty) {
      onCancel();
      return;
    }
    pendingRef.current = true;
    const discard = await confirm({
      title: "Discard changes?",
      message: `You have unsaved changes to this ${singular.toLowerCase()}. Close the form and discard them?`,
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      tone: "danger",
    });
    pendingRef.current = false;
    if (discard) onCancel();
  };

  const bodyRef = useRef(null);
  const { index: sectionIndex, total: sectionTotal } = useActiveSection(bodyRef);

  const set = (field) => (e) => {
    const value = e.target.value;
    setValues((p) => ({ ...p, [field]: value }));
  };

  const textField = (field, label, { type = "text", required = false, placeholder, ariaLabel } = {}) => (
    <Field label={label} htmlFor={`${idp}-${field}`} required={required}>
      <input
        id={`${idp}-${field}`}
        type={type}
        aria-label={ariaLabel}
        aria-required={required || undefined}
        value={values[field] ?? ""}
        onChange={set(field)}
        placeholder={placeholder}
        className={FORM_CONTROL_CLASS}
      />
    </Field>
  );

  const countrySelect = (field, label, onChange) => (
    <Field label={label} htmlFor={`${idp}-${field}`}>
      <select id={`${idp}-${field}`} value={values[field] || ""} onChange={onChange || set(field)} className={SELECT_CLASS}>
        <option value="">Select Country</option>
        {getCountrySelectOptions().map((c) => (
          <option key={c.code} value={c.value}>{c.label}</option>
        ))}
      </select>
    </Field>
  );

  const taxFields = getCustomerTaxFields(values.billing_country);

  return (
    <Modal
      open
      onClose={requestClose}
      closeOnBackdrop={false}
      title={title}
      size="3xl"
      mobileBack
      bodyRef={bodyRef}
      headerAside={
        sectionTotal > 1 ? (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 sm:hidden">
            Section {sectionIndex} of {sectionTotal}
          </span>
        ) : null
      }
      footer={
        <>
          <Button variant="secondary" onClick={requestClose} disabled={loading} className="min-h-11 sm:min-h-0">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={loading}
            disabled={isCreate && !values.company_name}
            className="min-h-11 sm:min-h-0"
          >
            {isCreate ? (loading ? "Creating..." : `Create ${singular}`) : loading ? "Saving..." : "Save Changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 lg:space-y-3">
        <RequiredNote />

        {limitError ? (
          <SubscriptionLimitReached error={limitError} terminology={{ singular, plural }} onClose={onDismissLimit} />
        ) : error ? (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <FormSection title="Basic details" description="Who this account is and how to reach them." icon={Users}>
          <FormGrid dense>
            {textField("company_name", "Company Name", { required: true })}
            {textField("display_name", "Display Name")}
            {textField("email", "Email", { type: "email", required: isCreate })}
            {textField("phone", "Phone")}
            {textField("website", "Website", { placeholder: "https://example.com" })}
            <Field label="Customer Type" htmlFor={`${idp}-customer_type`}>
              <select
                id={`${idp}-customer_type`}
                value={values.customer_type || (isCreate ? defaultCustomerType : "business")}
                onChange={set("customer_type")}
                className={SELECT_CLASS}
              >
                {CUSTOMER_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </Field>
          </FormGrid>
        </FormSection>

        <FormSection title="Billing terms" description="Currency, payment terms and credit." icon={CreditCard}>
          <FormGrid cols={4} dense>
            <Field label="Currency" htmlFor={`${idp}-currency`}>
              <select id={`${idp}-currency`} value={values.currency || ""} onChange={set("currency")} className={SELECT_CLASS}>
                <option value="">Select</option>
                {getCurrencySelectOptions().map((c) => (
                  <option key={c.value} value={c.value}>{isCreate ? `${c.value} - ${c.label}` : c.value}</option>
                ))}
              </select>
            </Field>
            <Field label="Payment Terms" htmlFor={`${idp}-payment_terms`}>
              <select
                id={`${idp}-payment_terms`}
                value={values.payment_terms || "net_30"}
                onChange={(e) => {
                  const t = e.target.value;
                  setValues((p) => ({ ...p, payment_terms: t, credit_days: paymentTermsCreditDays[t] ?? 30 }));
                }}
                className={SELECT_CLASS}
              >
                {PAYMENT_TERMS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Credit Limit" htmlFor={`${idp}-credit_limit`}>
              <input
                id={`${idp}-credit_limit`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={values.credit_limit ?? ""}
                onChange={set("credit_limit")}
                placeholder="0.00"
                className={FORM_CONTROL_CLASS}
              />
            </Field>
            <Field label="Credit Days" htmlFor={`${idp}-credit_days`}>
              <input
                id={`${idp}-credit_days`}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={values.credit_days ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setValues((p) => ({ ...p, credit_days: v === "" ? "" : Math.max(0, parseInt(v, 10) || 0) }));
                }}
                placeholder="0"
                className={FORM_CONTROL_CLASS}
              />
            </Field>
          </FormGrid>
        </FormSection>

        <FormSection title="Addresses" description="Where invoices and goods are sent." icon={MapPin}>
          <FormGrid dense>
            <Field label="Billing Address" htmlFor={`${idp}-billing_address`} required={requireBillingAddress}>
              <textarea
                id={`${idp}-billing_address`}
                rows={2}
                aria-required={requireBillingAddress || undefined}
                value={values.billing_address || ""}
                onChange={set("billing_address")}
                placeholder={isCreate ? "Street, City, State, ZIP, Country" : undefined}
                className={FORM_CONTROL_CLASS}
              />
            </Field>
            {countrySelect("billing_country", "Billing Country", onBillingCountryChange)}
            {isCreate ? (
              <div className="sm:col-span-2">
                <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={Boolean(values.shipping_same_as_billing)}
                    onChange={(e) => {
                      const same = e.target.checked;
                      setValues((p) => ({
                        ...p,
                        shipping_same_as_billing: same,
                        shipping_address: same ? p.billing_address : "",
                        shipping_country: same ? p.billing_country : "",
                      }));
                    }}
                    className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand/30"
                  />
                  Same as billing
                </label>
              </div>
            ) : null}
            {(!isCreate || !values.shipping_same_as_billing) && (
              <>
                <Field label="Shipping Address" htmlFor={`${idp}-shipping_address`}>
                  <textarea
                    id={`${idp}-shipping_address`}
                    rows={2}
                    value={values.shipping_address || ""}
                    onChange={set("shipping_address")}
                    placeholder={isCreate ? "Street, City, State, ZIP, Country" : undefined}
                    className={FORM_CONTROL_CLASS}
                  />
                </Field>
                {countrySelect("shipping_country", "Shipping Country")}
              </>
            )}
          </FormGrid>
        </FormSection>

        <FormSection title="Tax identifiers" description="Registration numbers printed on invoices." icon={Receipt}>
          <FormGrid dense>
            {!isCreate &&
              textField("tax_id", "Tax ID", { required: requireTaxId, placeholder: "GST / VAT / Tax registration number", ariaLabel: "Tax ID" })}
            {taxFields.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`${idp}-${f.key}`}>
                <input
                  id={`${idp}-${f.key}`}
                  value={values[f.key] || ""}
                  onChange={set(f.key)}
                  placeholder={f.placeholder}
                  className={FORM_CONTROL_CLASS}
                />
              </Field>
            ))}
            {!values.billing_country && (
              <p className="text-xs text-slate-500 sm:col-span-2">
                Select a billing country above to show its relevant tax identifier(s).
                {isCreate && requireTaxId ? " A tax ID is required for new customers." : ""}
              </p>
            )}
            {isCreate && values.billing_country && requireTaxId && (
              <p className="text-xs text-slate-500 sm:col-span-2">A tax ID is required for new customers: fill in at least one of the fields above.</p>
            )}
          </FormGrid>
        </FormSection>

        {isCreate && (
          <FormSection title="Notes" description="Internal notes, not shown to the customer." icon={FileText}>
            <Field label="Notes" htmlFor={`${idp}-notes`}>
              <textarea id={`${idp}-notes`} rows={3} value={values.notes || ""} onChange={set("notes")} className={FORM_CONTROL_CLASS} />
            </Field>
          </FormSection>
        )}
      </div>
    </Modal>
  );
}
