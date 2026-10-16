/**
 * Tokens inside the Next.js middleware matcher:
 * `/((?!token1|token2|...).*)`
 *
 * Vercel never invokes middleware for these paths. EdgeOne's OpenNext runtime
 * still does: the platform matcher is a catch-all, and `config.matcher`
 * exclusions are not applied before `handleAuthFailure`. Skipping the same
 * tokens here is what stops `/login` from redirecting to itself.
 *
 * `config.matcher` in src/middleware.ts must stay a string literal (Next.js
 * statically analyzes it) and must list these tokens in the same order.
 * src/middleware.auth.test.ts asserts the two copies match.
 */
export const MIDDLEWARE_MATCHER_EXCLUSIONS = [
  '_next/static',
  '_next/image',
  'favicon.ico',
  'login',
  'register',
  'oidc-register',
  'qr-login',
  'warning',
  'tv/login',
  'api/login',
  'api/register',
  'api/logout',
  'api/auth/oidc',
  'api/auth/qr',
  'api/auth/refresh',
  'api/telegram/login',
  'api/telegram/config',
  'api/telegram/webhook',
  'api/cron/',
  'api/server-config',
  'api/proxy-m3u8',
  'api/cms-proxy',
  'api/tvbox/subscribe',
  'api/theme/css',
  'api/openlist/cms-proxy',
  'api/openlist/play',
  'api/openlist/proxy',
  'api/emby/cms-proxy',
  'api/emby/play',
  'api/emby/subtitle',
  'api/emby/sources',
  'tvbox/',
] as const;

/** Same prefix rule as the matcher negative lookahead. */
export function isMatcherExcludedPath(pathname: string): boolean {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return MIDDLEWARE_MATCHER_EXCLUSIONS.some((token) =>
    path.startsWith(`/${token}`)
  );
}
