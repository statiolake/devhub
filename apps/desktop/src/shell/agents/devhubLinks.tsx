/**
 * `devhub:` links on the Agents page: what they resolve against and where a
 * click goes (`shell/conversation/DevhubLink.tsx` draws them).
 *
 * Resolved against the page's own snapshot and board, so a chip names the
 * place as it is now. Where a click goes is `model/devhubLinkNavigation.ts`'s,
 * the same function a link from outside DevHub is followed by.
 */

import { useMemo, type ReactNode } from "react";
import {
  linkPlaces,
  navigateLink,
  type LinkNavigationPorts,
} from "../../model/devhubLinkNavigation";
import {
  DevhubLinksProvider,
  type DevhubLinks,
} from "../conversation/DevhubLink";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

export { linkPlaces, navigateLink, type LinkNavigationPorts };

/** `devhub:` links for everything under it, bound to this page. */
export function AgentsDevhubLinks({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { state, board, dispatch, reportFailure } = useAgents();
  const snapshot = state.status === "ready" ? state.snapshot : undefined;
  const value = useMemo<DevhubLinks>(() => {
    const ports: LinkNavigationPorts = {
      dispatch,
      openLinkedFile: (workspaceId, path, range) =>
        devhub().openLinkedFile(workspaceId, path, range),
      sessionAgent: (session) => devhub().devhubSessionAgent(session),
    };
    return {
      places: linkPlaces(snapshot, board),
      navigate: (target) => navigateLink(target, ports),
      sessionAgent: ports.sessionAgent,
      reportFailure,
      copyLink: (link, markdown) => devhub().copyDevhubLink(link, markdown),
      showContextMenu: (request) => devhub().showContextMenu(request),
    };
  }, [snapshot, board, dispatch, reportFailure]);
  return <DevhubLinksProvider value={value}>{children}</DevhubLinksProvider>;
}
