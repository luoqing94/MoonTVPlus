#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function loadLocalEnvFile() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (quote === '"') {
      value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    process.env[match[1]] = value;
  }
}

loadLocalEnvFile();

const runtimeEnvKeys = [
  'USERNAME',
  'PASSWORD',
  'NEXT_PUBLIC_STORAGE_TYPE',
  'UPSTASH_URL',
  'UPSTASH_TOKEN',
  'TURSO_URL',
  'TURSO_TOKEN',
  'TMDB_API_KEY',
  'TMDB_IMAGE_DOMAIN',
  'NEXT_PUBLIC_SITE_NAME',
  'ANNOUNCEMENT',
  'ENABLE_REGISTER',
  'NEXT_PUBLIC_SEARCH_MAX_PAGE',
  'NEXT_PUBLIC_DOUBAN_PROXY_TYPE',
  'NEXT_PUBLIC_DOUBAN_PROXY',
  'NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE',
  'NEXT_PUBLIC_DOUBAN_IMAGE_PROXY',
  'NEXT_PUBLIC_ENABLE_OFFLINE_DOWNLOAD',
  'NEXT_PUBLIC_IMAGE_PROXY',
  'NEXT_PUBLIC_IMAGE_PROXY_PREFIX',
  'NEXT_PUBLIC_DISABLE_YELLOW_FILTER',
  'DISABLE_USER_FOLDER',
  'NEXT_PUBLIC_STORAGE_PREFIX',
  'NEXT_PUBLIC_ENABLE_STREAM_PROXY',
  'NEXT_PUBLIC_STREAM_PROXY_URL',
  'NEXT_PUBLIC_ENABLE_TURNSTILE',
  'TURNSTILE_SECRET_KEY',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'NEXT_PUBLIC_THEME',
  'NEXT_PUBLIC_THEME_COLOR',
  'NEXT_PUBLIC_APP_URL',
  'ENABLE_TVBOX_SUBSCRIBE',
  'TVBOX_SUBSCRIBE_PATH',
  'TVBOX_SUBSCRIBE_TOKEN',
  'WATCH_ROOM_ENABLED',
  'WATCH_ROOM_WS_URL',
  'WATCH_ROOM_SERVER_URL',
  'WEBSOCKET_SECRET',
  'WEB_PUSH_EMAIL',
  'WEB_PUSH_PRIVATE_KEY',
  'WEB_PUSH_PUBLIC_KEY',
  'WEB_PUSH_BASEURL',
  'NEXT_PUBLIC_BASE_PATH',
];

/**
 * Read Next.js middleware matcher sources (originalSource strings).
 * Prefer build manifest, then compiled edge function, then source middleware.ts.
 */
function getMiddlewareMatcherSources() {
  const sources = [];

  const manifestPath = join(process.cwd(), '.next', 'server', 'middleware-manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const middlewareEntries = manifest?.middleware || {};
    for (const entry of Object.values(middlewareEntries)) {
      for (const matcher of entry?.matchers || []) {
        if (typeof matcher?.originalSource === 'string' && matcher.originalSource) {
          sources.push(matcher.originalSource);
        } else if (typeof matcher?.regexp === 'string' && matcher.regexp) {
          sources.push(matcher.regexp);
        }
      }
    }
    if (sources.length > 0) {
      return [...new Set(sources)];
    }
  } catch {
    // fall through
  }

  const edgeFunctionPath = join(process.cwd(), '.edgeone', 'edge-functions', 'index.js');
  try {
    const code = readFileSync(edgeFunctionPath, 'utf8');
    // compiled form: matcher:["/((?!...).*)"] or matcher:["..."]
    const matcherArrayMatch = code.match(/matcher:\s*(\[(?:[^\[\]"']|"[^"]*"|'[^']*')*\])/);
    if (matcherArrayMatch) {
      try {
        const parsed = JSON.parse(matcherArrayMatch[1].replace(/'/g, '"'));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item) {
              sources.push(item);
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }
    if (sources.length > 0) {
      return [...new Set(sources)];
    }
  } catch {
    // fall through
  }

  const middlewareSourcePath = join(process.cwd(), 'src', 'middleware.ts');
  try {
    const source = readFileSync(middlewareSourcePath, 'utf8');
    // export const config = { matcher: [ '...' ] } or matcher: '...'
    const blockMatch = source.match(
      /export\s+const\s+config\s*=\s*\{[\s\S]*?matcher\s*:\s*(\[[\s\S]*?\]|['"`][^'"`]+['"`])/
    );
    if (blockMatch) {
      const raw = blockMatch[1].trim();
      if (raw.startsWith('[')) {
        const stringLiterals = [...raw.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
        sources.push(...stringLiterals);
      } else {
        const single = raw.slice(1, -1);
        if (single) {
          sources.push(single);
        }
      }
    }
  } catch {
    // ignore
  }

  return [...new Set(sources.filter(Boolean))];
}

/**
 * Convert Next.js middleware matcher originalSource exclusions into path prefixes.
 * Supports the common form: /((?!a|b|c/).*)
 */
function extractSkipPathsFromMatcherSource(matcherSource) {
  if (typeof matcherSource !== 'string' || !matcherSource) {
    return [];
  }

  const skipPaths = new Set();

  // Negative-lookahead exclusion list inside /((?!... ).*)
  const negativeLookahead = matcherSource.match(/\(\?\!([^)]+)\)/);
  if (negativeLookahead) {
    for (const part of negativeLookahead[1].split('|')) {
      const token = part.trim();
      if (!token) {
        continue;
      }
      // Keep trailing slash semantics (api/cron/, tvbox/) for prefix matching.
      const normalized = token.startsWith('/') ? token : `/${token}`;
      skipPaths.add(normalized);
    }
  }

  return [...skipPaths];
}

function resolveEdgeOneMiddlewareSkipPaths() {
  const matcherSources = getMiddlewareMatcherSources();
  const skipPaths = new Set();

  for (const source of matcherSources) {
    for (const path of extractSkipPathsFromMatcherSource(source)) {
      skipPaths.add(path);
    }
  }
  for (const staticPublicPath of ['/manifest.json', '/icons/', '/logo.png', '/robots.txt']) {
    skipPaths.add(staticPublicPath);
  }

  const resolved = [...skipPaths].sort((a, b) => a.localeCompare(b));
  if (resolved.length === 0) {
    console.warn(
      '[edgeone-build] Unable to derive middleware skip paths from matcher; edge function will rely on compiled config.matcher only'
    );
  } else {
    console.log(
      `[edgeone-build] Derived ${resolved.length} middleware skip path(s) from matcher: ${resolved.join(', ')}`
    );
  }
  return resolved;
}

function isNextStyleComplexMatcher(source) {
  return (
    typeof source === 'string' &&
    (source.includes('(?') ||
      source.includes('[^') ||
      source.includes('.*') ||
      source.includes('|') ||
      source.endsWith('$'))
  );
}

/**
 * EdgeOne platform-level middleware.matcher uses path-to-regexp style sources
 * (e.g. /:path*, /api/:path*). Next.js negative-lookahead matchers are only safe
 * inside the compiled edge function (matchesPath). For complex Next matchers we
 * keep a catch-all outer intercept and rely on runtime matcher + derived skip paths.
 */
function resolveEdgeOneMiddlewareMatchers() {
  const matcherSources = getMiddlewareMatcherSources();
  if (matcherSources.length === 0) {
    return [{ source: '/:path*' }];
  }

  if (matcherSources.some((source) => isNextStyleComplexMatcher(source))) {
    console.log(
      '[edgeone-build] Next.js complex middleware matcher detected; edge-functions config keeps /:path* and enforces exclusions at runtime'
    );
    return [{ source: '/:path*' }];
  }

  return matcherSources.map((source) => ({ source }));
}

function getRuntimeEnvLiteral() {
  const env = {};
  for (const key of runtimeEnvKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return JSON.stringify(env);
}

function replaceEnvLiterals(code, envLiteral) {
  let output = '';
  let cursor = 0;
  let replaced = 0;
  const needle = 'env: {';

  while (true) {
    const start = code.indexOf(needle, cursor);
    if (start === -1) {
      output += code.slice(cursor);
      break;
    }

    let i = start + 'env: '.length;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; i < code.length; i += 1) {
      const char = code[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }

    if (depth !== 0) {
      console.warn('[edgeone-build] Unable to replace an env literal: malformed object');
      output += code.slice(cursor);
      break;
    }

    output += code.slice(cursor, start) + `env: ${envLiteral}`;
    cursor = i;
    replaced += 1;
  }

  if (replaced > 0) {
    console.log(`[edgeone-build] Replaced ${replaced} generated env literal(s) with filtered runtime env`);
  }

  return output;
}

function buildMatcherFallbackSnippet(skipPaths) {
  const matcherFallbackMarker = '/* edgeone-middleware-matcher-fallback */';
  // Mirrors Next negative-lookahead tokens as pathname prefixes (e.g. /login, /api/cron/).
  return `${matcherFallbackMarker}
  const edgeOneMiddlewareSkipPaths = ${JSON.stringify(skipPaths)};
  if (edgeOneMiddlewareSkipPaths.some((path) => pathname === path || pathname.startsWith(path))) {
    return null;
  }`;
}

function patchEdgeOneOutputHeaders() {
  const eoConfigPath = join(process.cwd(), '.edgeone', 'edgeone.json');
  let config;
  try {
    config = JSON.parse(readFileSync(eoConfigPath, 'utf8'));
  } catch {
    return;
  }
  const existingHeaders = Array.isArray(config.headers) ? config.headers : [];
  const defaultRules = [
    {
      source: '/_next/static/*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    {
      source: '/manifest.json',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
    },
    {
      source: '/icons/*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }],
    },
    {
      source: '/logo.png',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }],
    },
    {
      source: '/favicon.ico',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }],
    },
  ];
  const merged = [...existingHeaders];
  for (const rule of defaultRules) {
    if (!merged.some((item) => item && item.source === rule.source)) {
      merged.push(rule);
    }
  }
  config.headers = merged;
  writeFileSync(eoConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[edgeone-build] Patched .edgeone/edgeone.json static cache headers (${merged.length} rule(s))`);
}

function patchEdgeFunctionEnvInjection() {
  const edgeFunctionPath = join(process.cwd(), '.edgeone', 'edge-functions', 'index.js');
  let code;
  try {
    code = readFileSync(edgeFunctionPath, 'utf8');
  } catch {
    return;
  }

  const marker = '/* edgeone-process-env-injected */';
  const envLiteral = getRuntimeEnvLiteral();
  const edgeOneMiddlewareSkipPaths = resolveEdgeOneMiddlewareSkipPaths();

  code = replaceEnvLiterals(code, envLiteral);

  const target = 'let request = context.request;';
  if (!code.includes(marker) && !code.includes(target)) {
    console.warn('[edgeone-build] Unable to patch edge function env injection: target not found');
  } else if (!code.includes(marker)) {
    code = code.replace(
      target,
      `${target}\n          ${marker}\n          if (typeof globalThis !== 'undefined' && globalThis.process?.env && context?.env) {\n            Object.assign(globalThis.process.env, context.env);\n          }`
    );
  }

  const middlewareSignature = 'async function executeMiddleware({request}) {';
  const middlewareMarker = '/* edgeone-middleware-env-injected */';
  if (!code.includes(middlewareMarker) && !code.includes(middlewareSignature)) {
    if (!code.includes('async function executeMiddleware({request, env})')) {
      console.warn('[edgeone-build] Unable to patch middleware env injection: target not found');
    }
  } else if (!code.includes(middlewareMarker)) {
    code = code.replace(
      middlewareSignature,
      `async function executeMiddleware({request, env}) {\n  ${middlewareMarker}\n  if (typeof globalThis !== 'undefined' && globalThis.process?.env && env) {\n    Object.assign(globalThis.process.env, env);\n  }`
    );
  }

  const matcherFallbackMarker = '/* edgeone-middleware-matcher-fallback */';
  const matcherFallbackTarget = `  if (!matchesPath(pathname, config.matcher)) {
    return null;
  }`;
  const fallbackSnippet = buildMatcherFallbackSnippet(edgeOneMiddlewareSkipPaths);

  // Replace an existing dynamic/static fallback block so rebuilds stay in sync with middleware.
  const existingFallbackRe =
    /\/\* edgeone-middleware-matcher-fallback \*\/[\s\S]*?if \(edgeOneMiddlewareSkipPaths\.some\([\s\S]*?\) \{\s*return null;\s*\}/;

  if (existingFallbackRe.test(code)) {
    code = code.replace(existingFallbackRe, fallbackSnippet);
  } else if (code.includes(matcherFallbackTarget)) {
    code = code.replace(matcherFallbackTarget, `${matcherFallbackTarget}\n\n  ${fallbackSnippet}`);
  } else if (!code.includes(matcherFallbackMarker)) {
    console.warn('[edgeone-build] Unable to patch middleware matcher fallback: target not found');
  }

  const edgeCacheMarker = '/* edgeone-public-api-cache */';
  const edgeCacheHelper = `${edgeCacheMarker}
const __EO_PUBLIC_CACHE_TTL_MS = 60000;
function __edgeoneInvalidatePublicCache() {
  globalThis.__moontvEdgePublicCache = null;
  globalThis.__moontvEdgePublicInflight = null;
}
async function __edgeoneOriginFetchWithCache(request, urlInfo, fetchFn, middlewareResponseHeaders) {
  try {
    const method = ((request && request.method) || 'GET').toUpperCase();
    const parsedUrl = urlInfo || new URL(request.url);
    const pathname = parsedUrl.pathname || '/';
    if (method !== 'GET' && method !== 'HEAD') {
      if (pathname.startsWith('/api/admin')) {
        __edgeoneInvalidatePublicCache();
      }
      return await fetchFn(request);
    }
    const isPublicApi = pathname === '/api/theme/css' || pathname === '/api/server-config';
    const cookieHeader = (request.headers && request.headers.get && request.headers.get('cookie')) || '';
    const hasAuthCookie = /(?:^|;\\s*)auth=/.test(cookieHeader);
    const isRsc = Boolean(
      request.headers &&
      request.headers.get &&
      (request.headers.get('rsc') ||
        request.headers.get('next-router-state-tree') ||
        request.headers.get('next-router-prefetch'))
    );
    const isAnonLoginHtml =
      (pathname === '/login' || pathname === '/tv/login') &&
      !parsedUrl.search &&
      !hasAuthCookie &&
      !isRsc &&
      !middlewareResponseHeaders;
    if (!isPublicApi && !isAnonLoginHtml) {
      return await fetchFn(request);
    }
    const cacheKey = pathname;
    const now = Date.now();
    const cache =
      globalThis.__moontvEdgePublicCache ||
      (globalThis.__moontvEdgePublicCache = new Map());
    const cached = cache.get(cacheKey);
    if (cached && now - cached.cachedAt < __EO_PUBLIC_CACHE_TTL_MS) {
      const hitHeaders = new Headers(cached.headers);
      hitHeaders.set('x-eo-edge-cache', 'HIT-EDGE');
      return new Response(method === 'HEAD' ? null : cached.body, {
        status: 200,
        headers: hitHeaders,
      });
    }
    if (method === 'HEAD') {
      return await fetchFn(request);
    }
    const inflight =
      globalThis.__moontvEdgePublicInflight ||
      (globalThis.__moontvEdgePublicInflight = new Map());
    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const res = await fetchFn(request);
        if (!res || res.status !== 200 || (res.headers && res.headers.get && res.headers.get('set-cookie'))) {
          return { passthrough: res };
        }
        const bodyText = await res.text();
        const storedHeaders = [];
        for (const k of ['content-type', 'etag', 'link', 'vary', 'x-powered-by']) {
          const v = res.headers.get(k);
          if (v) storedHeaders.push([k, v]);
        }
        storedHeaders.push(['cache-control', 'no-cache']);
        const entry = {
          body: bodyText,
          headers: storedHeaders,
          cachedAt: Date.now(),
        };
        cache.set(cacheKey, entry);
        return { entry };
      })();
      inflight.set(cacheKey, pending);
      pending.finally(() => {
        if (inflight.get(cacheKey) === pending) {
          inflight.delete(cacheKey);
        }
      }).catch(() => {});
    }
    const outcome = await pending;
    if (outcome && outcome.entry) {
      const missHeaders = new Headers(outcome.entry.headers);
      missHeaders.set('x-eo-edge-cache', 'MISS-EDGE');
      return new Response(outcome.entry.body, {
        status: 200,
        headers: missHeaders,
      });
    }
    if (outcome && outcome.passthrough) {
      return outcome.passthrough;
    }
  } catch (_) {
    // fall through to direct origin fetch on any unexpected error
  }
  return await fetchFn(request);
}
`;

  if (!code.includes(edgeCacheMarker)) {
    code = `${edgeCacheHelper}\n${code}`;
  }
  const originFetchTarget = 'const originResponse = await fetch(request);';
  const originFetchReplacement =
    'const originResponse = await __edgeoneOriginFetchWithCache(request, typeof urlInfo !== "undefined" ? urlInfo : null, fetch, typeof middlewareResponseHeaders !== "undefined" ? middlewareResponseHeaders : null);';
  if (code.includes(originFetchTarget)) {
    code = code.replaceAll(originFetchTarget, originFetchReplacement);
  }
  const adminInvalidateTarget = 'const pathname = url.pathname;';
  const adminInvalidateMarker = '/* edgeone-admin-cache-invalidate */';
  if (!code.includes(adminInvalidateMarker) && code.includes(adminInvalidateTarget)) {
    code = code.replace(
      adminInvalidateTarget,
      `${adminInvalidateTarget}\n  ${adminInvalidateMarker}\n  if (request && request.method && request.method.toUpperCase() !== 'GET' && request.method.toUpperCase() !== 'HEAD' && pathname.startsWith('/api/admin')) {\n    if (typeof __edgeoneInvalidatePublicCache === 'function') __edgeoneInvalidatePublicCache();\n  }`
    );
  }

  writeFileSync(edgeFunctionPath, code);
  console.log('[edgeone-build] Patched edge function process.env injection & public API cache');
}

/**
 * Write EdgeOne edge-function route interception matcher from Next.js middleware config.
 * EdgeOne outer matcher decides when the edge function is invoked; keep it aligned with
 * middleware originalSource so exclusions are not a hardcoded catch-all forever.
 */
function patchEdgeFunctionMiddlewareConfig() {
  const configPath = join(process.cwd(), '.edgeone', 'edge-functions', 'config.json');
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    console.warn('[edgeone-build] edge-functions config.json not found, skip middleware matcher patch');
    return;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    console.warn('[edgeone-build] Failed to parse edge-functions config.json:', error);
    return;
  }

  const matchers = resolveEdgeOneMiddlewareMatchers();
  config.routes = Array.isArray(config.routes) ? config.routes : [];
  config.middleware = {
    ...(config.middleware && typeof config.middleware === 'object' ? config.middleware : {}),
    runtime: config.middleware?.runtime || 'edge',
    matcher: matchers,
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    `[edgeone-build] Patched edge-functions middleware matcher from Next.js middleware (${matchers.length} rule(s))`
  );
}

/**
 * Fix /api returning HTTP 404 while body is correct and function logs show 200.
 *
 * EdgeOne route model:
 * - rules before { handle: "filesystem" } = preprocess
 * - filesystem tries static assets first (miss often becomes 404)
 * - rules after filesystem = SSR / API back-to-origin
 *
 * If /api is not explicitly listed after filesystem, static miss 404 can leak to
 * the client even when ssr-node successfully returns 200 + body.
 *
 * @see https://pages.edgeone.ai/document/building-output-configuration
 */
function isApiRouteRule(route) {
  if (!route || typeof route.src !== 'string') {
    return false;
  }
  return (
    route.src === '^/api/(.*)$' ||
    route.src === '^/api(?:/.*)?$' ||
    route.src === '^/api$' ||
    route.src === '/api/(.*)' ||
    route.src === '/api/*'
  );
}

function isCatchAllRoute(route) {
  if (!route || typeof route.src !== 'string') {
    return false;
  }
  return (
    route.src === '/.*' ||
    route.src === '^/.*$' ||
    route.src === '^(.*)$' ||
    route.src === '/(.*)'
  );
}

function patchSsrNodeRoutes() {
  const configPath = join(
    process.cwd(),
    '.edgeone',
    'cloud-functions',
    'ssr-node',
    'config.json'
  );

  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    console.warn('[edgeone-build] ssr-node config.json not found, skip API route patch');
    return;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    console.warn('[edgeone-build] Failed to parse ssr-node config.json:', error);
    return;
  }

  const originalRoutes = Array.isArray(config.routes) ? config.routes : [];
  // Drop previous patches / weak API rules; keep other generated rules.
  const routes = originalRoutes.filter(
    (route) => !isApiRouteRule(route) && !isCatchAllRoute(route)
  );

  let filesystemIdx = routes.findIndex((route) => route && route.handle === 'filesystem');
  if (filesystemIdx === -1) {
    routes.push({ handle: 'filesystem' });
    filesystemIdx = routes.length - 1;
    console.log('[edgeone-build] Inserted missing { handle: "filesystem" } into ssr-node routes');
  }

  const before = routes.slice(0, filesystemIdx + 1);
  const after = routes.slice(filesystemIdx + 1).filter((route) => !isCatchAllRoute(route));

  // Official full-stack pattern: API + catch-all AFTER filesystem → Node SSR handler.
  // Do not write private fields into config.json — EdgeOne may reject unknown keys.
  const apiRoute = {
    src: '^/api(?:/.*)?$',
    dest: '/api',
  };
  const apiRouteWithCapture = {
    src: '^/api/(.*)$',
    dest: '/api/$1',
  };
  const catchAll = {
    src: '/.*',
  };

  // Short-circuit /api BEFORE filesystem so static layer never owns the request.
  // Avoids "static miss 404 status + SSR body" composites on some EdgeOne builds.
  const apiBeforeFilesystem = {
    src: '^/api(?:/.*)?$',
    dest: '/api',
  };

  const preFilesystem = before.slice(0, -1).filter((route) => !isApiRouteRule(route));
  const filesystemRule = before[before.length - 1];

  config.version = config.version || 3;
  config.routes = [
    ...preFilesystem,
    apiBeforeFilesystem,
    filesystemRule,
    apiRouteWithCapture,
    apiRoute,
    ...after,
    catchAll,
  ];

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    '[edgeone-build] Patched ssr-node routes: /api forced before+after filesystem (fix API 404 status leak)'
  );
}

/**
 * Wrap ssr-node handler so Response.status is never dropped if the runtime
 * re-constructs the response without status (defensive).
 */
function patchHandlerFile(handlerPath, code) {
  const marker = '/* edgeone-api-status-guard */';
  const ssrCacheMarker = '/* edgeone-ssr-public-cache */';
  if (code.includes(marker)) {
    console.log('[edgeone-build] ssr-node handler status guard already present');
    return;
  }

  const guard = `
${marker}
${ssrCacheMarker}
const __EO_SSR_PUBLIC_CACHE_TTL_MS = 60000;
function __edgeoneEnsureResponseStatus(response, fallbackStatus) {
  if (!response) return response;
  try {
    const status = Number(response.status || fallbackStatus || 200);
    if (status >= 100 && status <= 599 && response.status === status) {
      return response;
    }
    if (typeof Response !== 'undefined' && (response instanceof Response || typeof response.headers?.get === 'function')) {
      const headers = new Headers(response.headers || {});
      return new Response(response.body, {
        status: status >= 100 && status <= 599 ? status : 200,
        statusText: response.statusText,
        headers,
      });
    }
  } catch (_) {
    // ignore
  }
  return response;
}

function __edgeoneWrapHandler(fn) {
  if (typeof fn !== 'function') return fn;
  return async function __edgeonePatchedHandler(request, context) {
    try {
      const rawUrl = (request && request.url) || '';
      const method = ((request && request.method) || 'GET').toUpperCase();
      const pathname = rawUrl ? new URL(rawUrl, 'http://localhost').pathname : '';
      if (method !== 'GET' && method !== 'HEAD') {
        if (pathname.startsWith('/api/admin')) {
          globalThis.__moontvSsrPublicCache = null;
          globalThis.__moontvSsrPublicInflight = null;
        }
      } else if (pathname === '/api/theme/css' || pathname === '/api/server-config') {
        const now = Date.now();
        const cache =
          globalThis.__moontvSsrPublicCache ||
          (globalThis.__moontvSsrPublicCache = new Map());
        const cached = cache.get(pathname);
        if (cached && now - cached.cachedAt < __EO_SSR_PUBLIC_CACHE_TTL_MS) {
          const hitHeaders = new Headers(cached.headers);
          hitHeaders.set('x-eo-ssr-cache', 'HIT-SSR');
          return new Response(method === 'HEAD' ? null : cached.body, {
            status: 200,
            headers: hitHeaders,
          });
        }
        if (method === 'GET') {
          const inflight =
            globalThis.__moontvSsrPublicInflight ||
            (globalThis.__moontvSsrPublicInflight = new Map());
          let pending = inflight.get(pathname);
          if (!pending) {
            pending = (async () => {
              const rawRes = __edgeoneEnsureResponseStatus(await fn(request, context), 200);
              if (!rawRes || rawRes.status !== 200 || (rawRes.headers && rawRes.headers.get && rawRes.headers.get('set-cookie'))) {
                return { passthrough: rawRes };
              }
              const bodyText = await rawRes.text();
              const storedHeaders = [];
              for (const k of ['content-type', 'etag', 'vary', 'x-powered-by']) {
                const v = rawRes.headers.get(k);
                if (v) storedHeaders.push([k, v]);
              }
              storedHeaders.push(['cache-control', 'no-cache']);
              const entry = {
                body: bodyText,
                headers: storedHeaders,
                cachedAt: Date.now(),
              };
              cache.set(pathname, entry);
              return { entry };
            })();
            inflight.set(pathname, pending);
            pending.finally(() => {
              if (inflight.get(pathname) === pending) {
                inflight.delete(pathname);
              }
            }).catch(() => {});
          }
          const outcome = await pending;
          if (outcome && outcome.entry) {
            const missHeaders = new Headers(outcome.entry.headers);
            missHeaders.set('x-eo-ssr-cache', 'MISS-SSR');
            return new Response(outcome.entry.body, {
              status: 200,
              headers: missHeaders,
            });
          }
          if (outcome && outcome.passthrough) {
            return outcome.passthrough;
          }
        }
      }
    } catch (_) {
      // fall through to standard handler
    }
    const response = await fn(request, context);
    return __edgeoneEnsureResponseStatus(response, 200);
  };
}
`;

  let patched = code;
  let applied = false;

  if (/export\s+default\s+/.test(patched) && !applied) {
    patched = `${guard}\n${patched.replace(
      /export\s+default\s+/,
      'const __edgeoneOriginalDefault = '
    )}\nexport default __edgeoneWrapHandler(__edgeoneOriginalDefault);\n`;
    applied = true;
  }

  if (!applied && /module\.exports\s*=/.test(patched)) {
    patched = `${guard}\n${patched}\n;module.exports = __edgeoneWrapHandler(module.exports?.default || module.exports);\nif (module.exports && module.exports.default) { module.exports.default = __edgeoneWrapHandler(module.exports.default); }\n`;
    applied = true;
  }

  if (!applied && /exports\.default\s*=/.test(patched)) {
    patched = `${guard}\n${patched}\n;exports.default = __edgeoneWrapHandler(exports.default);\n`;
    applied = true;
  }

  if (!applied) {
    console.warn(
      '[edgeone-build] Unable to wrap ssr-node handler export (unknown module shape); route patch still applied'
    );
    return;
  }

  writeFileSync(handlerPath, patched);
  console.log(`[edgeone-build] Patched ssr-node handler status guard: ${handlerPath}`);
}

function patchSsrNodeHandlerStatus() {
  const candidates = [
    join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', 'handler.js'),
    join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', 'index.js'),
    join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', 'index.mjs'),
    join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', 'handler.mjs'),
  ];

  for (const handlerPath of candidates) {
    try {
      const code = readFileSync(handlerPath, 'utf8');
      patchHandlerFile(handlerPath, code);
      return;
    } catch {
      // try next
    }
  }

  console.warn('[edgeone-build] ssr-node handler not found, skip status patch');
}

const isInsideEdgeOneBuilder = process.env.NEXT_PRIVATE_STANDALONE === 'true';

const command = isInsideEdgeOneBuilder
  ? 'BUILD_TARGET=edgeone EDGEONE_PAGES=1 pnpm build'
  : 'BUILD_TARGET=edgeone EDGEONE_PAGES=1 edgeone makers build';

const child = spawn(command, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    BUILD_TARGET: 'edgeone',
    EDGEONE_PAGES: '1',
  },
});

child.on('exit', (code, signal) => {
  if (!signal && code === 0) {
    for (const file of ['edgeone.json', 'package.json']) {
      copyFileSync(join(process.cwd(), file), join(process.cwd(), '.edgeone', file));
    }

    patchEdgeOneOutputHeaders();
    patchEdgeFunctionEnvInjection();
    patchEdgeFunctionMiddlewareConfig();
    patchSsrNodeRoutes();
    patchSsrNodeHandlerStatus();

    for (const envPath of [
      join(process.cwd(), '.edgeone', '.env'),
      join(process.cwd(), '.edgeone', 'cloud-functions', 'ssr-node', '.env'),
    ]) {
      rmSync(envPath, { force: true });
    }
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
