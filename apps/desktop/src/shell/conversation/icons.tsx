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

export function ClockIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
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

export function RewindIcon() {
  return (
    <Icon>
      <path d="M4 3v3.5h3.5M4.3 6.2A5 5 0 1 1 3 9.5" />
    </Icon>
  );
}

export function MicIcon() {
  return (
    <Icon>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25" />
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

export function ArrowUpIcon() {
  return (
    <Icon>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function ArrowLeftIcon() {
  return (
    <Icon>
      <path d="M13 8H3M7.5 3.5 3 8l4.5 4.5" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="m4 6 4 4 4-4" />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon>
      <path d="m6 4 4 4-4 4" />
    </Icon>
  );
}

/** Fill the pane: corners pushed out to the edges. */
export function MaximizeIcon() {
  return (
    <Icon>
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
    </Icon>
  );
}

/** A column beside: a frame with its right part set apart. */
export function ColumnIcon() {
  return (
    <Icon>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M9.5 3v10" />
    </Icon>
  );
}

/** A diagram's "Show source": the code it is drawn from. */
export function CodeIcon() {
  return (
    <Icon>
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </Icon>
  );
}

/** A diagram's source's "Show diagram": boxes and the edge between them. */
export function DiagramIcon() {
  return (
    <Icon>
      <rect x="1.75" y="2.25" width="5" height="4" rx="1" />
      <rect x="9.25" y="9.75" width="5" height="4" rx="1" />
      <path d="M4.25 6.25v3.5a1.5 1.5 0 0 0 1.5 1.5h3.5" />
    </Icon>
  );
}

/** A Markdown block's source's "Show preview": a page with lines of text. */
export function DocumentIcon() {
  return (
    <Icon>
      <path d="M4 1.75h5.5L12.5 4.75v9.5H4z" />
      <path d="M6.25 7.25h4M6.25 9.5h4M6.25 11.75h2.5" />
    </Icon>
  );
}

/** A Marp deck's source's "Show slides": a slide on its stand. */
export function SlidesIcon() {
  return (
    <Icon>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1" />
      <path d="M8 11v2.5M5.5 13.75h5" />
    </Icon>
  );
}

/** The previous slide. */
export function ChevronLeftIcon() {
  return (
    <Icon>
      <path d="m10 4-4 4 4 4" />
    </Icon>
  );
}

/** Save to a file: an arrow down into a tray. */
export function DownloadIcon() {
  return (
    <Icon>
      <path d="M8 2.25v7.5M4.75 6.75 8 10l3.25-3.25M2.5 11.25v2.25h11v-2.25" />
    </Icon>
  );
}
