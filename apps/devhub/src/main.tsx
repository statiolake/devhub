import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShellApp } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("DevHub root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <ShellApp />
  </StrictMode>,
);
