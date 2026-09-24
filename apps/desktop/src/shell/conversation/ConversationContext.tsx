/**
 * What a drawn conversation can ask of the page it is on.
 *
 * The surface draws a Transcript and nothing else, so everything it does
 * besides drawing — put text on the clipboard, open a link, say something to
 * the Agent, answer it, stop it, change its settings — is a call it makes
 * through here, already bound to its one Agent. The Agents page supplies the
 * bridge-backed calls; a test supplies its own and watches them.
 *
 * Every call resolves when it has been done and rejects when it has not.
 * Nothing here returns what the Agent does about it: that arrives, like
 * everything else the Agent says, as the Transcript.
 *
 * `reportFailure` is the page's root. A call that fails is handed there and
 * nowhere else: the surface has no failure display of its own, so a copy that
 * did not happen is reported the way every other failure on the page is.
 */

import { createContext, useContext } from "react";
import type { RequestAnswer, RequestId } from "../../model/conversation";

/** The three settings a session offers choices for, as `SessionFacts` names them. */
export type SettingName = "model" | "effort" | "mode";

export interface ConversationActions {
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  /** Say something to the Agent as the person, mid-turn or not. */
  readonly send: (text: string) => Promise<void>;
  /** Stop the turn that is running. */
  readonly interrupt: () => Promise<void>;
  readonly answer: (request: RequestId, answer: RequestAnswer) => Promise<void>;
  /** Pick one of `SessionFacts[setting].choices` by its id. */
  readonly setSetting: (setting: SettingName, id: string) => Promise<void>;
  /** Carry this conversation on in a terminal Agent. */
  readonly continueInTerminal: () => Promise<void>;
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

/**
 * Put the keyboard in this surface's composer: where Esc from a request card
 * goes, and where the surface puts it when it is shown.
 */
const FocusComposerContext = createContext<(() => void) | undefined>(undefined);

export const FocusComposerProvider = FocusComposerContext.Provider;

export function useFocusComposer(): () => void {
  const focus = useContext(FocusComposerContext);
  if (!focus) {
    throw new Error("a request card was drawn outside a ConversationSurface");
  }
  return focus;
}
