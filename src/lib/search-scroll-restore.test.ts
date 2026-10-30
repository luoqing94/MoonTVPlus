import {
  consumeSearchScroll,
  getPageScrollTop,
  getSearchScrollKey,
  isIOSLikeScrollEnvironment,
  saveSearchScroll,
  scrollPageTo,
} from './search-scroll-restore';

describe('search page scroll restore', () => {
  const originalUserAgent = navigator.userAgent;
  const originalMaxTouchPoints = navigator.maxTouchPoints;

  beforeEach(() => {
    sessionStorage.clear();
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    window.scrollTo = jest.fn();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => originalUserAgent,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      get: () => originalMaxTouchPoints,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => originalUserAgent,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      get: () => originalMaxTouchPoints,
    });
  });

  it('keys scroll independently from the result cache, including query suffixes', () => {
    expect(getSearchScrollKey('  进击的巨人  ')).toBe(
      'search_scroll_进击的巨人'
    );
    expect(getSearchScrollKey('进击的巨人', { special: true })).toBe(
      'search_scroll_进击的巨人_special'
    );
    expect(
      getSearchScrollKey('进击的巨人', {
        special: true,
        privateLibraryOnly: true,
      })
    ).toBe('search_scroll_进击的巨人_special_private');
    expect(getSearchScrollKey('进击的巨人')).not.toContain('search_cache_');
  });

  it('saves scroll for the query and restores it once after results would paint', () => {
    const existingCache = JSON.stringify({
      status: 'complete',
      results: [{ id: '1' }],
      query: '进击的巨人',
      updatedAt: 1,
    });
    sessionStorage.setItem('search_cache_进击的巨人', existingCache);

    saveSearchScroll('进击的巨人', 1280);

    expect(sessionStorage.getItem('search_cache_进击的巨人')).toBe(
      existingCache
    );
    expect(sessionStorage.getItem('search_scroll_进击的巨人')).toBe('1280');

    expect(consumeSearchScroll('进击的巨人')).toBe(1280);
    expect(consumeSearchScroll('进击的巨人')).toBeNull();
    expect(sessionStorage.getItem('search_scroll_进击的巨人')).toBeNull();
  });

  it('does not restore a different query or empty query, and ignores invalid values', () => {
    saveSearchScroll('进击的巨人', 900);
    saveSearchScroll('   ', 400);
    saveSearchScroll('进击的巨人', Number.NaN);

    expect(consumeSearchScroll('别的关键词')).toBeNull();
    expect(sessionStorage.getItem('search_scroll_进击的巨人')).toBe('900');
    expect(consumeSearchScroll('')).toBeNull();

    sessionStorage.setItem('search_scroll_进击的巨人', 'not-a-number');
    expect(consumeSearchScroll('进击的巨人')).toBeNull();
  });

  it('reads and writes the page scroll container used by search (body first)', () => {
    document.body.scrollTop = 640;
    document.documentElement.scrollTop = 12;
    expect(getPageScrollTop()).toBe(640);

    scrollPageTo(1280);
    expect(document.body.scrollTop).toBe(1280);
    expect(document.documentElement.scrollTop).toBe(1280);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 1280);
  });

  it('on iOS uses a single window.scrollTo writer and does not dual-write body/html', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () =>
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    expect(isIOSLikeScrollEnvironment()).toBe(true);

    document.body.scrollTop = 10;
    document.documentElement.scrollTop = 20;
    scrollPageTo(1280);

    expect(window.scrollTo).toHaveBeenCalledWith(0, 1280);
    // Must not also assign body/html — that desyncs iOS fixed hit targets.
    expect(document.body.scrollTop).toBe(10);
    expect(document.documentElement.scrollTop).toBe(20);
  });
});
