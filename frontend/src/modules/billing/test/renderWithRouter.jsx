import { render } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Shared helper for Billing module tests. Existing test files each hand-roll
// their own <MemoryRouter> wrapper (see src/modules/super-admin/*.test.jsx);
// this is the same pattern factored out once, for reuse across the Billing
// suite specifically, since none of the Billing pages need anything beyond
// routing context (no Redux/Auth provider is required by these components —
// see CurrencyContext/TerminologyContext/DateRangeContext, which all fall
// back to module-level state instead of throwing without a <Provider>).
//
// - routePath: the <Route path> to mount the element under (needed for
//   pages that call useParams(), e.g. "/billing/quotations/:id").
// - initialEntries: the MemoryRouter history stack (defaults to routePath
//   with ":id" replaced isn't attempted — pass the concrete path).
export function renderWithRouter(ui, { routePath, initialEntries = ["/"] } = {}) {
  if (routePath) {
    return render(
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path={routePath} element={ui} />
        </Routes>
      </MemoryRouter>
    );
  }
  return render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}
