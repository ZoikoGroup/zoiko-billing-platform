import { useCallback, useEffect, useRef } from "react";

// Beyond ignoring stale responses, the function returned by beginRequest()
// carries `.signal` (AbortSignal): pass it to api.get(..., { signal }) and the
// previous in-flight request is cancelled when a newer one starts or on unmount.
// Aborted requests reject with an AbortError (see isAbortError in service/api.js)
// which is harmless here because the response is no longer current.

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
  const controllerRef = useRef(null);
  useEffect(() => () => {
    seqRef.current += 1;
    controllerRef.current?.abort();
  }, []);
  return useCallback(() => {
    const seq = ++seqRef.current;
    controllerRef.current?.abort();
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    controllerRef.current = controller;
    const isCurrent = () => seq === seqRef.current;
    isCurrent.signal = controller?.signal;
    return isCurrent;
  }, []);
}
