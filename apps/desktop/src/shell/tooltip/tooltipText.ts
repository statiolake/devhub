/**
 * The facts this page is drawing, as main last said them.
 *
 * A list of lines or nothing, and nothing is the whole of "no tooltip is up".
 * The page does not decide when a tooltip appears or goes — the Sidebar decides
 * that, because it is the one that knows where the pointer is, and main is what
 * joins the two. This is only the receiving end.
 */

import { useEffect, useState } from "react";
import type { TooltipBridge, TooltipLineWire } from "../../ipc/contract";

export function useTooltipLines(
  bridge: () => TooltipBridge,
): readonly TooltipLineWire[] | undefined {
  const [lines, setLines] = useState<readonly TooltipLineWire[] | undefined>(
    undefined,
  );
  useEffect(() => {
    // The subscription is made once and torn down once. `bridge` is read
    // inside the effect rather than depended on, because it is the page's own
    // accessor for `window.devhub` and never changes — depending on it would
    // be a resubscribe per render dressed up as a dependency.
    return bridge().onTooltip((next) => {
      setLines(next?.lines);
    });
  }, [bridge]);
  return lines;
}
