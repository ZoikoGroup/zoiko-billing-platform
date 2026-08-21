import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { CommandCenterProvider } from "./context/CommandCenterContext";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <AuthProvider>
      <CommandCenterProvider>
        <App />
      </CommandCenterProvider>
    </AuthProvider>
  </BrowserRouter>
);
