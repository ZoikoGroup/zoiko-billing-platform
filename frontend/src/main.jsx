import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { DarkModeProvider } from "./context/DarkModeContext";
import { CommandCenterProvider } from "./context/CommandCenterContext";
import "./fonts.css";
import "./index.css";
import { installChunkReloadRecovery } from "./chunkReloadRecovery";

installChunkReloadRecovery();

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <AuthProvider>
      <DarkModeProvider>
        <CommandCenterProvider>
          <App />
        </CommandCenterProvider>
      </DarkModeProvider>
    </AuthProvider>
  </BrowserRouter>
);
