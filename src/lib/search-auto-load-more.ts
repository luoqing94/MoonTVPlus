/**
 * Auto「加载更多」: when remaining already-loaded visible cards ≤ N,
 * trigger the same load-more path. Toggle defaults ON; N defaults to 50.
 */

export const SEARCH_AUTO_LOAD_MORE_KEY = 'searchAutoLoadMore';
export const SEARCH_AUTO_LOAD_MORE_THRESHOLD_KEY = 'searchAutoLoadMoreThreshold';
export const AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT = 50;
export const AUTO_LOAD_MORE_THRESHOLD_MIN = 1;
export const AUTO_LOAD_MORE_THRESHOLD_MAX = 50;
export const SEARCH_AUTO_LOAD_MORE_EVENT = 'searchAutoLoadMoreChanged';

/** Default ON when unset / unreadable. */
export function isSearchAutoLoadMoreEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const saved = localStorage.getItem(SEARCH_AUTO_LOAD_MORE_KEY);
    if (saved === null) return true;
    if (saved === 'true') return true;
    if (saved === 'false') return false;
    return JSON.parse(saved) !== false;
  } catch {
    return true;
  }
}

export function setSearchAutoLoadMoreEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SEARCH_AUTO_LOAD_MORE_KEY, JSON.stringify(enabled));
    window.dispatchEvent(
      new CustomEvent(SEARCH_AUTO_LOAD_MORE_EVENT, { detail: { enabled } })
    );
  } catch {
    // ignore quota / private mode
  }
}

export function clampAutoLoadMoreThreshold(n: number): number {
  if (!Number.isFinite(n)) return AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT;
  return Math.min(
    AUTO_LOAD_MORE_THRESHOLD_MAX,
    Math.max(AUTO_LOAD_MORE_THRESHOLD_MIN, Math.round(n))
  );
}

/** Default N=50 when unset / unreadable. */
export function getSearchAutoLoadMoreThreshold(): number {
  if (typeof window === 'undefined') {
    return AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT;
  }
  try {
    const saved = localStorage.getItem(SEARCH_AUTO_LOAD_MORE_THRESHOLD_KEY);
    if (saved === null || saved === '') {
      return AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT;
    }
    const parsed = Number(JSON.parse(saved));
    return clampAutoLoadMoreThreshold(parsed);
  } catch {
    const raw = localStorage.getItem(SEARCH_AUTO_LOAD_MORE_THRESHOLD_KEY);
    const n = Number(raw);
    return clampAutoLoadMoreThreshold(n);
  }
}

export function setSearchAutoLoadMoreThreshold(n: number): void {
  if (typeof window === 'undefined') return;
  const next = clampAutoLoadMoreThreshold(n);
  try {
    localStorage.setItem(
      SEARCH_AUTO_LOAD_MORE_THRESHOLD_KEY,
      JSON.stringify(next)
    );
    window.dispatchEvent(
      new CustomEvent(SEARCH_AUTO_LOAD_MORE_EVENT, {
        detail: { threshold: next },
      })
    );
  } catch {
    // ignore
  }
}

/** @deprecated use AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT */
export const AUTO_LOAD_MORE_REMAINING_THRESHOLD =
  AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT;

/**
 * Estimate how many already-loaded visible list items are still below the
 * viewport fold, based on the results container geometry and total card count
 * (agg / title-fold / all — whatever the user is scrolling).
 */
export function estimateRemainingLoadedItems(
  visibleCount: number,
  resultsEl: Element | null,
  viewportBottom?: number
): number {
  if (visibleCount <= 0) return 0;
  if (!resultsEl || typeof window === 'undefined') return visibleCount;

  const rect = resultsEl.getBoundingClientRect();
  const bottom =
    viewportBottom ??
    (window.visualViewport
      ? window.visualViewport.offsetTop + window.visualViewport.height
      : window.innerHeight);

  if (!(rect.height > 0)) return visibleCount;
  // Entire list above the fold → nothing left below
  if (rect.bottom <= bottom + 1) return 0;
  // List has not reached the fold yet → all remaining
  if (rect.top >= bottom) return visibleCount;

  const scrolledThrough = Math.max(0, bottom - rect.top);
  const progress = Math.min(1, scrolledThrough / rect.height);
  return Math.max(0, Math.ceil(visibleCount * (1 - progress)));
}
