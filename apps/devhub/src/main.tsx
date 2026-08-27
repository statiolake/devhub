import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShellApp } from "./App";
import { installSelectionGuard } from "./app/selection";
import { SettingsApp } from "./settings/SettingsApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("DevHub root element is missing");
}

const mountNode = root;

// Installed outside React so no remount can drop it, and so both the shell
// and the Settings window get it from the one entry point they share.
installSelectionGuard(document);

async function mount() {
  if (import.meta.env.DEV) {
    const { parseSettingsFixtureQuery } = await import(
      "./visual-fixtures/settings-route"
    );
    const settingsFixture = parseSettingsFixtureQuery(window.location.search);
    if (settingsFixture) {
      const { renderSettingsFixture } = await import(
        "./visual-fixtures/settings-harness"
      );
      createRoot(mountNode).render(
        <StrictMode>{renderSettingsFixture(settingsFixture)}</StrictMode>,
      );
      return;
    }
  }

  if (
    new URLSearchParams(window.location.search).get("window") === "settings"
  ) {
    createRoot(mountNode).render(
      <StrictMode>
        <SettingsApp />
      </StrictMode>,
    );
    return;
  }

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
