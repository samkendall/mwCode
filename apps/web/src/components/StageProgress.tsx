import { memo } from "react";
import type { CSSProperties } from "react";
import type { HarnessTaxonomyEntry } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { resolveStageFillIndex } from "./Sidebar.logic";

// Above this many stages a per-dot pipeline stops reading as a scannable
// column and starts to crowd the row, so we collapse to a compact "n/m"
// counter (still tinted by the current stage) instead of shrinking dots into
// an unreadable smear. The user's real taxonomy has 7 stages, comfortably
// under the cap; the dot path is the common one.
const STAGE_PIPELINE_DOT_CAP = 8;

/**
 * A stage's progress through the lifecycle as a row of dots — one per stage in
 * the taxonomy's order — filled up to and including the current stage. The
 * current dot is the brightest, earlier dots share its color dimmed, and later
 * dots are hollow outlines. A thread with no (or an orphaned) stage renders an
 * all-hollow pipeline, so the column still lines up down the list. Purely
 * presentational and aria-hidden: the enclosing trigger names the stage.
 */
export const StageProgress = memo(function StageProgress(props: {
  stage: string | null | undefined;
  stages: readonly HarnessTaxonomyEntry[];
}) {
  const count = props.stages.length;
  if (count === 0) return null;
  const fillIndex = resolveStageFillIndex(props.stages, props.stage);
  const currentColor = fillIndex >= 0 ? (props.stages[fillIndex]?.color ?? null) : null;

  // Large taxonomies collapse to a counter so the row never overflows.
  if (count > STAGE_PIPELINE_DOT_CAP) {
    return (
      <span
        aria-hidden
        className="shrink-0 tabular-nums text-[10px] font-medium leading-none text-muted-foreground/70"
        style={currentColor ? { color: currentColor } : undefined}
      >
        {fillIndex >= 0 ? `${fillIndex + 1}/${count}` : `–/${count}`}
      </span>
    );
  }

  return (
    <span aria-hidden className="inline-flex shrink-0 items-center gap-[3px]">
      {props.stages.map((entry, index) => {
        const isCurrent = index === fillIndex;
        const isFilled = fillIndex >= 0 && index <= fillIndex;
        let style: CSSProperties | undefined;
        if (currentColor) {
          style = isCurrent
            ? { backgroundColor: currentColor }
            : isFilled
              ? { backgroundColor: `color-mix(in srgb, ${currentColor} 45%, transparent)` }
              : { borderColor: `color-mix(in srgb, ${currentColor} 35%, transparent)` };
        }
        return (
          <span
            key={entry.id}
            className={cn(
              "size-1.5 rounded-full",
              isFilled
                ? currentColor
                  ? undefined
                  : "bg-muted-foreground/60"
                : cn("border bg-transparent", !currentColor && "border-muted-foreground/30"),
            )}
            style={style}
          />
        );
      })}
    </span>
  );
});
