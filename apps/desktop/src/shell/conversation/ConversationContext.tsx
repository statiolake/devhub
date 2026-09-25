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
import type {
  EntryId,
  PendingId,
  RequestAnswer,
  RequestId,
  RewindOutcome,
  UserEntry,
} from "../../model/conversation";

/** The three settings a session offers choices for, as `SessionFacts` names them. */
export type SettingName = "model" | "effort" | "mode";

export interface ConversationActions {
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  /**
   * Say something to the Agent as the person: written at once when it is
   * idle, else held as a pending message (`Transcript.pending`).
   */
  readonly send: (text: string) => Promise<void>;
  /**
   * The person opened a held message to change it: main holds it, unwritten,
   * until `editPending` saves the change or `stopEditingPending` gives it up.
   */
  readonly startEditingPending: (pending: PendingId) => Promise<void>;
  readonly editPending: (pending: PendingId, text: string) => Promise<void>;
  readonly stopEditingPending: (pending: PendingId) => Promise<void>;
  readonly removePending: (pending: PendingId) => Promise<void>;
  /** Write a held message now: a running turn takes it in as it goes. */
  readonly sendPendingNow: (pending: PendingId) => Promise<void>;
  /** Say something to a subagent whose `spawns.takesMessages` is true, named by its call. */
  readonly instruct: (subagent: EntryId, text: string) => Promise<void>;
  /**
   * Take the conversation back to before `message`. `refused` when the CLI
   * would not: the conversation says why, and nothing was dropped.
   */
  readonly rewind: (message: EntryId) => Promise<RewindOutcome>;
  /** Stop the turn that is running. */
  readonly interrupt: () => Promise<void>;
  readonly answer: (request: RequestId, answer: RequestAnswer) => Promise<void>;
  /** Pick one of `SessionFacts[setting].choices` by its id. */
  readonly setSetting: (setting: SettingName, id: string) => Promise<void>;
  /** Open the picker of earlier sessions this Agent can go on with (`/resume`). */
  readonly openResume: () => void;
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

/**
 * Rewinding to before one of the person's messages: which messages can be
 * rewound to now (`rewindTargets`), and how to do it. A rewind that is done
 * puts the message's words back in the composer.
 */
export interface RewindMessage {
  readonly targets: ReadonlySet<EntryId>;
  readonly rewind: (entry: UserEntry) => Promise<void>;
}

const RewindMessageContext = createContext<RewindMessage | undefined>(
  undefined,
);

export const RewindMessageProvider = RewindMessageContext.Provider;

export function useRewindMessage(): RewindMessage {
  const rewind = useContext(RewindMessageContext);
  if (!rewind) {
    throw new Error("a user message was drawn outside a ConversationSurface");
  }
  return rewind;
}
