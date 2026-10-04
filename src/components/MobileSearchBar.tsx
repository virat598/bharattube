"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Search, X, History as HistoryIcon, Loader2 } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { apiUrl } from "@/lib/api-config";
import { useSearchSuggest } from "@/lib/use-search-suggest";

/**
 * Search input used at the top of /search.
 *
 * - Recent searches are shown immediately, before the user types anything.
 * - Typing shows live suggestions from real BharatTube data (debounced).
 * - Back / clear controls and a familiar search submit button.
 */
export function MobileSearchBar({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const { user } = useApp();

  const [value, setValue] = useState(initialQuery);
  const [focused, setFocused] = useState(false);

  const {
    history,
    suggestions,
    loading: loadingSuggest,
    refreshHistory,
    removeHistoryItem,
    clearAllHistory,
  } = useSearchSuggest({ query: value, userId: user?.id ?? null });

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  // Autofocus only when arriving with no query (i.e. tapped the search icon),
  // so the keyboard opens naturally and recent searches are visible at once.
  useEffect(() => {
    if (!initialQuery) {
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [initialQuery]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const submit = useCallback(
    (raw?: string) => {
      const q = (raw ?? value).trim();
      if (!q) return;
      setFocused(false);
      inputRef.current?.blur();

      fetch(apiUrl("/activity"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "record_search", query: q }),
      })
        .catch(() => {})
        .finally(() => {
          void refreshHistory();
        });

      setValue(q);
      router.push(`/search?q=${encodeURIComponent(q)}`);
    },
    [value, router, refreshHistory]
  );

  const showPanel = focused;
  const typing = value.trim().length > 0;
  const hasList = typing
    ? history.length > 0 || suggestions.length > 0 || loadingSuggest
    : true;

  return (
    <div ref={wrapRef} className="relative">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-1.5"
      >
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Go back"
          className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 min-w-0 flex items-center h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-transparent focus-within:border-zinc-400 dark:focus-within:border-zinc-500 focus-within:bg-white dark:focus-within:bg-zinc-900 overflow-hidden transition-colors">
          <input
            ref={inputRef}
            type="search"
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => {
              setFocused(true);
              void refreshHistory();
            }}
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            aria-label="Search BharatTube"
            placeholder="Search BharatTube"
            className="w-full min-w-0 h-full px-4 bg-transparent text-base text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {value && (
            <button
              type="button"
              onClick={() => {
                setValue("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <button
          type="submit"
          aria-label="Search"
          disabled={!value.trim()}
          className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-700 dark:text-zinc-200 disabled:opacity-40 cursor-pointer"
        >
          <Search className="w-5 h-5" />
        </button>
      </form>

      {showPanel && hasList && (
        <div className="absolute left-0 right-0 top-full mt-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg py-2 z-40 max-h-[65vh] overflow-y-auto overscroll-contain">
          {!typing ? (
            <>
              <div className="flex items-center justify-between px-4 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Recent searches
                </span>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAllHistory}
                    className="text-xs font-medium text-red-600 hover:underline cursor-pointer"
                  >
                    Clear history
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-zinc-500 leading-relaxed">
                  {user
                    ? "Searches you make will be listed here."
                    : "Sign in to see your recent searches."}
                </div>
              ) : (
                history.map((item) => (
                  <div key={`h-${item}`} className="flex items-center pr-2">
                    <button
                      type="button"
                      onClick={() => {
                        setValue(item);
                        submit(item);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-3 pl-4 pr-2 py-2.5 text-left text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                    >
                      <HistoryIcon className="w-4 h-4 text-zinc-400 shrink-0" />
                      <span className="truncate">{item}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeHistoryItem(item)}
                      aria-label={`Remove ${item} from search history`}
                      className="tap-target shrink-0 inline-flex items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-white cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </>
          ) : (
            <>
              {history.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    From your searches
                  </div>
                  {history.map((item) => (
                    <button
                      key={`hm-${item}`}
                      type="button"
                      onClick={() => {
                        setValue(item);
                        submit(item);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                    >
                      <HistoryIcon className="w-4 h-4 text-zinc-400 shrink-0" />
                      <span className="truncate">{item}</span>
                    </button>
                  ))}
                </>
              )}

              {loadingSuggest && suggestions.length === 0 && (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-zinc-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Searching…
                </div>
              )}

              {suggestions.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    {history.length > 0 ? "Videos & channels" : "Suggestions"}
                  </div>
                  {suggestions.map((sug) => (
                    <button
                      key={`s-${sug}`}
                      type="button"
                      onClick={() => {
                        setValue(sug);
                        submit(sug);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                    >
                      <Search className="w-4 h-4 text-zinc-400 shrink-0" />
                      <span className="truncate">{sug}</span>
                    </button>
                  ))}
                </>
              )}

              {!loadingSuggest &&
                suggestions.length === 0 &&
                history.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-zinc-500">
                    Tap search to look for “{value.trim()}”
                  </div>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
