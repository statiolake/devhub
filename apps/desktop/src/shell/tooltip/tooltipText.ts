/**
 * The sentence this page is drawing, as main last said it.
 *
 * One string or nothing, and nothing is the whole of "no tooltip is up". The
 * page does not decide when a tooltip appears or goes — the Sidebar decides
 * that, because it is the one that knows where the pointer is, and main is
 * what joins the two. This is only the receiving end.
 */

import { useEffect, useState } from "react";
import type { TooltipBridge } from "../../ipc/contract";

export function useTooltipText(
  bridge: () => TooltipBridge,
): string | undefined {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    // The subscription is made once and torn down once. `bridge` is read
    // inside the effect rather than depended on, because it is the page's own
    // accessor for `window.devhub` and never changes — depending on it would
    // be a resubscribe per render dressed up as a dependency.
    return bridge().onTooltip((next) => {
      setText(next?.text);
    });
  }, [bridge]);
  return text;
}
