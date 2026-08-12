import { Link } from "react-router-dom";

const styles = {
  root: {
    backgroundColor: "#110d2e",
    color: "#ffffff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    width: "100%",
    marginTop: "48px",
  },
  main: {
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "40px 28px",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "28px",
  },
  brand: {},
  logoWrap: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "14px",
  },
  logoIcon: {
    width: "36px",
    height: "36px",
    borderRadius: "8px",
    background: "linear-gradient(135deg, #f97316 40%, #3b82f6 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "18px",
    color: "#ffffff",
    fontWeight: "700",
    fontStyle: "italic",
  },
  logoText: { fontSize: "16px", fontWeight: "700", color: "#ffffff" },
  brandDesc: {
    fontSize: "12.5px",
    color: "rgba(255,255,255,0.55)",
    lineHeight: "1.5",
    marginBottom: "18px",
  },
  colTitle: {
    fontSize: "11.5px",
    fontWeight: "700",
    color: "#f97316",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "14px",
  },
  list: { listStyle: "none", padding: "0", margin: "0" },
  item: { marginBottom: "10px" },
  link: {
    color: "rgba(255,255,255,0.72)",
    textDecoration: "none",
    fontSize: "13px",
    lineHeight: "1.4",
    display: "block",
  },
  legal: {
    borderTop: "1px solid rgba(255,255,255,0.1)",
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "20px 28px 28px",
    fontSize: "12px",
    color: "rgba(255,255,255,0.4)",
    display: "flex",
    flexWrap: "wrap",
    gap: "6px 20px",
    justifyContent: "center",
  },
};

export default function Footer() {
  return (
    <footer style={styles.root}>
      <div style={styles.main}>
        <div style={styles.brand}>
          <div style={styles.logoWrap}>
            <div style={styles.logoIcon}>1</div>
            <span style={styles.logoText}>Zoiko Billing</span>
          </div>
          <p style={styles.brandDesc}>
            Invoicing, subscriptions and revenue collection in one platform.
          </p>
        </div>

        <div>
          <div style={styles.colTitle}>Product</div>
          <ul style={styles.list}>
            <li style={styles.item}>
              <Link to="/register" style={styles.link}>Create your account</Link>
            </li>
            <li style={styles.item}>
              <Link to="/login" style={styles.link}>Sign in</Link>
            </li>
          </ul>
        </div>

        <div>
          <div style={styles.colTitle}>Support</div>
          <ul style={styles.list}>
            <li style={styles.item}>
              <Link to="/forgot-password" style={styles.link}>Forgot password</Link>
            </li>
          </ul>
        </div>
      </div>

      <div style={styles.legal}>
        <span>© 2026 Zoiko Billing. All rights reserved.</span>
      </div>
    </footer>
  );
}
