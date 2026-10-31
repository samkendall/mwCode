import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidebarSortBy } from "@t3tools/contracts/settings";
import { ArrowUpDownIcon, CheckIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  animateSidebarLayoutChanges,
  resolveProjectEffectiveSort,
  SIDEBAR_SORT_BY_LABELS,
  SIDEBAR_SORT_BY_OPTIONS,
  type SidebarActiveGroup,
} from "../Sidebar.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type SidebarSortableBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

/**
 * Right-aligned per-project thread-sort button. Reuses the labels and order of
 * the Settings default-sort select; "Default" clears the override back to global.
 */
function ProjectGroupSortButton(props: {
  projectKey: string;
  effectiveSort: SidebarSortBy;
  hasOverride: boolean;
  onSelect: (projectKey: string, mode: SidebarSortBy) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Sort threads in this project (currently ${SIDEBAR_SORT_BY_LABELS[props.effectiveSort]})`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className={cn(
                    "inline-flex h-5 min-w-5 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    props.hasOverride ? "text-foreground/80" : "text-muted-foreground/50",
                  )}
                />
              }
            />
          }
        >
          <ArrowUpDownIcon aria-hidden className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Sort threads</TooltipPopup>
      </Tooltip>
      {open ? (
        <PopoverPopup side="bottom" align="end" className="w-52" padding="none">
          <div className="p-1">
            <div className="px-2 pb-1 pt-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
              Sort threads
            </div>
            {SIDEBAR_SORT_BY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  props.onSelect(props.projectKey, option);
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
              >
                <span className="flex-1 truncate">{SIDEBAR_SORT_BY_LABELS[option]}</span>
                {option === props.effectiveSort ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </button>
            ))}
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

type SidebarThreadGroup = SidebarActiveGroup<SidebarProjectSnapshot, unknown>;

function SidebarThreadGroupHeaderContent(props: {
  group: SidebarThreadGroup;
  bag: SidebarSortableBag | null;
  globalSortBy: SidebarSortBy;
  projectSortOverrides: Readonly<Record<string, SidebarSortBy>>;
  onSelectProjectSort: (projectKey: string, mode: SidebarSortBy) => void;
}) {
  const { group, bag } = props;
  const header = group.header;
  return (
    <li
      ref={bag?.setNodeRef}
      style={
        bag
          ? { transform: CSS.Translate.toString(bag.transform), transition: bag.transition }
          : undefined
      }
      data-thread-selection-safe
      className={cn("list-none", bag?.isDragging && "relative z-20 opacity-80")}
    >
      <div className="mb-1 mt-3 flex w-full items-center gap-2 px-2.5" {...(bag?.listeners ?? {})}>
        {header.kind === "project" ? (
          header.project ? (
            <ProjectFavicon project={header.project} className="size-4 shrink-0" />
          ) : (
            <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />
          )
        ) : (
          // Taxonomy color as a dot; unknown and unclassified groups get a neutral swatch.
          <span
            aria-hidden
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              header.color === null && "bg-muted-foreground/40",
            )}
            style={header.color ? { backgroundColor: header.color } : undefined}
          />
        )}
        <span
          className={cn(
            "min-w-0 truncate text-xs font-medium",
            header.kind === "taxonomy" && !header.known
              ? "text-muted-foreground/70"
              : "text-secondary-label",
          )}
        >
          {header.kind === "project" ? (header.project?.displayName ?? "Other") : header.label}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground/50 tabular-nums">
          {group.threads.length}
        </span>
        <span className="h-px flex-1 bg-sidebar-border/60" />
        {header.kind === "project" && header.project ? (
          <ProjectGroupSortButton
            projectKey={group.key}
            effectiveSort={resolveProjectEffectiveSort(
              group.key,
              props.projectSortOverrides,
              props.globalSortBy,
            )}
            hasOverride={props.projectSortOverrides[group.key] !== undefined}
            onSelect={props.onSelectProjectSort}
          />
        ) : null}
      </div>
    </li>
  );
}

// The whole header is the drag surface; the pointer sensor's distance constraint
// keeps plain clicks working.
function SortableProjectGroupHeader(
  props: Omit<Parameters<typeof SidebarThreadGroupHeaderContent>[0], "bag">,
) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.group.key,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <SidebarThreadGroupHeaderContent
      {...props}
      bag={{ listeners, setNodeRef, transform, transition, isDragging }}
    />
  );
}

/** A group's heading: a project (draggable with a sort button) or a taxonomy label. */
export function SidebarThreadGroupHeader(
  props: Omit<Parameters<typeof SidebarThreadGroupHeaderContent>[0], "bag">,
) {
  return props.group.header.kind === "project" && props.group.header.project ? (
    <SortableProjectGroupHeader {...props} />
  ) : (
    <SidebarThreadGroupHeaderContent {...props} bag={null} />
  );
}
