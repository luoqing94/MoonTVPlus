/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

import { getThemeCSS } from '@/styles/themes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSR_CACHE_KEY = '/api/theme/css';
const SSR_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_EO_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300, durable';

function getSsrCacheStore(): Map<string, { css: string; etag: string; expiresAt: number }> {
  const g = globalThis as any;
  if (!(g.__moontvSsrPublicCache instanceof Map)) {
    g.__moontvSsrPublicCache = new Map();
  }
  return g.__moontvSsrPublicCache;
}

function getSsrInflightStore(): Map<string, Promise<{ css: string; etag: string }>> {
  const g = globalThis as any;
  if (!(g.__moontvSsrPublicInflight instanceof Map)) {
    g.__moontvSsrPublicInflight = new Map();
  }
  return g.__moontvSsrPublicInflight;
}

export async function GET(request: NextRequest) {
  try {
    const now = Date.now();
    const cacheStore = getSsrCacheStore();
    const cached = cacheStore.get(SSR_CACHE_KEY);

    if (cached && cached.expiresAt > now) {
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch && cached.etag && ifNoneMatch === cached.etag) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            'Cache-Control': PUBLIC_CACHE_CONTROL,
            'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
            'EO-CDN-Cache-Control': PUBLIC_EO_CDN_CACHE_CONTROL,
            ETag: cached.etag,
            'x-moontv-ssr-cache': 'HIT',
            'x-eo-ssr-cache': 'HIT-SSR',
          },
        });
      }
      return new NextResponse(cached.css, {
        headers: {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': PUBLIC_CACHE_CONTROL,
          'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
          'EO-CDN-Cache-Control': PUBLIC_EO_CDN_CACHE_CONTROL,
          ETag: cached.etag,
          'x-moontv-ssr-cache': 'HIT',
          'x-eo-ssr-cache': 'HIT-SSR',
        },
      });
    }

    const inflightStore = getSsrInflightStore();
    let pending = inflightStore.get(SSR_CACHE_KEY);
    const wasCoalesced = Boolean(pending);
    if (!pending) {
      pending = (async () => {
        const adminConfig = await getConfig();
        const themeConfig = adminConfig.ThemeConfig;
        if (!themeConfig) {
          return { css: '', etag: '"0"' };
        }
        const css = themeConfig.enableBuiltInTheme
          ? getThemeCSS(themeConfig.builtInTheme as any)
          : themeConfig.customCSS || '';
        const etag = `"${themeConfig.cacheVersion || 0}"`;
        cacheStore.set(SSR_CACHE_KEY, {
          css,
          etag,
          expiresAt: Date.now() + SSR_CACHE_TTL_MS,
        });
        return { css, etag };
      })();
      inflightStore.set(SSR_CACHE_KEY, pending);
    }

    let resolved: { css: string; etag: string };
    try {
      resolved = await pending;
    } finally {
      if (!wasCoalesced) {
        inflightStore.delete(SSR_CACHE_KEY);
      }
    }

    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && resolved.etag && ifNoneMatch === resolved.etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          'Cache-Control': PUBLIC_CACHE_CONTROL,
          'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
          'EO-CDN-Cache-Control': PUBLIC_EO_CDN_CACHE_CONTROL,
          ETag: resolved.etag,
          'x-moontv-ssr-cache': wasCoalesced ? 'HIT' : 'MISS',
          'x-eo-ssr-cache': wasCoalesced ? 'HIT-SSR' : 'MISS-SSR',
        },
      });
    }

    return new NextResponse(resolved.css, {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': PUBLIC_CACHE_CONTROL,
        'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
        'EO-CDN-Cache-Control': PUBLIC_EO_CDN_CACHE_CONTROL,
        ETag: resolved.etag,
        'x-moontv-ssr-cache': wasCoalesced ? 'HIT' : 'MISS',
        'x-eo-ssr-cache': wasCoalesced ? 'HIT-SSR' : 'MISS-SSR',
      },
    });
  } catch (error) {
    console.error('获取主题CSS失败:', error);
    return new NextResponse('', {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}
