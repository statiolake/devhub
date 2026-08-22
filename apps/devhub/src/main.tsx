import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShellApp } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("DevHub root element is missing");
}

const mountNode = root;

async function mount() {
  if (import.meta.env.DEV) {
    const { parseFixtureQuery, fixtureSnapshots } = await import(
      "./visual-fixtures/route"
    );
    const fixture = parseFixtureQuery(window.location.search);
    if (fixture) {
      const { renderAppShellFixture } = await import(
        "./visual-fixtures/harness"
      );
      createRoot(mountNode).render(
        <StrictMode>
          {renderAppShellFixture(fixtureSnapshots[fixture])}
        </StrictMode>,
      );
      return;
    }
  }

  createRoot(mountNode).render(
    <StrictMode>
      <ShellApp />
    </StrictMode>,
  );
}

void mount();
