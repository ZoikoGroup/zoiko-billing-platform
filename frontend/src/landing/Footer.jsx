import { Link } from "react-router-dom";

const styles = {
  root: {
    backgroundColor: "#0B1220",
    color: "#ffffff",
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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
  logoBadge: {
    background: "#ffffff",
    borderRadius: "8px",
    padding: "6px 10px",
    display: "inline-flex",
    alignItems: "center",
  },
  brandDesc: {
    fontSize: "12.5px",
    color: "rgba(255,255,255,0.55)",
    lineHeight: "1.5",
    marginBottom: "18px",
  },
  colTitle: {
    fontSize: "11.5px",
    fontWeight: "700",
    color: "#2563EB",
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
            <div style={styles.logoBadge}>
              <img src="/zoiko-billing-logo.png" alt="Zoiko Billing" style={{ height: "28px", width: "auto", display: "block" }} />
            </div>
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
