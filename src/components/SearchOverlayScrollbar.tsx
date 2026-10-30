'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { getPageScrollTop, scrollPageTo } from '@/lib/search-scroll-restore';

type SearchOverlayScrollbarProps = {
  /** Element that reveals the scrollbar on hover (search results area). */
  hoverTargetRef: React.RefObject<HTMLElement | null>;
  /** When false, the scrollbar is inactive. */
  enabled?: boolean;
};

const HIDE_DELAY_MS = 1200;
const MIN_THUMB_PX = 36;
const TRACK_TOP = 72;
const TRACK_BOTTOM = 96;
/** If a drag never receives pointerup (common on flaky iOS), force-end it. */
const DRAG_FAILSAFE_MS = 2500;

type ViewportMetrics = {
  /** Layout/visual client height used for scroll range. */
  clientHeight: number;
  /** Offset of the visual viewport within the layout viewport (iOS). */
  offsetTop: number;
  /** Height of the visual viewport (fallback: innerHeight). */
  viewportHeight: number;
};

function readViewportMetrics(): ViewportMetrics {
  if (typeof window === 'undefined') {
    return { clientHeight: 0, offsetTop: 0, viewportHeight: 0 };
  }
  const vv = window.visualViewport;
  const viewportHeight = Math.round(vv?.height || window.innerHeight || 0);
  const offsetTop = Math.round(vv?.offsetTop || 0);
  // Prefer visualViewport height so thumb/track math matches what the user sees
  // while Safari chrome shows/hides. Fall back to innerHeight.
  const clientHeight = viewportHeight || window.innerHeight || 0;
  return { clientHeight, offsetTop, viewportHeight };
}

/**
 * Overlay scrollbar for the search page (body is the scroll root).
 * Mobile + desktop: fades in while scrolling (and on results hover on
 * desktop); thumb drag / track jump for scrubbing long lists.
 *
 * iOS Safari note: a fixed track sized with innerHeight + preventDefault +
 * setPointerCapture + dual scrollTop writes during drag desyncs the visual
 * vs layout viewport (black gap, MobileBottomNav floating mid-screen).
 * This component pins the track to visualViewport and uses a touch-safe
 * drag path (touch-action: none, no preventDefault/capture on coarse
 * pointers, rAF-throttled window.scrollTo).
 *
 * Vanish fix: never unmount the track when canScroll flickers false (CSS
 * hide instead); never let a stuck draggingRef permanently suppress reveal
 * on subsequent scrolls; keep canScroll metrics fresh even during drag.
 */
export default function SearchOverlayScrollbar({
  hoverTargetRef,
  enabled = true,
}: SearchOverlayScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragFailsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef(0);
  const keepVisibleRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const metricsRef = useRef({
    scrollTop: 0,
    maxScroll: 0,
    trackHeight: 0,
    thumbHeight: MIN_THUMB_PX,
  });
  /** Active drag pointer listeners (window) — cleaned by endDrag. */
  const dragListenersRef = useRef<{
    onMove: ((ev: PointerEvent) => void) | null;
    onUp: ((ev: PointerEvent) => void) | null;
  }>({ onMove: null, onUp: null });

  const [visible, setVisible] = useState(false);
  const [thumb, setThumb] = useState({ height: MIN_THUMB_PX, top: 0 });
  const [canScroll, setCanScroll] = useState(false);
  const [viewport, setViewport] = useState<ViewportMetrics>({
    clientHeight: 0,
    offsetTop: 0,
    viewportHeight: 0,
  });

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const clearDragFailsafe = useCallback(() => {
    if (dragFailsafeRef.current) {
      clearTimeout(dragFailsafeRef.current);
      dragFailsafeRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      if (draggingRef.current || keepVisibleRef.current) return;
      setVisible(false);
    }, HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const recompute = useCallback((opts?: { skipThumb?: boolean }) => {
    if (typeof window === 'undefined') return;
    const vp = readViewportMetrics();
    setViewport((prev) =>
      prev.offsetTop === vp.offsetTop &&
      prev.viewportHeight === vp.viewportHeight &&
      prev.clientHeight === vp.clientHeight
        ? prev
        : vp
    );

    const scrollTop = getPageScrollTop();
    const scrollHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
    // Scroll range must use the layout viewport height (what the browser
    // actually scrolls against). Track chrome uses visualViewport separately.
    const clientHeight =
      document.documentElement?.clientHeight ||
      window.innerHeight ||
      vp.clientHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const trackHeight = Math.max(0, vp.viewportHeight - TRACK_TOP - TRACK_BOTTOM);
    const ratio = scrollHeight > 0 ? clientHeight / scrollHeight : 1;
    const thumbHeight = Math.max(
      MIN_THUMB_PX,
      Math.min(trackHeight, Math.round(trackHeight * ratio))
    );

    metricsRef.current = {
      scrollTop,
      maxScroll,
      trackHeight,
      thumbHeight,
    };
    setCanScroll(maxScroll > 8);

    if (opts?.skipThumb) return;

    const travel = Math.max(0, trackHeight - thumbHeight);
    const thumbTop =
      maxScroll > 0 ? Math.round((scrollTop / maxScroll) * travel) : 0;
    setThumb({ height: thumbHeight, top: thumbTop });
  }, []);

  /** iOS-safe programmatic scroll used during thumb drag. */
  const applyScrollTop = useCallback((top: number) => {
    if (typeof window === 'undefined' || !Number.isFinite(top)) return;
    const clamped = Math.max(0, top);
    // Single writer during gesture-driven scrubbing. Dual body +
    // documentElement assignment (scrollPageTo) can desync iOS fixed layers.
    try {
      window.scrollTo(0, clamped);
    } catch {
      // jsdom
    }
    if (Math.abs(getPageScrollTop() - clamped) > 1) {
      scrollPageTo(clamped);
    }
  }, []);

  const flushPendingScroll = useCallback(() => {
    rafRef.current = null;
    const next = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (next == null) return;
    applyScrollTop(next);
    // Update metrics from live scroll; keep optimistic thumb during drag.
    recompute({ skipThumb: draggingRef.current });
  }, [applyScrollTop, recompute]);

  const scrollFromThumbTop = useCallback(
    (thumbTop: number, immediate = false) => {
      const { maxScroll, trackHeight, thumbHeight } = metricsRef.current;
      if (maxScroll <= 0) return;
      const travel = Math.max(1, trackHeight - thumbHeight);
      const clamped = Math.min(travel, Math.max(0, thumbTop));
      const nextTop = (clamped / travel) * maxScroll;

      // Optimistic thumb position so the handle tracks the finger even if
      // scroll events are coalesced on iOS.
      setThumb((prev) => ({ ...prev, top: Math.round(clamped) }));

      if (immediate) {
        pendingScrollRef.current = null;
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        applyScrollTop(nextTop);
        recompute({ skipThumb: true });
        return;
      }

      pendingScrollRef.current = nextTop;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushPendingScroll);
      }
    },
    [applyScrollTop, flushPendingScroll, recompute]
  );

  const endDrag = useCallback(
    (opts?: { scheduleHideAfter?: boolean }) => {
      if (!draggingRef.current && !dragListenersRef.current.onMove) {
        clearDragFailsafe();
        return;
      }
      draggingRef.current = false;
      clearDragFailsafe();

      const { onMove, onUp } = dragListenersRef.current;
      if (onMove) window.removeEventListener('pointermove', onMove);
      if (onUp) {
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('touchend', onUp as EventListener);
        window.removeEventListener('touchcancel', onUp as EventListener);
      }
      dragListenersRef.current = { onMove: null, onUp: null };

      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (pendingScrollRef.current != null) {
        applyScrollTop(pendingScrollRef.current);
        pendingScrollRef.current = null;
      }
      recompute();
      if (opts?.scheduleHideAfter !== false) {
        scheduleHide();
      }
    },
    [applyScrollTop, clearDragFailsafe, recompute, scheduleHide]
  );

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      setCanScroll(false);
      clearHideTimer();
      endDrag({ scheduleHideAfter: false });
      return;
    }

    recompute();

    const onScroll = () => {
      if (draggingRef.current) {
        // Keep canScroll / maxScroll fresh so a viewport glitch during drag
        // cannot leave the bar permanently unmounted/disabled. Skip thumb
        // so we don't fight the finger position.
        recompute({ skipThumb: true });
        return;
      }
      recompute();
      reveal();
    };
    const onViewportChange = () => {
      recompute({ skipThumb: draggingRef.current });
    };

    // Global safety: if a drag never got pointerup (iOS quirk), any later
    // touch/pointer end on the window must clear draggingRef so scroll
    // can reveal the bar again.
    const onGlobalPointerEnd = () => {
      if (draggingRef.current) {
        endDrag();
      }
    };

    document.body.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.documentElement.addEventListener('scroll', onScroll, {
      passive: true,
    });
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('pointerup', onGlobalPointerEnd);
    window.addEventListener('pointercancel', onGlobalPointerEnd);
    window.addEventListener('touchend', onGlobalPointerEnd, { passive: true });
    window.addEventListener('touchcancel', onGlobalPointerEnd, {
      passive: true,
    });
    window.addEventListener('blur', onGlobalPointerEnd);
    document.addEventListener('visibilitychange', onGlobalPointerEnd);

    const vv = window.visualViewport;
    vv?.addEventListener('resize', onViewportChange);
    vv?.addEventListener('scroll', onViewportChange);

    const target = hoverTargetRef.current;
    const onEnter = () => {
      keepVisibleRef.current = true;
      clearHideTimer();
      recompute();
      setVisible(true);
    };
    const onLeave = () => {
      keepVisibleRef.current = false;
      scheduleHide();
    };
    // Touch: briefly reveal when interacting with the results area.
    const onTouchStart = () => {
      // A new touch that isn't a continuing drag should clear a stuck drag.
      if (draggingRef.current) {
        endDrag({ scheduleHideAfter: false });
      }
      recompute();
      reveal();
    };
    target?.addEventListener('mouseenter', onEnter);
    target?.addEventListener('mouseleave', onLeave);
    target?.addEventListener('touchstart', onTouchStart, { passive: true });

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => recompute({ skipThumb: draggingRef.current }))
        : null;
    if (target && ro) ro.observe(target);
    if (document.body && ro) ro.observe(document.body);

    return () => {
      document.body.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      document.documentElement.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('pointerup', onGlobalPointerEnd);
      window.removeEventListener('pointercancel', onGlobalPointerEnd);
      window.removeEventListener('touchend', onGlobalPointerEnd);
      window.removeEventListener('touchcancel', onGlobalPointerEnd);
      window.removeEventListener('blur', onGlobalPointerEnd);
      document.removeEventListener('visibilitychange', onGlobalPointerEnd);
      vv?.removeEventListener('resize', onViewportChange);
      vv?.removeEventListener('scroll', onViewportChange);
      target?.removeEventListener('mouseenter', onEnter);
      target?.removeEventListener('mouseleave', onLeave);
      target?.removeEventListener('touchstart', onTouchStart);
      ro?.disconnect();
      clearHideTimer();
      clearDragFailsafe();
      endDrag({ scheduleHideAfter: false });
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [
    enabled,
    hoverTargetRef,
    recompute,
    reveal,
    scheduleHide,
    clearHideTimer,
    clearDragFailsafe,
    endDrag,
  ]);

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!canScroll) return;
    const track = trackRef.current;
    if (!track) return;

    // Coarse pointer (finger): rely on CSS touch-action:none. Calling
    // preventDefault + setPointerCapture here is what previously broke the
    // iOS Safari layout viewport during scrubbing.
    const isCoarse =
      event.pointerType === 'touch' ||
      (typeof window !== 'undefined' &&
        window.matchMedia?.('(pointer: coarse)').matches);

    if (!isCoarse) {
      event.preventDefault();
      event.stopPropagation();
    }

    const rect = track.getBoundingClientRect();
    const { thumbHeight } = metricsRef.current;
    const y = event.clientY - rect.top;
    const onThumb = y >= thumb.top && y <= thumb.top + thumb.height;

    // Clear any previous drag listeners before starting a new one.
    endDrag({ scheduleHideAfter: false });

    draggingRef.current = true;
    dragOffsetRef.current = onThumb ? y - thumb.top : thumbHeight / 2;
    if (!onThumb) {
      scrollFromThumbTop(y - thumbHeight / 2, true);
    }

    clearHideTimer();
    setVisible(true);

    if (!isCoarse) {
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures on older browsers
      }
    }

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current || !trackRef.current) return;
      if (isCoarse && ev.pointerId !== event.pointerId) return;
      const r = trackRef.current.getBoundingClientRect();
      scrollFromThumbTop(ev.clientY - r.top - dragOffsetRef.current);
    };
    const onUp = (ev: PointerEvent | TouchEvent | Event) => {
      if (
        isCoarse &&
        'pointerId' in ev &&
        (ev as PointerEvent).pointerId !== event.pointerId
      ) {
        return;
      }
      if (!isCoarse) {
        try {
          track.releasePointerCapture((ev as PointerEvent).pointerId);
        } catch {
          // ignore
        }
      }
      endDrag();
    };

    dragListenersRef.current = { onMove, onUp };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // Extra end signals for coarse pointers that sometimes skip pointerup.
    window.addEventListener('touchend', onUp, { passive: true });
    window.addEventListener('touchcancel', onUp, { passive: true });

    clearDragFailsafe();
    dragFailsafeRef.current = setTimeout(() => {
      if (draggingRef.current) {
        endDrag();
      }
    }, DRAG_FAILSAFE_MS);
  };

  if (!enabled) return null;

  // Keep the track mounted whenever enabled so canScroll flickering (iOS
  // visualViewport / address-bar) cannot permanently remove the control.
  // When there is nothing to scroll, hide it visually and disable hits.
  const showInteractive = canScroll && visible;
  const trackTop = viewport.offsetTop + TRACK_TOP;
  const trackHeight = Math.max(
    0,
    viewport.viewportHeight - TRACK_TOP - TRACK_BOTTOM
  );

  return (
    <div
      ref={trackRef}
      className={`fixed right-0 z-[400] w-24 touch-none md:right-1.5 md:w-2 ${
        showInteractive ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      style={{
        top: trackTop,
        height: trackHeight,
        // Soft-hide when content fits the viewport.
        visibility: canScroll ? 'visible' : 'hidden',
      }}
      onMouseEnter={() => {
        if (!canScroll) return;
        keepVisibleRef.current = true;
        clearHideTimer();
        setVisible(true);
      }}
      onMouseLeave={() => {
        keepVisibleRef.current = false;
        scheduleHide();
      }}
      onPointerDown={onTrackPointerDown}
      aria-hidden={!showInteractive}
    >
      {/* Visual thumb ~96px on mobile (4× prior ~24px); track w-24 fits thumb; desktop stays thin */}
      <div
        className={`absolute rounded-full bg-gray-400/60 shadow-sm transition-opacity duration-200 active:bg-green-500/80 hover:bg-green-500/75 dark:bg-gray-500/55 dark:active:bg-green-400/80 dark:hover:bg-green-400/75 left-0 right-0 md:left-0 md:right-0 ${
          showInteractive ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          height: thumb.height,
          transform: `translateY(${thumb.top}px)`,
        }}
      />
    </div>
  );
}
