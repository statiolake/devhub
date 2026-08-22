import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createTauriShellClient, type ShellClient } from "./client";
import { ShellContext } from "./ShellContext";
import type { ShellLoadState, ShellSnapshot } from "./model";
const defaultClient = createTauriShellClient();

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "The native app shell could not be reached.";
};

export interface ShellProviderProps {
  readonly client?: ShellClient;
  readonly children: ReactNode;
}

/**
 * Owns only the transport lifecycle. The provider never creates or edits
 * domain state; it publishes the latest immutable snapshot from Rust.
 */
export function ShellProvider({
  client = defaultClient,
  children,
}: ShellProviderProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ShellLoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    const applySnapshot = (snapshot: ShellSnapshot) => {
      if (active) {
        setState(
          snapshot.readiness === "ready"
            ? { status: "ready", snapshot }
            : { status: "loading" },
        );
      }
    };

    const initialize = async () => {
      try {
        // Subscribe before querying so a readiness event cannot be missed.
        const unsubscribe = await client.subscribe(applySnapshot);
        if (!active) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
        const initial = await client.getSnapshot();
        if (!active) {
          return;
        }
        applySnapshot(initial);
        // Readiness is an explicit lifecycle intent owned by Rust. The UI
        // never changes `readiness` itself.
        const ready = await client.markReady();
        if (!active) {
          return;
        }
        applySnapshot(ready);
      } catch (error) {
        if (active) {
          setState({ status: "error", message: errorMessage(error) });
        }
      }
    };

    void initialize();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [attempt, client]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  const value = useMemo(() => ({ state, retry }), [retry, state]);

  return (
    <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
  );
}
