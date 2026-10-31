import { memo } from "react";
import type { CSSProperties } from "react";
import type { HarnessTaxonomyEntry } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { resolveStageFillIndex } from "./Sidebar.logic";

// Above this many stages a per-dot pipeline crowds the row, so it collapses to a
// compact "n/m" counter tinted by the current stage.
const STAGE_PIPELINE_DOT_CAP = 8;

/**
 * A stage's progress as one dot per taxonomy stage, filled through the current one.
 * A thread with no (or an orphaned) stage is all hollow, so the column still lines
 * up. Purely presentational: the enclosing trigger names the stage.
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
        className="shrink-0 tabular-nums text-3xs font-medium leading-none text-muted-foreground/70"
        style={currentColor ? { color: currentColor } : undefined}
      >
        {fillIndex >= 0 ? `${fillIndex + 1}/${count}` : `–/${count}`}
      </span>
    );
  }

  return (
    <span aria-hidden className="inline-flex shrink-0 items-center gap-0.75">
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
