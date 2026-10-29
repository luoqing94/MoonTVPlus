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

/**
 * Overlay scrollbar for the search page (body is the scroll root).
 * Hidden by default; fades in on results-area hover (desktop), while
 * scrolling, or on touch; supports thumb drag and track click/tap on
 * both mobile and desktop. Thin visual thumb with a wider touch hit area
 * on small screens.
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
  const metricsRef = useRef({
    scrollTop: 0,
    maxScroll: 0,
    trackHeight: 0,
    thumbHeight: MIN_THUMB_PX,
  });

  const [visible, setVisible] = useState(false);
  const [thumb, setThumb] = useState({ height: MIN_THUMB_PX, top: 0 });
  const [canScroll, setCanScroll] = useState(false);

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
    const scrollTop = getPageScrollTop();
    const scrollHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
    const clientHeight = window.innerHeight || 0;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const trackHeight = Math.max(0, clientHeight - TRACK_TOP - TRACK_BOTTOM);
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

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      setCanScroll(false);
      clearHideTimer();
      return;
    }

    recompute();

    const onScroll = () => {
      recompute();
      reveal();
    };
    const onResize = () => recompute();

    document.body.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.documentElement.addEventListener('scroll', onScroll, {
      passive: true,
    });
    window.addEventListener('resize', onResize);

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
      window.removeEventListener('resize', onResize);
      target?.removeEventListener('mouseenter', onEnter);
      target?.removeEventListener('mouseleave', onLeave);
      target?.removeEventListener('touchstart', onTouchStart);
      ro?.disconnect();
      clearHideTimer();
    };
  }, [
    enabled,
    hoverTargetRef,
    recompute,
    reveal,
    scheduleHide,
    clearHideTimer,
  ]);

  const scrollFromThumbTop = useCallback(
    (thumbTop: number) => {
      const { maxScroll, trackHeight, thumbHeight } = metricsRef.current;
      if (maxScroll <= 0) return;
      const travel = Math.max(1, trackHeight - thumbHeight);
      const clamped = Math.min(travel, Math.max(0, thumbTop));
      scrollPageTo((clamped / travel) * maxScroll);
      recompute();
    },
    [recompute]
  );

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = track.getBoundingClientRect();
    const { thumbHeight } = metricsRef.current;
    const y = event.clientY - rect.top;
    const onThumb = y >= thumb.top && y <= thumb.top + thumb.height;

    draggingRef.current = true;
    dragOffsetRef.current = onThumb ? y - thumb.top : thumbHeight / 2;
    if (!onThumb) {
      scrollFromThumbTop(y - thumbHeight / 2);
    }

    clearHideTimer();
    setVisible(true);

    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // ignore capture failures on older browsers
    }

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current || !trackRef.current) return;
      const r = trackRef.current.getBoundingClientRect();
      scrollFromThumbTop(ev.clientY - r.top - dragOffsetRef.current);
    };
    const onUp = (ev: PointerEvent) => {
      draggingRef.current = false;
      try {
        track.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      scheduleHide();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  if (!enabled || !canScroll) return null;

  return (
    <div
      ref={trackRef}
      className={`fixed right-0 z-[400] w-5 touch-none md:right-1.5 md:w-2 ${
        visible ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      style={{ top: TRACK_TOP, bottom: TRACK_BOTTOM }}
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
