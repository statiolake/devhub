/**
 * The few glyphs the conversation draws, as inline SVG in `currentColor`, so
 * they take the colour and the size (`1em`) of the text around them and wear
 * the theme with it. Decorative: the control they sit in carries the name.
 */

import type { ReactNode } from "react";

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      className="conversation-icon"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function SendIcon() {
  return (
    <Icon>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </Icon>
  );
}

export function EditIcon() {
  return (
    <Icon>
      <path d="M10.5 3.5 12.5 5.5M3.5 12.5l.5-2.5 6.5-6.5 2 2L6 12z" />
    </Icon>
  );
}

export function StopIcon() {
  return (
    <Icon>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="m3 8.5 3 3 7-7" />
    </Icon>
  );
}

export function ArrowDownIcon() {
  return (
    <Icon>
      <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
    </Icon>
  );
}
