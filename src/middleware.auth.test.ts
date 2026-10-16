/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { MIDDLEWARE_MATCHER_EXCLUSIONS } from '@/lib/middleware-public-paths';

import { config, middleware } from './middleware';

/**
 * Paths named in config.matcher must not depend on the matcher alone.
 * EdgeOne still runs middleware for them; Vercel does not.
 */
function matcherExclusionTokens(matcher: string): string[] {
  const match = matcher.match(/\(\?!([^)]+)\)/);
  if (!match) {
    throw new Error(`middleware matcher has no exclusions: ${matcher}`);
  }
  return match[1].split('|').filter(Boolean);
}

function samplePathForToken(token: string): string {
  return token.endsWith('/') ? `/${token}probe` : `/${token}`;
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

describe('middleware public paths on runtimes that ignore config.matcher', () => {
  const originalPassword = process.env.PASSWORD;
  const originalTvMode = process.env.ENABLE_TV_MODE;
  const originalStorageType = process.env.NEXT_PUBLIC_STORAGE_TYPE;

  beforeEach(() => {
    process.env.PASSWORD = 'test-password';
    process.env.ENABLE_TV_MODE = 'true';
  });

  afterEach(() => {
    if (originalPassword === undefined) {
      delete process.env.PASSWORD;
    } else {
      process.env.PASSWORD = originalPassword;
    }
    if (originalTvMode === undefined) {
      delete process.env.ENABLE_TV_MODE;
    } else {
      process.env.ENABLE_TV_MODE = originalTvMode;
    }
    if (originalStorageType === undefined) {
      delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
    } else {
      process.env.NEXT_PUBLIC_STORAGE_TYPE = originalStorageType;
    }
  });

  const matcher = config.matcher[0];
  const tokens = matcherExclusionTokens(matcher);

  it('keeps config.matcher exclusions identical to the in-middleware skip list', () => {
    expect(tokens).toEqual([...MIDDLEWARE_MATCHER_EXCLUSIONS]);
  });

  it.each(tokens.map((token) => [token, samplePathForToken(token)] as const))(
    'does not auth-gate matcher exclusion %s (%s)',
    async (_token, pathname) => {
      const response = await middleware(
        new NextRequest(`https://tv.example${pathname}`)
      );

      expect(isRedirect(response)).toBe(false);
      expect(response.status).not.toBe(401);
      expect(response.headers.get('location')).toBeNull();
    }
  );

  it('serves /login with an existing redirect query instead of nesting another redirect', async () => {
    const response = await middleware(
      new NextRequest('https://tv.example/login?redirect=%2Fplay')
    );

    expect(isRedirect(response)).toBe(false);
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows nested public API paths that the matcher excludes by prefix', async () => {
    const response = await middleware(
      new NextRequest('https://tv.example/api/emby/play/token/file.m3u8')
    );

    expect(response.status).not.toBe(401);
    expect(isRedirect(response)).toBe(false);
  });

  it('still sends unauthenticated pages to login', async () => {
    const response = await middleware(
      new NextRequest('https://tv.example/play')
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://tv.example/login?redirect=%2Fplay'
    );
  });

  it('lets a valid localstorage session through to protected pages', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
    const request = new NextRequest('https://tv.example/play', {
      headers: {
        cookie: `auth=${encodeURIComponent(
          JSON.stringify({ password: 'test-password' })
        )}`,
      },
    });

    const response = await middleware(request);

    expect(isRedirect(response)).toBe(false);
    expect(response.status).not.toBe(401);
  });

  it('still rejects unauthenticated protected APIs', async () => {
    const protectedPaths = [
      '/api/search',
      '/api/auth/devices',
      '/api/telegram/bind',
      '/api/tvbox/config',
      '/api/openlist/list',
      '/api/emby/detail',
    ];

    for (const pathname of protectedPaths) {
      const response = await middleware(
        new NextRequest(`https://tv.example${pathname}`)
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Unauthorized');
    }
  });

  it('still hides TV routes when TV mode is off, except the public TV login page', async () => {
    process.env.ENABLE_TV_MODE = 'false';

    const tvHome = await middleware(new NextRequest('https://tv.example/tv'));
    expect(tvHome.status).toBe(404);

    const tvLogin = await middleware(
      new NextRequest('https://tv.example/tv/login')
    );
    expect(tvLogin.status).not.toBe(404);
    expect(isRedirect(tvLogin)).toBe(false);
  });
});
