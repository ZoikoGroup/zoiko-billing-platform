/**
 * components/ZoikoMark.jsx
 * ------------------------
 * Canonical Zoiko Billing product mark — renders ONLY the Z symbol cropped
 * from the official zoiko-billing-logo.png. No "ZOIKO" text, no "BILLING"
 * text, no recreation, no approximation.
 *
 * Source: zoiko-billing-logo.png cropped at (70, 60, 774, 737) — the exact
 * pixel region of the Z character. Verified: no oiko/billing content.
 * Colors: #08233f (navy) + #079add blue gradient — identical to original.
 */

const ICON_SRC = "/zoiko-icon.png";

export default function ZoikoMark({
  size = 32,
  rounded = "rounded-lg",
  showAccentDot = false,
  className = "",
}) {
  return (
    <span
      className={`relative inline-flex flex-shrink-0 items-center justify-center overflow-hidden ${rounded} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img
        src={ICON_SRC}
        alt=""
        draggable={false}
        style={{
          width: size,
          height: size,
          display: "block",
          pointerEvents: "none",
        }}
      />
      {showAccentDot && (
        <span
          className="absolute border-2 border-white"
          style={{
            width: Math.max(8, Math.round(size * 0.22)),
            height: Math.max(8, Math.round(size * 0.22)),
            right: -1,
            top: -1,
            borderRadius: "9999px",
            backgroundColor: "#ff7a00",
          }}
        />
      )}
    </span>
  );
}
