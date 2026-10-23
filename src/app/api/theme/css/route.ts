/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getThemeCSS } from '@/styles/themes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_CACHE_TTL_MS = 60 * 1000;

interface CachedThemeResponse {
  css: string;
  etag: string;
  expiresAt: number;
}

function getRouteCache(): Map<string, CachedThemeResponse> {
  const g = globalThis as any;
  if (!(g.__moontvPublicRouteCache instanceof Map)) {
    g.__moontvPublicRouteCache = new Map();
  }
  return g.__moontvPublicRouteCache;
}

function getRouteInflight(): Map<string, Promise<CachedThemeResponse>> {
  const g = globalThis as any;
  if (!(g.__moontvPublicRouteInflight instanceof Map)) {
    g.__moontvPublicRouteInflight = new Map();
  }
  return g.__moontvPublicRouteInflight;
}

async function computeThemeResponse(): Promise<CachedThemeResponse> {
  const adminConfig = await getConfig();
  const themeConfig = adminConfig?.ThemeConfig;

  if (!themeConfig) {
    return {
      css: '',
      etag: '"0"',
      expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
    };
  }

  const css = themeConfig.enableBuiltInTheme
    ? getThemeCSS(themeConfig.builtInTheme as any)
    : themeConfig.customCSS || '';
  const etag = `"${themeConfig.cacheVersion ?? 0}"`;

  return {
    css,
    etag,
    expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
  };
}

export async function GET(request: NextRequest) {
  try {
    const cacheKey = '/api/theme/css';
    const cache = getRouteCache();
    const inflight = getRouteInflight();
    const now = Date.now();

    let entry = cache.get(cacheKey);
    let cacheStatus: 'HIT' | 'MISS' = 'HIT';

    if (!entry || entry.expiresAt <= now) {
      cacheStatus = 'MISS';
      let pending = inflight.get(cacheKey);
      let coalesced = false;
      if (pending) {
        coalesced = true;
      } else {
        pending = computeThemeResponse().then((res) => {
          cache.set(cacheKey, res);
          return res;
        });
        inflight.set(cacheKey, pending);
      }
      try {
        entry = await pending;
        if (coalesced) {
          cacheStatus = 'HIT';
        }
      } finally {
        if (!coalesced) {
          inflight.delete(cacheKey);
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': PUBLIC_CACHE_CONTROL,
      'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
      ETag: entry.etag,
      'x-moontv-ssr-cache': cacheStatus,
      'x-eo-ssr-cache': cacheStatus === 'HIT' ? 'HIT-SSR' : 'MISS-SSR',
    };

    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === entry.etag) {
      return new NextResponse(null, {
        status: 304,
        headers,
      });
    }

    return new NextResponse(entry.css, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('获取主题CSS失败:', error);
    return new NextResponse('', {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': PUBLIC_CACHE_CONTROL,
        'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
        'x-moontv-ssr-cache': 'MISS',
        'x-eo-ssr-cache': 'MISS-SSR',
      },
    });
  }
}
