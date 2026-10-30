import {
  __resetBodyScrollLockForTests,
  acquireBodyScrollLock,
  getBodyScrollLockCount,
} from './body-scroll-lock';

describe('body scroll lock ref-count', () => {
  beforeEach(() => {
    __resetBodyScrollLockForTests();
    document.body.style.cssText = '';
    window.scrollTo = jest.fn();
  });

  it('locks once and restores only after the last nested release', () => {
    const releaseA = acquireBodyScrollLock();
    expect(getBodyScrollLockCount()).toBe(1);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.overflow).toBe('hidden');

    const releaseB = acquireBodyScrollLock();
    expect(getBodyScrollLockCount()).toBe(2);
    expect(document.body.style.position).toBe('fixed');

    releaseA();
    expect(getBodyScrollLockCount()).toBe(1);
    expect(document.body.style.position).toBe('fixed');

    releaseB();
    expect(getBodyScrollLockCount()).toBe(0);
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
  });

  it('ignores double-release of the same handle', () => {
    const release = acquireBodyScrollLock();
    release();
    release();
    expect(getBodyScrollLockCount()).toBe(0);
    expect(document.body.style.position).toBe('');
  });
});
