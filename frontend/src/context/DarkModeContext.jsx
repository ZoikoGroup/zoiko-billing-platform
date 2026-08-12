import { createContext, useContext, useState, useEffect } from "react";

const DarkModeContext = createContext({ isDark: false, toggle: () => {} });

export function DarkModeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    try {
      const stored = localStorage.getItem("zoiko-billing-dark-mode");
      if (stored !== null) return stored === "true";
    } catch {}
    return false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try { localStorage.setItem("zoiko-billing-dark-mode", String(isDark)); } catch {}
  }, [isDark]);

  const toggle = () => setIsDark((prev) => !prev);

  return (
    <DarkModeContext.Provider value={{ isDark, toggle }}>
      {children}
    </DarkModeContext.Provider>
  );
}

export function useDarkMode() {
  return useContext(DarkModeContext);
}
