/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { CURRENT_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSR_CACHE_KEY = '/api/server-config';
const SSR_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
const PUBLIC_EO_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300, durable';

function getSsrCacheStore(): Map<string, { body: string; expiresAt: number }> {
  const g = globalThis as any;
  if (!(g.__moontvSsrPublicCache instanceof Map)) {
    g.__moontvSsrPublicCache = new Map();
  }
  return g.__moontvSsrPublicCache;
}

function getSsrInflightStore(): Map<string, Promise<string>> {
  const g = globalThis as any;
  if (!(g.__moontvSsrPublicInflight instanceof Map)) {
    g.__moontvSsrPublicInflight = new Map();
  }
  return g.__moontvSsrPublicInflight;
}

export async function GET(request: NextRequest) {
  console.log('server-config called: ', request.url);

  const now = Date.now();
  const cacheStore = getSsrCacheStore();
  const cached = cacheStore.get(SSR_CACHE_KEY);
  if (cached && typeof cached.body === 'string' && cached.expiresAt > now) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': PUBLIC_CACHE_CONTROL,
        'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
        'EO-CDN-Cache-Control': PUBLIC_EO_CDN_CACHE_CONTROL,
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

      if (storageType === 'localstorage') {
        const localPayload = JSON.stringify({
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
        });
        cacheStore.set(SSR_CACHE_KEY, {
          body: localPayload,
          expiresAt: Date.now() + SSR_CACHE_TTL_MS,
        });
        return localPayload;
      }

      const config = await getConfig();
      const result = {
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
      const payload = JSON.stringify(result);
      cacheStore.set(SSR_CACHE_KEY, {
        body: payload,
        expiresAt: Date.now() + SSR_CACHE_TTL_MS,
      });
      return payload;
    })();
    inflightStore.set(SSR_CACHE_KEY, pending);
  }

  let body: string;
  try {
    body = await pending;
  } finally {
    if (!wasCoalesced) {
      inflightStore.delete(SSR_CACHE_KEY);
    }
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': PUBLIC_CACHE_CONTROL,
      'CDN-Cache-Control': PUBLIC_CDN_CACHE_CONTROL,
      'EO-CDN-Cache-Control': PUBLIC_EO_CDN_CACHE_CONTROL,
      'x-moontv-ssr-cache': wasCoalesced ? 'HIT' : 'MISS',
      'x-eo-ssr-cache': wasCoalesced ? 'HIT-SSR' : 'MISS-SSR',
    },
  });
}
