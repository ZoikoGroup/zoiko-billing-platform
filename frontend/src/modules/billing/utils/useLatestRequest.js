import { useCallback, useEffect, useRef } from "react";

// Only the most recent request may update state.
//
// When filters, search, page or date range change quickly, several requests
// are in flight at once and can resolve out of order; without a guard an
// older response overwrites the newer one (e.g. a ?status=overdue list
// showing every invoice). Usage:
//
//   const beginRequest = useLatestRequest();
//   const load = useCallback(async () => {
//     const isCurrent = beginRequest();
//     try {
//       const data = await api.list(params);
//       if (!isCurrent()) return;
//       setItems(data.items);
//     } catch (err) {
//       if (!isCurrent()) return;
//       setError(...);
//     } finally {
//       if (isCurrent()) setLoading(false);
//     }
//   }, [beginRequest, ...params]);
//
// Responses that arrive after unmount are also ignored.
export default function useLatestRequest() {
  const seqRef = useRef(0);
  useEffect(() => () => { seqRef.current += 1; }, []);
  return useCallback(() => {
    const seq = ++seqRef.current;
    return () => seq === seqRef.current;
  }, []);
}
