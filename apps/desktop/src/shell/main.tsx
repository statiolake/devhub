import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell";
import { installRootFailureHandler } from "./failures";
import "./styles/tokens.css";
import "./styles/shell.css";

installRootFailureHandler();

const container = document.getElementById("root");
if (!container) {
  throw new Error("the App Shell page has no #root element");
}

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
