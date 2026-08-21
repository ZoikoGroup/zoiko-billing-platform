/**
 * components/ZoikoMark.jsx
 * ------------------------
 * Canonical Zoiko Billing product mark ("Z" monogram on the same deep-purple
 * gradient as the billing shell sidebar). Per the Chatbot UI/UX design spec
 * (§2 Design Principles, §6 Component Library): the assistant must feel native
 * to Zoiko Billing — "do not create a visually independent AI brand" and "use
 * the Zoiko Billing/product icon family where available; do not introduce a
 * separate AI icon set". Generic bot/robot glyphs must not represent the
 * assistant; this mark does.
 */

const ZOIKO_GRADIENT = "linear-gradient(135deg, #1F0B63 0%, #160845 100%)";

export default function ZoikoMark({
  size = 32,
  rounded = "rounded-lg",
  showAccentDot = false,
  className = "",
}) {
  return (
    <span
      className={`relative inline-flex flex-shrink-0 select-none items-center justify-center ${rounded} ${className}`}
      style={{ width: size, height: size, background: ZOIKO_GRADIENT }}
      aria-hidden="true"
    >
      <span
        style={{
          color: "#ffffff",
          fontWeight: 800,
          fontSize: Math.max(10, Math.round(size * 0.52)),
          lineHeight: 1,
          letterSpacing: "-0.02em",
          fontFamily: "inherit",
        }}
      >
        Z
      </span>
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
