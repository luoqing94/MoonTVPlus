/**
 * Ref-counted document body scroll lock for nested overlays (action sheets, etc.).
 * Prevents one overlay's cleanup from restoring scroll while another is still open,
 * and avoids leaving body position:fixed stuck after rapid open/close.
 */

type LockSnapshot = {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  paddingRight: string;
  overflow: string;
  scrollX: number;
  scrollY: number;
};

let lockCount = 0;
let snapshot: LockSnapshot | null = null;

export function getBodyScrollLockCount(): number {
  return lockCount;
}

/** Test helper — resets module state between Jest cases. */
export function __resetBodyScrollLockForTests(): void {
  lockCount = 0;
  snapshot = null;
}

export function acquireBodyScrollLock(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }

  const body = document.body;
  const html = document.documentElement;

  if (lockCount === 0) {
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollBarWidth = Math.max(0, window.innerWidth - html.clientWidth);

    snapshot = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      paddingRight: body.style.paddingRight,
      overflow: body.style.overflow,
      scrollX,
      scrollY,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = `-${scrollX}px`;
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.paddingRight = `${scrollBarWidth}px`;
  }

  lockCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (lockCount <= 0) return;
    lockCount -= 1;
    if (lockCount > 0 || !snapshot) return;

    const saved = snapshot;
    snapshot = null;

    body.style.position = saved.position;
    body.style.top = saved.top;
    body.style.left = saved.left;
    body.style.right = saved.right;
    body.style.width = saved.width;
    body.style.paddingRight = saved.paddingRight;
    body.style.overflow = saved.overflow;

    requestAnimationFrame(() => {
      try {
        window.scrollTo(saved.scrollX, saved.scrollY);
      } catch {
        // jsdom
      }
    });
  };
}
