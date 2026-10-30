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

/**
 * True for iPhone/iPod/iPad (incl. iPadOS desktop UA with touch).
 * Dual body+html+window scroll writes desync visual vs layout viewport there.
 */
export function isIOSLikeScrollEnvironment(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  // iPadOS 13+ may report as Macintosh with touch.
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function scrollNear(a: number, b: number): boolean {
  return Math.abs(a - b) <= 2;
}

/**
 * Move the real page scroll root. Prefer a single writer (scrollingElement /
 * window) so iOS fixed hit-targets stay in sync; only dual-write body+html
 * when verification shows the page did not move (body-as-root cases).
 */
export function scrollPageTo(top: number): void {
  if (typeof window === 'undefined' || !Number.isFinite(top) || top < 0) return;

  const root =
    typeof document !== 'undefined' ? document.scrollingElement : null;

  if (isIOSLikeScrollEnvironment()) {
    // Prefer the browser's scrolling element (often body on this app).
    if (root) {
      (root as HTMLElement).scrollTop = top;
    }
    try {
      window.scrollTo(0, top);
    } catch {
      // jsdom does not implement window.scrollTo.
    }
    if (scrollNear(getPageScrollTop(), top)) return;

    // window/scrollingElement alone missed the live root — write the other.
    if (root === document.body) {
      document.documentElement.scrollTop = top;
    } else if (root === document.documentElement) {
      document.body.scrollTop = top;
    } else {
      document.body.scrollTop = top;
      document.documentElement.scrollTop = top;
    }
    return;
  }

  document.body.scrollTop = top;
  document.documentElement.scrollTop = top;
  try {
    window.scrollTo(0, top);
  } catch {
    // jsdom does not implement window.scrollTo.
  }
}
