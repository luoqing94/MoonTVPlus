/**
 * @jest-environment jsdom
 */
import {
  AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT,
  clampAutoLoadMoreThreshold,
  estimateRemainingLoadedItems,
  getSearchAutoLoadMoreThreshold,
  isSearchAutoLoadMoreEnabled,
} from './search-auto-load-more';

describe('search-auto-load-more', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults toggle ON and threshold 10', () => {
    expect(isSearchAutoLoadMoreEnabled()).toBe(true);
    expect(getSearchAutoLoadMoreThreshold()).toBe(
      AUTO_LOAD_MORE_REMAINING_THRESHOLD_DEFAULT
    );
  });

  it('clamps threshold to 1..50', () => {
    expect(clampAutoLoadMoreThreshold(0)).toBe(1);
    expect(clampAutoLoadMoreThreshold(10.4)).toBe(10);
    expect(clampAutoLoadMoreThreshold(99)).toBe(50);
    expect(clampAutoLoadMoreThreshold(NaN)).toBe(10);
  });

  it('estimates remaining from geometry', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 1000,
        height: 1000,
        left: 0,
        right: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    // viewport bottom at 900 → 10% left → ceil(100*0.1)=10
    expect(estimateRemainingLoadedItems(100, el, 900)).toBe(10);
    expect(estimateRemainingLoadedItems(100, el, 1000)).toBe(0);
    expect(estimateRemainingLoadedItems(100, el, -10)).toBe(100);
  });
});
