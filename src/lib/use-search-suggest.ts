"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared data layer for the BharatTube search experience (header search and
 * the /search page input).
 *
 * - Recent searches are loaded immediately (no typing required) and are scoped
 *   to the signed-in account by the API.
 * - Live suggestions come from the same real backend and are requested with a
 *   short debounce + in-memory cache so typing stays fast without spamming the
 *   backend on every keystroke.
 */
export function useSearchSuggest({
  query,
  userId,
}: {
  query: string;
  userId?: string | number | null;
}) {
  const [history, setHistory] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const historyLoadedRef = useRef(false);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, { history: string[]; suggestions: string[] }>>(
    new Map()
  );

  /** Pulls this user's recent searches (newest first). */
  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/activity?type=search", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setHistory(Array.isArray(data?.searchHistory) ? data.searchHistory : []);
    } catch {
      /* offline — keep whatever we already have */
    }
  }, []);

  // Stable key so switching accounts never leaks the previous account's searches.
  const userKey = userId == null ? "anon" : String(userId);

  useEffect(() => {
    historyLoadedRef.current = false;
    setHistory([]);
    setSuggestions([]);
    setLoading(false);
    cacheRef.current.clear();
    abortRef.current?.abort();
  }, [userKey]);

  // Load history as soon as the search experience is available, without any
  // interaction from the user.
  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    void refreshHistory();
  }, [refreshHistory, userKey]);

  // Debounced live suggestions while typing.
  useEffect(() => {
    const q = query.trim();

    if (!q) {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      setLoading(false);
      setSuggestions([]);
      return;
    }

    const cacheKey = q.toLowerCase();
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setHistory(cached.history);
      setSuggestions(cached.suggestions);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(
          `/api/activity?type=search&q=${encodeURIComponent(q)}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok || requestId !== requestIdRef.current) return;
        const data = await res.json();
        const nextHistory = Array.isArray(data?.searchHistory)
          ? data.searchHistory
          : [];
        const nextSuggestions = Array.isArray(data?.suggestions)
          ? data.suggestions
          : [];

        if (requestId !== requestIdRef.current) return;
        setHistory(nextHistory);
        setSuggestions(nextSuggestions);
        cacheRef.current.set(cacheKey, {
          history: nextHistory,
          suggestions: nextSuggestions,
        });
        if (cacheRef.current.size > 25) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest) cacheRef.current.delete(oldest);
        }
      } catch {
        /* aborted or offline — keep the previous list */
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, 220);

    return () => clearTimeout(timer);
  }, [query]);

  /** Removes one entry from this user's history. */
  const removeHistoryItem = useCallback(async (item: string) => {
    setHistory((prev) =>
      prev.filter((h) => h.toLowerCase() !== item.toLowerCase())
    );
    try {
      await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_search_history", query: item }),
      });
    } catch {
      /* ignore */
    }
  }, []);

  /** Clears this user's whole history. */
  const clearAllHistory = useCallback(async () => {
    setHistory([]);
    cacheRef.current.clear();
    try {
      await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_search_history" }),
      });
    } catch {
      /* ignore */
    }
  }, []);

  return {
    history,
    suggestions,
    loading,
    refreshHistory,
    removeHistoryItem,
    clearAllHistory,
  };
}
