'use client';

import { Suspense } from 'react';

import { PlayPageClient } from './PlayPageClient';

/**
 * Hard navigation / refresh / share link to /play.
 * Soft in-app navigations are intercepted by `@playModal/(.)play` so the
 * previous page (e.g. search) stays mounted underneath.
 */
export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageClient />
    </Suspense>
  );
}
