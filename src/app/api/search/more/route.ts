/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getConfig } from '@/lib/config';
import { SEARCH_PAGE_HARD_CEILING, searchFromApi } from '@/lib/downstream';
import { filterMoviesByRestTokens, splitQuery } from '@/lib/search-query';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

type SourcePageRequest = {
  key: string;
  /** Next CMS page to fetch (1-based). */
  page: number;
};

/**
 * Load the next page(s) for sources that still have more CMS results.
 * Body: { q, sources: [{ key, page }], special?, privateOnly? }
 */
export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const query = typeof body?.q === 'string' ? body.q.trim() : '';
  const specialOnly = body?.special === true || body?.special === '1';
  const privateOnly = body?.privateOnly === true || body?.privateOnly === '1';
  const sourceReqs: SourcePageRequest[] = Array.isArray(body?.sources)
    ? body.sources
        .filter(
          (s: any) =>
            s &&
            typeof s.key === 'string' &&
            s.key &&
            Number.isFinite(Number(s.page)) &&
            Number(s.page) >= 2
        )
        .map((s: any) => ({ key: String(s.key), page: Math.floor(Number(s.page)) }))
    : [];

  if (!query) {
    return NextResponse.json({ error: '搜索关键词不能为空' }, { status: 400 });
  }
  if (sourceReqs.length === 0) {
    return NextResponse.json({
      results: [],
      sources: [],
      hasMore: false,
    });
  }

  const { head, rest } = splitQuery(query);
  const config = await getConfig();
  const sourceTimeoutMs =
    Math.max(1, Number(config.SiteConfig.SearchSourceTimeoutSeconds) || 8) *
    1000;
  // Admin SearchDownstreamMaxPage does NOT cap load-more; only a hard abuse ceiling.
  if (privateOnly) {
    return NextResponse.json({
      results: [],
      sources: sourceReqs.map((s) => ({
        key: s.key,
        page: s.page,
        pageCount: s.page,
        hasMore: false,
      })),
      hasMore: false,
    });
  }

  const apiSites = await getAvailableApiSites(authInfo.username, specialOnly);
  const siteMap = new Map(apiSites.map((s) => [s.key, s]));

  const weightMap = new Map<string, number>();
  config.SourceConfig.forEach((source) => {
    weightMap.set(source.key, source.weight ?? 0);
  });

  const sharedAbort = new AbortController();
  const onRequestAbort = () => sharedAbort.abort();
  request.signal.addEventListener('abort', onRequestAbort);

  try {
    const settled = await Promise.all(
      sourceReqs.map(async (req) => {
        const site = siteMap.get(req.key);
        if (!site) {
          return {
            key: req.key,
            page: req.page,
            pageCount: req.page,
            hasMore: false,
            results: [] as any[],
            error: 'source not found',
          };
        }
        if (req.page > SEARCH_PAGE_HARD_CEILING) {
          return {
            key: req.key,
            page: SEARCH_PAGE_HARD_CEILING,
            pageCount: SEARCH_PAGE_HARD_CEILING,
            hasMore: false,
            results: [] as any[],
          };
        }

        const sourceAbort = new AbortController();
        const timeoutId = setTimeout(() => sourceAbort.abort(), sourceTimeoutMs);
        const onShared = () => sourceAbort.abort();
        sharedAbort.signal.addEventListener('abort', onShared);

        try {
          const outcome = await searchFromApi(site, head, {
            signal: sourceAbort.signal,
            startPage: req.page,
            maxPages: 1,
          });

          let filtered = filterMoviesByRestTokens(
            Array.isArray(outcome.results) ? outcome.results : [],
            rest
          );
          if (!config.SiteConfig.DisableYellowFilter) {
            filtered = filtered.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word: string) => typeName.includes(word));
            });
          }
          filtered = filtered.map((result) => ({
            ...result,
            weight: result.weight ?? (weightMap.get(result.source) ?? 0),
          }));

          return {
            key: req.key,
            page: outcome.page,
            pageCount: outcome.pageCount,
            hasMore: outcome.hasMore,
            results: filtered,
          };
        } catch (error) {
          console.warn(`[Search More] ${site.name} failed:`, error);
          return {
            key: req.key,
            page: req.page,
            pageCount: req.page,
            hasMore: false,
            results: [] as any[],
            error: error instanceof Error ? error.message : '搜索失败',
          };
        } finally {
          clearTimeout(timeoutId);
          sharedAbort.signal.removeEventListener('abort', onShared);
        }
      })
    );

    const allResults = settled.flatMap((s) => s.results);
    // Stable-ish: keep weight order
    allResults.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    return NextResponse.json({
      results: allResults,
      sources: settled.map(({ key, page, pageCount, hasMore, error }) => ({
        key,
        page,
        pageCount,
        hasMore,
        ...(error ? { error } : {}),
      })),
      hasMore: settled.some((s) => s.hasMore),
    });
  } finally {
    request.signal.removeEventListener('abort', onRequestAbort);
  }
}
