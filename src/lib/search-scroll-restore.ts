export type SearchScrollKeyOptions = {
  special?: boolean;
  privateLibraryOnly?: boolean;
};

export function getSearchScrollKey(
  query: string,
  options?: SearchScrollKeyOptions
): string {
  const suffixParts = [
    options?.special ? 'special' : '',
    options?.privateLibraryOnly ? 'private' : '',
  ].filter(Boolean);
  const suffix = suffixParts.length > 0 ? `_${suffixParts.join('_')}` : '';
  return `search_scroll_${query.trim()}${suffix}`;
}

export function saveSearchScroll(
  query: string,
  scrollTop: number,
  options?: SearchScrollKeyOptions
): void {
  if (typeof window === 'undefined') return;
  const trimmed = query.trim();
  if (!trimmed || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    sessionStorage.setItem(
      getSearchScrollKey(trimmed, options),
      String(Math.round(scrollTop))
    );
  } catch {
    // Ignore quota / private-mode failures, same as search result cache.
  }
}

export function consumeSearchScroll(
  query: string,
  options?: SearchScrollKeyOptions
): number | null {
  if (typeof window === 'undefined') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;
  const key = getSearchScrollKey(trimmed, options);
  try {
    const raw = sessionStorage.getItem(key);
    if (raw == null) return null;
    sessionStorage.removeItem(key);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  } catch {
    return null;
  }
}

export function getPageScrollTop(): number {
  if (typeof window === 'undefined') return 0;
  return Math.max(
    document.body?.scrollTop || 0,
    document.documentElement?.scrollTop || 0,
    window.scrollY || 0
  );
}

export function scrollPageTo(top: number): void {
  if (typeof window === 'undefined' || !Number.isFinite(top) || top < 0) return;
  document.body.scrollTop = top;
  document.documentElement.scrollTop = top;
  try {
    window.scrollTo(0, top);
  } catch {
    // jsdom does not implement window.scrollTo.
  }
}
