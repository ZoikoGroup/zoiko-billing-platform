import { createContext, useState, useEffect } from "react";
import { loadGlobalBillingConfig, subscribeBillingConfigInvalidation } from "../../../service/billingConfigCache";
import { getAccessToken } from "../../../service/sessionStorage";

const DEFAULT_TERMINOLOGY = "customer";

const TERMINOLOGY_MAP = {
  customer: { singular: "Customer", plural: "Customers" },
  client: { singular: "Client", plural: "Clients" },
  patient: { singular: "Patient", plural: "Patients" },
  member: { singular: "Member", plural: "Members" },
  tenant: { singular: "Tenant", plural: "Tenants" },
  subscriber: { singular: "Subscriber", plural: "Subscribers" },
};

const TerminologyContext = createContext(null);

let globalTerminology = null;
let globalPromise = null;
const listeners = new Set();

function notifyListeners() {
  listeners.forEach((fn) => fn(globalTerminology));
}

export function loadGlobalTerminology() {
  if (globalTerminology) return Promise.resolve(globalTerminology);
  if (globalPromise) return globalPromise;
  globalPromise = (async () => {
    try {
      const data = await loadGlobalBillingConfig();
      globalTerminology = data?.relationship_terminology || DEFAULT_TERMINOLOGY;
    } catch {
      globalTerminology = DEFAULT_TERMINOLOGY;
    }
    notifyListeners();
    return globalTerminology;
  })();
  return globalPromise;
}

// React to a settings save (or logout) invalidating the shared config cache:
// clear our own derived value and re-resolve so already-mounted consumers
// pick up the new terminology instead of serving a stale one until a hard
// reload. Only re-resolve while still authenticated: on logout the shared
// cache is invalidated AFTER the session is cleared, so re-fetching then
// only issues an unauthenticated 401.
subscribeBillingConfigInvalidation(() => {
  globalTerminology = null;
  globalPromise = null;
  if (getAccessToken()) loadGlobalTerminology();
});

export function getOrgTerminology() {
  return globalTerminology || DEFAULT_TERMINOLOGY;
}

export function useTerminology() {
  const [localTerminology, setLocalTerminology] = useState(globalTerminology || DEFAULT_TERMINOLOGY);
  const [loading, setLoading] = useState(!globalTerminology);

  useEffect(() => {
    if (globalTerminology) {
      setLocalTerminology(globalTerminology);
      setLoading(false);
      return;
    }
    const handler = (t) => {
      setLocalTerminology(t);
      setLoading(false);
    };
    listeners.add(handler);
    loadGlobalTerminology().then((t) => {
      setLocalTerminology(t);
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { listeners.delete(handler); };
  }, []);

  const key = (localTerminology || DEFAULT_TERMINOLOGY).toLowerCase();
  const entry = TERMINOLOGY_MAP[key] || TERMINOLOGY_MAP.customer;

  return {
    loading,
    terminology: key,
    singular: entry.singular,
    plural: entry.plural,
    getLabel: (labelType) => {
      const map = {
        singular: entry.singular,
        plural: entry.plural,
        singularLower: entry.singular.toLowerCase(),
        pluralLower: entry.plural.toLowerCase(),
        module: `${entry.plural} Management`,
        newButton: `New ${entry.singular}`,
        searchPlaceholder: `Search ${entry.plural.toLowerCase()}...`,
        emptyState: `No ${entry.plural.toLowerCase()} found`,
      };
      return map[labelType] || entry.singular;
    },
  };
}

export default TerminologyContext;
