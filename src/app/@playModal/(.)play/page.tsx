'use client';

import dynamic from 'next/dynamic';
import { Suspense, useEffect } from 'react';

/**
 * Soft-intercepted /play: render the same player as a top-layer dialog so the
 * underlying route (search/home/…) stays mounted and keeps its scroll.
 * Hard refresh of /play still hits `app/play/page.tsx` with this slot null.
 */
const PlayPageClient = dynamic(
  () =>
    import('../../play/PlayPageClient').then((m) => ({
      default: m.PlayPageClient,
    })),
  {
    ssr: false,
    loading: () => (
      <div className='flex h-full min-h-screen w-full items-center justify-center bg-black text-sm text-gray-300'>
        Loading...
      </div>
    ),
  }
);

function useInertAppShell() {
  useEffect(() => {
    const shell = document.getElementById('app-route-shell');
    if (!shell) return;
    shell.setAttribute('inert', '');
    shell.setAttribute('aria-hidden', 'true');
    return () => {
      shell.removeAttribute('inert');
      shell.removeAttribute('aria-hidden');
    };
  }, []);
}

export default function PlayModalPage() {
  useInertAppShell();

  return (
    <div
      className='fixed inset-0 z-[10000] overflow-y-auto overscroll-contain bg-white dark:bg-black'
      role='dialog'
      aria-modal='true'
      aria-label='播放'
    >
      <Suspense
        fallback={
          <div className='flex h-full min-h-screen w-full items-center justify-center bg-black text-sm text-gray-300'>
            Loading...
          </div>
        }
      >
        <PlayPageClient />
      </Suspense>
    </div>
  );
}
