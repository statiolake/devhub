import { createContext } from "react";
import type { ShellLoadState } from "./model";

export interface ShellContextValue {
  readonly state: ShellLoadState;
  readonly retry: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);
