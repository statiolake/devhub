/**
 * A `devhub:` link, drawn: a compact chip that names the place it leads to,
 * live, and goes there inside DevHub.
 *
 * The syntax and the resolving are `model/devhubLink.ts`'s. What the page
 * supplies is `DevhubLinks` — the places open now (from its snapshot and the
 * board) and how to go to one — through `DevhubLinksProvider`; the Agents
 * page's is `shell/agents/devhubLinks.tsx`. The chip draws the place's
 * current name: an agent's display name and status mark, a workspace's name,
 * a file's basename and `:line`, an escalation's number and title. What the
 * author wrote as the link's text is not drawn — the place's own name is the
 * one that stays true.
 *
 * It is a button, never an `<a href>`: there is nothing a browser could do
 * with it, and a click goes where `navigate` says (`select_context` with
 * `reason: "explicit"`, the open-file routing, the board), never to the
 * system. A link that does not parse, or names nothing open — or a page with
 * no provider — is the author's text, as text, with a quiet 見つかりません.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  baseName,
  parseDevhubLink,
  positionSuffix,
  resolveDevhubLink,
  type LinkPlaces,
  type ResolvedLink,
} from "../../model/devhubLink";
import type { AgentStatus } from "../../ipc/appShell";
import { StatusMark } from "../components/sidebar/StatusMark";

export interface DevhubLinks {
  readonly places: LinkPlaces;
  /** Go there, as an explicit move. Rejects with what went wrong. */
  readonly navigate: (target: ResolvedLink) => Promise<void>;
  /** The open agent running `session`, or `null` (asked of main). */
  readonly sessionAgent: (session: string) => Promise<string | null>;
  readonly reportFailure: (error: unknown) => void;
}

const DevhubLinksContext = createContext<DevhubLinks | undefined>(undefined);

export const DevhubLinksProvider = DevhubLinksContext.Provider;

export function useDevhubLinks(): DevhubLinks | undefined {
  return useContext(DevhubLinksContext);
}

const KIND_LABEL: Record<ResolvedLink["kind"], string> = {
  agent: "Agent",
  workspace: "Workspace",
  file: "File",
  escalation: "Escalation",
  orchestrator: "Orchestrator",
  session: "Session",
};

function Glyph({ kind }: { readonly kind: ResolvedLink["kind"] }) {
  const path = (() => {
    switch (kind) {
      // A head and shoulders.
      case "agent":
      case "session":
        return (
          <>
            <circle cx="8" cy="5.5" r="2.5" />
            <path d="M3.5 13.5c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4" />
          </>
        );
      // A folder.
      case "workspace":
        return <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />;
      // A page with a folded corner.
      case "file":
        return (
          <>
            <path d="M4 2.5h5l3 3v8H4z" />
            <path d="M9 2.5v3h3" />
          </>
        );
      // A flag.
      case "escalation":
        return (
          <>
            <path d="M4 13.5v-11" />
            <path d="M4 3h7.5l-1.8 2.6L11.5 8.2H4" />
          </>
        );
      // Three linked nodes.
      case "orchestrator":
        return (
          <>
            <circle cx="8" cy="4" r="1.6" />
            <circle cx="4" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <path d="M7.2 5.4 4.8 10.6M8.8 5.4l2.4 5.2" />
          </>
        );
    }
  })();
  return (
    <svg
      className="devhub-link-glyph"
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
      {path}
    </svg>
  );
}

/** The text an unusable link is left as, with the quiet mark. */
function Missing({
  children,
  href,
}: {
  readonly children?: ReactNode;
  readonly href: string;
}) {
  return (
    <span className="devhub-link is-missing" data-href={href}>
      <span className="devhub-link-text">{children ?? href}</span>
      <span className="devhub-link-missing">見つかりません</span>
    </span>
  );
}

function Chip({
  target,
  links,
}: {
  readonly target: ResolvedLink;
  readonly links: DevhubLinks;
}) {
  const label = (() => {
    switch (target.kind) {
      case "agent":
        return (
          <>
            <StatusMark
              status={target.agent.status as AgentStatus}
              unread={undefined}
            />
            <span className="devhub-link-name">{target.agent.displayName}</span>
          </>
        );
      case "workspace":
        return (
          <span className="devhub-link-name">{target.workspace.label}</span>
        );
      case "file":
        return (
          <span className="devhub-link-name">
            {baseName(target.path)}
            {positionSuffix(target.line, target.column)}
          </span>
        );
      case "escalation":
        return (
          <>
            <span className="devhub-link-sub">
              #{String(target.escalation.id)}
            </span>
            <span className="devhub-link-name">{target.escalation.title}</span>
          </>
        );
      case "orchestrator":
        return <span className="devhub-link-name">Orchestrator</span>;
      case "session":
        return (
          <span className="devhub-link-name">{target.session.slice(0, 8)}</span>
        );
    }
  })();
  return (
    <button
      type="button"
      // A link to a place in DevHub, so it has a link's hand (tokens.css).
      role="link"
      className="devhub-link"
      data-kind={target.kind}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void links.navigate(target).catch(links.reportFailure);
      }}
    >
      <Glyph kind={target.kind} />
      <span className="devhub-link-kind">{KIND_LABEL[target.kind]}</span>
      {label}
    </button>
  );
}

/** A session link: the agent that runs it, once main has said which. */
function SessionChip({
  session,
  links,
  children,
  href,
}: {
  readonly session: string;
  readonly links: DevhubLinks;
  readonly children?: ReactNode;
  readonly href: string;
}) {
  const [agentId, setAgentId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    links.sessionAgent(session).then(
      (found) => {
        if (live) setAgentId(found);
      },
      () => {
        if (live) setAgentId(null);
      },
    );
    return () => {
      live = false;
    };
  }, [links, session]);
  if (agentId === null) return <Missing href={href}>{children}</Missing>;
  if (agentId === undefined)
    return <Chip target={{ kind: "session", session }} links={links} />;
  const resolved = resolveDevhubLink(
    { kind: "agent", agent: agentId },
    links.places,
  );
  if (!resolved.found) return <Missing href={href}>{children}</Missing>;
  return <Chip target={resolved.target} links={links} />;
}

/** A `devhub:` link in Markdown: a chip, or its text marked 見つかりません. */
export function DevhubLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children?: ReactNode;
}) {
  const links = useDevhubLinks();
  const parsed = parseDevhubLink(href);
  if (links === undefined || !parsed.ok)
    return <Missing href={href}>{children}</Missing>;
  if (parsed.link.kind === "session")
    return (
      <SessionChip session={parsed.link.session} links={links} href={href}>
        {children}
      </SessionChip>
    );
  const resolved = resolveDevhubLink(parsed.link, links.places);
  if (!resolved.found) return <Missing href={href}>{children}</Missing>;
  return <Chip target={resolved.target} links={links} />;
}
