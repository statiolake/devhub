import { useEffect, useRef } from "react";
import type { SettingsSnapshot } from "../generated/settings";
import {
  settingsConflictSnapshot,
  type SettingsFixtureName,
} from "./settings-route";

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (button): button is HTMLButtonElement =>
      button.textContent?.trim() === text,
  );
}

/**
 * Drives only real Settings controls so the fixture shows the production
 * dirty/conflict/confirmation states without copying their state machine.
 */
export function SettingsFixtureDriver({
  name,
  emit,
}: {
  name: SettingsFixtureName;
  emit: (snapshot: SettingsSnapshot) => void;
}) {
  const phase = useRef<"idle" | "dirty" | "done">("idle");

  useEffect(() => {
    if (name === "settings-ready" || name === "settings-invalid-diagnostic") {
      return undefined;
    }
    let disposed = false;
    const drive = () => {
      if (disposed || phase.current === "done") return;
      if (name === "settings-dirty" || name === "settings-conflict") {
        if (phase.current === "dirty") return;
        const checkbox = document.querySelector(
          'input[aria-label="Import login environment"]',
        ) as HTMLInputElement | null;
        if (!checkbox) return;
        checkbox.click();
        phase.current = "dirty";
        if (name === "settings-dirty") {
          phase.current = "done";
          return;
        }
        window.setTimeout(() => {
          if (!disposed) {
            emit(settingsConflictSnapshot());
            phase.current = "done";
          }
        }, 0);
        return;
      }

      if (name === "settings-socket-confirmation") {
        const runtimes = buttonWithText("Runtimes");
        const apply = buttonWithText("Apply socket change");
        if (apply && !apply.disabled) {
          apply.click();
          phase.current = "done";
        } else if (runtimes && !runtimes.matches(".active")) {
          runtimes.click();
        }
      }
    };
    const observer = new MutationObserver(drive);
    observer.observe(document.body, { childList: true, subtree: true });
    drive();
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [emit, name]);

  return null;
}
