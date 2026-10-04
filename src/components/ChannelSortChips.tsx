"use client";

import {
  CHANNEL_SORT_OPTIONS,
  type ChannelSortMode,
  type ChannelSectionKind,
} from "@/lib/channel-videos";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Channel sort control — Latest | Popular | Oldest.
 * ─────────────────────────────────────────────────────────────────────────
 * Compact YouTube-style chips rendered directly above a channel's Videos or
 * Shorts grid. Styling intentionally mirrors the existing BharatTube category
 * filter bar (same height, padding, radius, selected treatment) so the control
 * looks native to the app instead of introducing a new visual language.
 *
 * Purely presentational: the parent owns the selected value and persistence,
 * so this component is reused unchanged by both channel sections.
 */

interface ChannelSortChipsProps {
  value: ChannelSortMode;
  onChange: (next: ChannelSortMode) => void;
  /** Which section this control belongs to — used for the accessible label. */
  section: ChannelSectionKind;
  /** Disables the chips while a page is being fetched. */
  disabled?: boolean;
  className?: string;
}

export function ChannelSortChips({
  value,
  onChange,
  section,
  disabled = false,
  className = "",
}: ChannelSortChipsProps) {
  const label = section === "shorts" ? "Sort Shorts" : "Sort videos";

  return (
    <div
      role="group"
      aria-label={label}
      className={`flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 ${className}`}
    >
      {CHANNEL_SORT_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            disabled={disabled}
            aria-pressed={active}
            title={`${option.label} first`}
            className={`shrink-0 h-9 px-3.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default ${
              active
                ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950"
                : "bg-zinc-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
