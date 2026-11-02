'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  clearBangumiImageFallbackCacheIfFailed,
  ensureBangumiImagePrimaryProbed,
  processImageUrl,
  scheduleNearViewportCoverRetry,
  shouldRetryDirectCover,
  tryApplyBangumiImageFallback,
  tryApplyDoubanImageFallback,
} from '@/lib/utils';

interface ProxyImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  originalSrc: string;
  displaySrc?: string;
  retryDelay?: number;
  retryOnError?: boolean;
}

const ProxyImage: React.FC<ProxyImageProps> = ({
  originalSrc,
  displaySrc,
  retryDelay: _retryDelay = 2000,
  retryOnError = true,
  loading = 'lazy',
  decoding = 'async',
  onError,
  src: _src,
  ...props
}) => {
  const initialSrc = useMemo(
    () => displaySrc || processImageUrl(originalSrc),
    [displaySrc, originalSrc]
  );
  const [currentSrc, setCurrentSrc] = useState(initialSrc);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setCurrentSrc(initialSrc);
  }, [initialSrc]);

  // 主源图片域主页探测：失败则 sticky 走备源（替代原 5s complete 误判）
  useEffect(() => {
    if (displaySrc) return;

    let cancelled = false;
    void (async () => {
      const reachable = await ensureBangumiImagePrimaryProbed();
      if (cancelled || reachable) return;
      setCurrentSrc(processImageUrl(originalSrc));
    })();

    return () => {
      cancelled = true;
    };
  }, [displaySrc, originalSrc]);

  const handleError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    const img = e.currentTarget;

    if (
      tryApplyDoubanImageFallback(img, originalSrc) ||
      tryApplyBangumiImageFallback(img, originalSrc)
    ) {
      setCurrentSrc(img.src);
      return;
    }

    if (clearBangumiImageFallbackCacheIfFailed(img, originalSrc)) {
      setCurrentSrc(processImageUrl(originalSrc));
      return;
    }

    // CMS / direct covers only: same-URL retries near viewport (1s→2s→4s).
    // Douban/Bangumi keep their own fallbacks above — do not stack generic retries.
    if (retryOnError && shouldRetryDirectCover(originalSrc)) {
      scheduleNearViewportCoverRetry(
        img,
        () => {
          // Bounce src so React/img reloads the same URL after an error state
          setCurrentSrc('');
          window.requestAnimationFrame(() => {
            setCurrentSrc(initialSrc);
          });
        },
        { retryKey: initialSrc, rootMargin: '100% 0px' }
      );
    }

    onError?.(e);
  };

  return (
    <img
      {...props}
      ref={imgRef}
      src={currentSrc}
      loading={loading}
      decoding={decoding}
      onError={handleError}
    />
  );
};

export default ProxyImage;
