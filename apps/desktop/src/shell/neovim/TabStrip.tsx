/**
 * The tab pages (`ext_tabline`) as an editor's tab strip. Tabs keep their
 * names at their width (VS Code's `tabSizing: fit`) and the strip scrolls
 * sideways when they do not fit: the current tab is brought into view
 * whenever it changes (`gt`, `gT`, `:tabnext`: the keys reach it), the
 * wheel scrolls the strip, and an edge with more beyond it fades out.
 */

import { useEffect, useRef, useState } from "react";
import type { TabState } from "./redraw";

export function TabStrip(props: {
  readonly tabs: readonly TabState[];
  readonly current: number;
  readonly select: (tab: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 0.5;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 0.5;
    setMore((was) =>
      was.left === left && was.right === right ? was : { left, right },
    );
  };
  useEffect(() => {
    const el = ref.current;
    el?.querySelector(".nvim-tab-current")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    measure();
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Vertical wheels scroll the strip sideways, as an editor's tabs do.
    const wheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, []);
  return (
    <div className="nvim-tabline">
      <div
        ref={ref}
        className={[
          "nvim-tabline-tabs",
          more.left ? "nvim-tabline-more-left" : "",
          more.right ? "nvim-tabline-more-right" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="tablist"
        onScroll={measure}
      >
        {props.tabs.map((tab) => (
          <button
            key={tab.tab}
            type="button"
            role="tab"
            aria-selected={tab.tab === props.current}
            title={tab.name}
            className={
              tab.tab === props.current
                ? "nvim-tab nvim-tab-current"
                : "nvim-tab"
            }
            onMouseDown={(event) => {
              event.preventDefault();
              props.select(tab.tab);
            }}
          >
            {tabTitle(tab.name)}
          </button>
        ))}
      </div>
    </div>
  );
}

function tabTitle(name: string): string {
  const parts = name.split("/");
  return parts.at(-1) || name || "[No Name]";
}
