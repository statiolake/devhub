/**
 * What a drawn conversation can ask of the page it is on.
 *
 * The surface draws a Transcript and nothing else, so everything it does
 * besides drawing — put text on the clipboard, open a link, answer a request —
 * is a call it makes through here. The Agents page supplies the bridge-backed
 * calls; a test supplies its own and watches them.
 *
 * `reportFailure` is the page's root. A call that fails is handed there and
 * nowhere else: the surface has no failure display of its own, so a copy that
 * did not happen is reported the way every other failure on the page is.
 */

import { createContext, useContext } from "react";
import type { RequestAnswer, RequestId } from "../../model/conversation";

export interface ConversationActions {
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly answer: (request: RequestId, answer: RequestAnswer) => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

const ConversationContext = createContext<ConversationActions | undefined>(
  undefined,
);

export const ConversationActionsProvider = ConversationContext.Provider;

export function useConversationActions(): ConversationActions {
  const actions = useContext(ConversationContext);
  if (!actions) {
    throw new Error(
      "a conversation entry was drawn outside a ConversationSurface",
    );
  }
  return actions;
}
