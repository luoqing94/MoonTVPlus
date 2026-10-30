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
 */
export default function SearchOverlayScrollbar({
  hoverTargetRef,
  enabled = true,
}: SearchOverlayScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const recompute = useCallback(() => {
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
    const travel = Math.max(0, trackHeight - thumbHeight);
    const thumbTop =
      maxScroll > 0 ? Math.round((scrollTop / maxScroll) * travel) : 0;

    setCanScroll(maxScroll > 8);
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
    // Update thumb from live scroll position after the write.
    recompute();
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
        recompute();
        return;
      }

      pendingScrollRef.current = nextTop;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushPendingScroll);
      }
    },
    [applyScrollTop, flushPendingScroll, recompute]
  );

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      setCanScroll(false);
      clearHideTimer();
      return;
    }

    recompute();

    const onScroll = () => {
      if (draggingRef.current) return; // thumb owns position while dragging
      recompute();
      reveal();
    };
    const onViewportChange = () => recompute();

    document.body.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.documentElement.addEventListener('scroll', onScroll, {
      passive: true,
    });
    window.addEventListener('resize', onViewportChange);

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
      recompute();
      reveal();
    };
    target?.addEventListener('mouseenter', onEnter);
    target?.addEventListener('mouseleave', onLeave);
    target?.addEventListener('touchstart', onTouchStart, { passive: true });

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => recompute())
        : null;
    if (target && ro) ro.observe(target);
    if (document.body && ro) ro.observe(document.body);

    return () => {
      document.body.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      document.documentElement.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onViewportChange);
      vv?.removeEventListener('resize', onViewportChange);
      vv?.removeEventListener('scroll', onViewportChange);
      target?.removeEventListener('mouseenter', onEnter);
      target?.removeEventListener('mouseleave', onLeave);
      target?.removeEventListener('touchstart', onTouchStart);
      ro?.disconnect();
      clearHideTimer();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [
    enabled,
    hoverTargetRef,
    recompute,
    reveal,
    scheduleHide,
    clearHideTimer,
  ]);

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
    const onUp = (ev: PointerEvent) => {
      if (isCoarse && ev.pointerId !== event.pointerId) return;
      draggingRef.current = false;
      if (!isCoarse) {
        try {
          track.releasePointerCapture(ev.pointerId);
        } catch {
          // ignore
        }
      }
      // Flush any pending rAF scroll so we land on the final thumb position.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (pendingScrollRef.current != null) {
        applyScrollTop(pendingScrollRef.current);
        pendingScrollRef.current = null;
      }
      recompute();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      scheduleHide();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  if (!enabled || !canScroll) return null;

  const trackTop = viewport.offsetTop + TRACK_TOP;
  const trackHeight = Math.max(
    0,
    viewport.viewportHeight - TRACK_TOP - TRACK_BOTTOM
  );

  return (
    <div
      ref={trackRef}
      className={`fixed right-0 z-[400] w-5 touch-none md:right-1.5 md:w-2 ${
        visible ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      style={{ top: trackTop, height: trackHeight }}
      onMouseEnter={() => {
        keepVisibleRef.current = true;
        clearHideTimer();
        setVisible(true);
      }}
      onMouseLeave={() => {
        keepVisibleRef.current = false;
        scheduleHide();
      }}
      onPointerDown={onTrackPointerDown}
      aria-hidden={!visible}
    >
      {/* Visual thumb: inset on mobile so the hit area (w-5) is wider than the bar */}
      <div
        className={`absolute rounded-full bg-gray-400/60 shadow-sm transition-opacity duration-200 active:bg-green-500/80 hover:bg-green-500/75 dark:bg-gray-500/55 dark:active:bg-green-400/80 dark:hover:bg-green-400/75 left-1.5 right-1.5 md:left-0 md:right-0 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          height: thumb.height,
          transform: `translateY(${thumb.top}px)`,
        }}
      />
    </div>
  );
}
