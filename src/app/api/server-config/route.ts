/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { CURRENT_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_CACHE_TTL_MS = 60 * 1000;

interface CachedServerConfigResponse {
  body: string;
  etag: string;
  expiresAt: number;
}

function getRouteCache(): Map<string, CachedServerConfigResponse> {
  const g = globalThis as any;
  if (!(g.__moontvPublicRouteCache instanceof Map)) {
    g.__moontvPublicRouteCache = new Map();
  }
  return g.__moontvPublicRouteCache;
}

function getRouteInflight(): Map<string, Promise<CachedServerConfigResponse>> {
  const g = globalThis as any;
  if (!(g.__moontvPublicRouteInflight instanceof Map)) {
    g.__moontvPublicRouteInflight = new Map();
  }
  return g.__moontvPublicRouteInflight;
}

function simpleHash(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function computeServerConfigPayload(): Promise<CachedServerConfigResponse> {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const isLiteMode = process.env.MOONTV_LITE === 'true';

  const watchRoomConfig = isLiteMode
    ? {
        enabled: false,
        serverType: 'external' as const,
        externalServerUrl: undefined,
      }
    : {
        enabled: process.env.WATCH_ROOM_ENABLED === 'true',
        serverType:
          (process.env.WATCH_ROOM_SERVER_TYPE as 'internal' | 'external') || 'internal',
        externalServerUrl: process.env.WATCH_ROOM_EXTERNAL_SERVER_URL,
      };

  let payload: Record<string, unknown>;
  if (storageType === 'localstorage') {
    payload = {
      SiteName: process.env.NEXT_PUBLIC_SITE_NAME || 'MoonTVPlus',
      StorageType: 'localstorage',
      Version: CURRENT_VERSION,
      TVModeEnabled: process.env.ENABLE_TV_MODE !== 'false',
      WatchRoom: watchRoomConfig,
      EnableOfflineDownload: process.env.NEXT_PUBLIC_ENABLE_OFFLINE_DOWNLOAD === 'true',
      DanmakuAutoLoadDefault: true,
      EnableTelegramLogin: Boolean(
        process.env.TELEGRAM_BOT_TOKEN &&
          process.env.TELEGRAM_BOT_USERNAME &&
          process.env.TELEGRAM_LOGIN_ENABLED !== 'false'
      ),
      TelegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
    };
  } else {
    const config = await getConfig();
    payload = {
      SiteName: config.SiteConfig.SiteName,
      StorageType: storageType,
      Version: CURRENT_VERSION,
      TVModeEnabled: process.env.ENABLE_TV_MODE !== 'false',
      WatchRoom: watchRoomConfig,
      EnableOfflineDownload: process.env.NEXT_PUBLIC_ENABLE_OFFLINE_DOWNLOAD === 'true',
      EnableRegistration: config.SiteConfig.EnableRegistration || false,
      RequireRegistrationInviteCode: config.SiteConfig.RequireRegistrationInviteCode || false,
      RegistrationRequireTurnstile: config.SiteConfig.RegistrationRequireTurnstile || false,
      LoginRequireTurnstile: config.SiteConfig.LoginRequireTurnstile || false,
      TurnstileSiteKey: config.SiteConfig.TurnstileSiteKey || '',
      EnableOIDCLogin: config.SiteConfig.EnableOIDCLogin || false,
      EnableOIDCRegistration: config.SiteConfig.EnableOIDCRegistration || false,
      OIDCButtonText: config.SiteConfig.OIDCButtonText || '',
      EnableTelegramLogin: Boolean(
        config.TelegramConfig?.enabled &&
          config.TelegramConfig?.loginEnabled &&
          (config.TelegramConfig?.botToken || process.env.TELEGRAM_BOT_TOKEN) &&
          (config.TelegramConfig?.botUsername || process.env.TELEGRAM_BOT_USERNAME)
      ),
      TelegramBotUsername:
        config.TelegramConfig?.botUsername || process.env.TELEGRAM_BOT_USERNAME || '',
      DanmakuAutoLoadDefault: config.SiteConfig.DanmakuAutoLoadDefault !== false,
      loginBackgroundImage: config.ThemeConfig?.loginBackgroundImage || '',
      registerBackgroundImage: config.ThemeConfig?.registerBackgroundImage || '',
      homeBackgroundImage: config.ThemeConfig?.homeBackgroundImage || '',
      progressThumbType: config.ThemeConfig?.progressThumbType || 'default',
      loadingStyle: config.ThemeConfig?.loadingStyle || 'talisman',
      rateBadgeStyle: config.ThemeConfig?.rateBadgeStyle || 'flag',
      progressThumbPresetId: config.ThemeConfig?.progressThumbPresetId || '',
      progressThumbCustomUrl: config.ThemeConfig?.progressThumbCustomUrl || '',
      AIEnabled: config.AIConfig?.Enabled || false,
      AIEnableHomepageEntry: config.AIConfig?.EnableHomepageEntry || false,
      AIEnableVideoCardEntry: config.AIConfig?.EnableVideoCardEntry || false,
      AIEnablePlayPageEntry: config.AIConfig?.EnablePlayPageEntry || false,
      AIDefaultMessageNoVideo: config.AIConfig?.DefaultMessageNoVideo || '',
      AIDefaultMessageWithVideo: config.AIConfig?.DefaultMessageWithVideo || '',
    };
  }

  const body = JSON.stringify(payload);
  const etag = `"sc-${simpleHash(body)}"`;
  return {
    body,
    etag,
    expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
  };
}

export async function GET(request: NextRequest) {
  const cacheKey = '/api/server-config';
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
      pending = computeServerConfigPayload().then((res) => {
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
    'Content-Type': 'application/json; charset=utf-8',
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

  return new NextResponse(entry.body, {
    status: 200,
    headers,
  });
}
