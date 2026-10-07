// Same status set as RefundRepository's "outstanding_value" (the Refunds
// Dashboard "Outstanding (In Flight)" tile). The refunds list API accepts a
// comma-separated status list (BaseRepository._apply_filter -> IN clause).
export const REFUND_IN_FLIGHT_STATUSES = "draft,pending_approval,approved,processing,pending";

// Same status set as the Refunds Dashboard "Failed / Cancelled" tile, whose
// value is failed_count + cancelled_count -- and RefundRepository's
// cancelled_count counts both "cancelled" and "rejected".
export const REFUND_FAILED_OR_CANCELLED_STATUSES = "failed,cancelled,rejected";
