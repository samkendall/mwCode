import { memo, useState } from "react";
import { CheckIcon, LockIcon, RotateCcwIcon, XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import type { HarnessTaxonomy, HarnessTaxonomyEntry } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { resolveClassificationBadge } from "./Sidebar.logic";
import { StageProgress } from "./StageProgress";

export type ClassificationDimension = "workType" | "stage";

const CHIP_CLASS =
  "inline-flex max-w-[8rem] shrink-0 cursor-pointer items-center gap-1 rounded-sm text-xs leading-tight text-secondary-label transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

/**
 * One classification control (work type or stage). Renders nothing when the
 * thread has no value for the dimension — the sidebar never shows empty
 * controls. The work-type dimension reads as a color dot + word; the stage
 * dimension reads as a progress pipeline (one dot per stage) + word. Clicking
 * opens a popover of the taxonomy options plus Clear; selecting dispatches
 * through `onSelect` (null clears). Row click/selection is guarded by stopping
 * propagation on the trigger and every option.
 */
const ClassificationChip = memo(function ClassificationChip(props: {
  entries: readonly HarnessTaxonomyEntry[];
  value: string | null | undefined;
  dimension: ClassificationDimension;
  dimensionLabel: string;
  // Stage renders the progress pipeline; work type renders a single dot.
  variant: "dot" | "pipeline";
  // Stage only: true when the user pinned the stage by hand, so the server's
  // per-turn re-assessment leaves it alone. Drives the lock glyph and the
  // "Resume auto" menu item. workType never locks.
  locked?: boolean;
  onResumeAuto?: () => void;
  onSelect: (dimension: ClassificationDimension, id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const badge = resolveClassificationBadge(props.entries, props.value);
  if (badge === null) return null;
  const dotStyle: CSSProperties | undefined = badge.color
    ? { backgroundColor: badge.color }
    : undefined;
  const locked = props.locked === true;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${props.dimensionLabel}: ${badge.label}${locked ? " (locked)" : ""}. Change ${props.dimensionLabel.toLowerCase()}`}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className={CHIP_CLASS}
          />
        }
      >
        {props.variant === "pipeline" ? (
          <StageProgress stage={props.value} stages={props.entries} />
        ) : (
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              badge.color === null && "bg-muted-foreground/50",
            )}
            style={dotStyle}
          />
        )}
        <span className="truncate">{badge.label}</span>
        {locked ? (
          <LockIcon aria-hidden className="size-2.5 shrink-0 text-muted-foreground/70" />
        ) : null}
      </PopoverTrigger>
      {open ? (
        <PopoverPopup side="bottom" align="start" className="w-52" viewportClassName="p-1">
          <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {props.dimensionLabel}
          </div>
          {props.entries.map((entry) => {
            const selected = entry.id === badge.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  if (!selected) props.onSelect(props.dimension, entry.id);
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    entry.color == null && "bg-muted-foreground/40",
                  )}
                  style={entry.color ? { backgroundColor: entry.color } : undefined}
                />
                <span className="flex-1 truncate">{entry.label}</span>
                {selected ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
              </button>
            );
          })}
          <div aria-hidden className="mx-1 my-1 h-px bg-border/60" />
          {locked && props.onResumeAuto ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                props.onResumeAuto?.();
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RotateCcwIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="flex-1">Resume auto</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              props.onSelect(props.dimension, null);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="flex-1">Clear</span>
          </button>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
});

/**
 * Work-type dot and stage pipeline for a sidebar thread row. Comfortable and
 * cozy rows show both dimensions; compact one-line rows show the work-type dot
 * only (the stage pipeline is dropped for horizontal room — the fuller rows are
 * where the lifecycle lives). Renders nothing when the thread carries neither
 * field.
 */
export const SidebarThreadClassificationBadges = memo(
  function SidebarThreadClassificationBadges(props: {
    workType: string | null | undefined;
    stage: string | null | undefined;
    // True when the user pinned the stage by hand; shows a lock glyph and a
    // "Resume auto" option on the stage chip.
    stageManual?: boolean | null | undefined;
    taxonomy: HarnessTaxonomy;
    compact?: boolean;
    onSelect: (dimension: ClassificationDimension, id: string | null) => void;
    onResumeStageAuto: () => void;
  }) {
    return (
      <>
        <ClassificationChip
          entries={props.taxonomy.workTypes}
          value={props.workType}
          dimension="workType"
          dimensionLabel="Work type"
          variant="dot"
          onSelect={props.onSelect}
        />
        {props.compact ? null : (
          <ClassificationChip
            entries={props.taxonomy.stages}
            value={props.stage}
            dimension="stage"
            dimensionLabel="Stage"
            variant="pipeline"
            locked={props.stageManual === true}
            onResumeAuto={props.onResumeStageAuto}
            onSelect={props.onSelect}
          />
        )}
      </>
    );
  },
);
