/* eslint-disable @typescript-eslint/no-explicit-any */

import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { getCachedSearchPage, setCachedSearchPage } from '@/lib/search-cache';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
  vod_total?: number;
}

export type SearchFromApiOptions = {
  /** Cancels in-flight fetch + body parse when aborted (timeout or client disconnect). */
  signal?: AbortSignal;
  /** First CMS page to fetch (1-based). Default 1. */
  startPage?: number;
  /** How many pages to fetch in this call. Default = SiteConfig.SearchDownstreamMaxPage. */
  maxPages?: number;
};

export type SearchFromApiOutcome = {
  results: SearchResult[];
  /** Highest page number fetched in this call. */
  page: number;
  /** Total pages reported by the CMS (best effort). */
  pageCount: number;
  /** True when more pages remain under the admin absolute cap. */
  hasMore: boolean;
};

function isAbortError(error: any): boolean {
  return (
    error?.name === 'AbortError' ||
    error?.code === 20 ||
    (typeof error?.message === 'string' &&
      (error.message.includes('aborted') || error.message.includes('Abort')))
  );
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function linkAbortSignals(
  external: AbortSignal | undefined,
  local: AbortController
): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    local.abort();
    return () => undefined;
  }
  const onAbort = () => local.abort();
  external.addEventListener('abort', onAbort);
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * Abort-aware JSON parse: response.json() is not always cancelled by fetch's
 * AbortSignal after headers arrive, so race against the same controller.
 */
async function readJsonWithSignal(
  response: Response,
  signal: AbortSignal
): Promise<any> {
  if (signal.aborted) {
    throw abortError();
  }
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    response
      .json()
      .then((data) => {
        signal.removeEventListener('abort', onAbort);
        resolve(data);
      })
      .catch((err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

/**
 * 通用的带缓存搜索函数
 */
async function searchWithCache(
  apiSite: ApiSite,
  query: string,
  page: number,
  url: string,
  timeoutMs = 8000,
  externalSignal?: AbortSignal
): Promise<{ results: SearchResult[]; pageCount?: number }> {
  // 先查缓存
  const cached = getCachedSearchPage(apiSite.key, query, page);
  if (cached) {
    if (cached.status === 'ok') {
      return { results: cached.data, pageCount: cached.pageCount };
    } else {
      return { results: [] };
    }
  }

  if (externalSignal?.aborted) {
    return { results: [] };
  }

  // 缓存未命中，发起网络请求。超时与外部 abort 共用同一个 AbortController，
  // 覆盖 fetch + response.json()，避免只清 headers 后 json 挂死。
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const unlink = linkAbortSignals(externalSignal, controller);

  try {
    const response = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 403) {
        setCachedSearchPage(apiSite.key, query, page, 'forbidden', []);
      }
      return { results: [] };
    }

    const data = await readJsonWithSignal(response, controller.signal);
    if (
      !data ||
      !data.list ||
      !Array.isArray(data.list) ||
      data.list.length === 0
    ) {
      // 空结果不做负缓存要求，这里不写入缓存
      return { results: [] };
    }

    // 处理结果数据
    const allResults = data.list.map((item: ApiSearchItem) => {
      let episodes: string[] = [];
      let titles: string[] = [];

      // 使用正则表达式从 vod_play_url 提取 m3u8 链接
      if (item.vod_play_url) {
        // 先用 $$$ 分割
        const vod_play_url_array = item.vod_play_url.split('$$$');
        // 分集之间#分割，标题和播放链接 $ 分割
        vod_play_url_array.forEach((url: string) => {
          const matchEpisodes: string[] = [];
          const matchTitles: string[] = [];
          const title_url_array = url.split('#');
          title_url_array.forEach((title_url: string) => {
            const episode_title_url = title_url.split('$');
            if (
              episode_title_url.length === 2 &&
              episode_title_url[1].endsWith('.m3u8')
            ) {
              matchTitles.push(episode_title_url[0]);
              matchEpisodes.push(episode_title_url[1]);
            }
          });
          if (matchEpisodes.length > episodes.length) {
            episodes = matchEpisodes;
            titles = matchTitles;
          }
        });
      }

      return {
        id: item.vod_id.toString(),
        title: item.vod_name.trim().replace(/\s+/g, ' '),
        poster: item.vod_pic,
        episodes,
        episodes_titles: titles,
        source: apiSite.key,
        source_name: apiSite.name,
        class: item.vod_class,
        year: item.vod_year
          ? item.vod_year.match(/\d{4}/)?.[0] || ''
          : 'unknown',
        desc: cleanHtmlTags(item.vod_content || ''),
        type_name: item.type_name,
        douban_id: item.vod_douban_id,
        vod_remarks: item.vod_remarks,
        vod_total: item.vod_total,
        proxyMode: apiSite.proxyMode || false,
      };
    });

    // 过滤掉集数为 0 的结果
    const results = allResults.filter(
      (result: SearchResult) => result.episodes.length > 0
    );

    const pageCount =
      typeof data.pagecount === 'number' && data.pagecount > 0
        ? data.pagecount
        : undefined;
    // 写入缓存（成功）
    setCachedSearchPage(apiSite.key, query, page, 'ok', results, pageCount);
    return { results, pageCount };
  } catch (error: any) {
    // 识别被 AbortController 中止（超时 / 客户端断开）
    if (isAbortError(error)) {
      setCachedSearchPage(apiSite.key, query, page, 'timeout', []);
    }
    return { results: [] };
  } finally {
    clearTimeout(timeoutId);
    unlink();
  }
}

function buildSearchPageUrl(
  apiBaseUrl: string,
  query: string,
  page: number
): string {
  if (page <= 1) {
    return apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
  }
  return (
    apiBaseUrl +
    API_CONFIG.search.pagePath
      .replace('{query}', encodeURIComponent(query))
      .replace('{page}', page.toString())
  );
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  opts: SearchFromApiOptions = {}
): Promise<SearchFromApiOutcome> {
  const empty: SearchFromApiOutcome = {
    results: [],
    page: opts.startPage ?? 1,
    pageCount: 1,
    hasMore: false,
  };

  try {
    if (opts.signal?.aborted) {
      return empty;
    }

    const config = await getConfig();
    const absoluteMax = Math.max(
      1,
      Number(config.SiteConfig.SearchDownstreamMaxPage) || 1
    );
    const sourceTimeoutMs =
      Math.max(1, Number(config.SiteConfig.SearchSourceTimeoutSeconds) || 8) *
      1000;

    const startPage = Math.max(1, opts.startPage ?? 1);
    const pagesInCall = Math.max(1, opts.maxPages ?? absoluteMax);
    const endPage = Math.min(startPage + pagesInCall - 1, absoluteMax);

    if (startPage > absoluteMax) {
      return { ...empty, page: absoluteMax, pageCount: absoluteMax };
    }

    const apiBaseUrl = apiSite.api;
    const allResults: SearchResult[] = [];
    let pageCount = 1;
    let lastFetchedPage = startPage - 1;

    // Prefer cached pagecount from page 1 when loading later pages.
    if (startPage > 1) {
      const cachedFirst = getCachedSearchPage(apiSite.key, query, 1);
      if (cachedFirst?.pageCount && cachedFirst.pageCount > 0) {
        pageCount = cachedFirst.pageCount;
      }
    }

    for (let page = startPage; page <= endPage; page++) {
      if (opts.signal?.aborted) {
        break;
      }
      // Stop early when we already know there are no further CMS pages.
      if (page > pageCount && page > startPage) {
        break;
      }

      const pageUrl = buildSearchPageUrl(apiBaseUrl, query, page);
      const pageResult = await searchWithCache(
        apiSite,
        query,
        page,
        pageUrl,
        sourceTimeoutMs,
        opts.signal
      );

      if (pageResult.pageCount && pageResult.pageCount > 0) {
        pageCount = pageResult.pageCount;
      }

      lastFetchedPage = page;
      if (pageResult.results.length > 0) {
        allResults.push(...pageResult.results);
      }

      // Empty first page of a multi-page call: still advance lastFetchedPage
      // so hasMore can be computed; stop chasing further empty pages.
      if (pageResult.results.length === 0 && page === startPage) {
        // keep going only if we explicitly wanted multiple pages and know more exist
        if (page >= pageCount) break;
      }
    }

    if (lastFetchedPage < startPage) {
      lastFetchedPage = startPage;
    }

    const hasMore = lastFetchedPage < pageCount && lastFetchedPage < absoluteMax;

    return {
      results: allResults,
      page: lastFetchedPage,
      pageCount: Math.max(pageCount, lastFetchedPage),
      hasMore,
    };
  } catch (error) {
    return empty;
  }
}

// 匹配 m3u8 链接的正则
const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8)/g;

export async function getDetailFromApi(
  apiSite: ApiSite,
  id: string
): Promise<SearchResult> {
  if (apiSite.detail) {
    return handleSpecialSourceDetail(id, apiSite);
  }

  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情请求失败: ${response.status}`);
  }

  const data = await response.json();

  if (
    !data ||
    !data.list ||
    !Array.isArray(data.list) ||
    data.list.length === 0
  ) {
    throw new Error('获取到的详情内容无效');
  }

  const videoDetail = data.list[0];
  let episodes: string[] = [];
  let titles: string[] = [];

  // 处理播放源拆分
  if (videoDetail.vod_play_url) {
    // 先用 $$$ 分割
    const vod_play_url_array = videoDetail.vod_play_url.split('$$$');
    // 分集之间#分割，标题和播放链接 $ 分割
    vod_play_url_array.forEach((url: string) => {
      const matchEpisodes: string[] = [];
      const matchTitles: string[] = [];
      const title_url_array = url.split('#');
      title_url_array.forEach((title_url: string) => {
        const episode_title_url = title_url.split('$');
        if (
          episode_title_url.length === 2 &&
          episode_title_url[1].endsWith('.m3u8')
        ) {
          matchTitles.push(episode_title_url[0]);
          matchEpisodes.push(episode_title_url[1]);
        }
      });
      if (matchEpisodes.length > episodes.length) {
        episodes = matchEpisodes;
        titles = matchTitles;
      }
    });
  }

  // 如果播放源为空，则尝试从内容中解析 m3u8
  if (episodes.length === 0 && videoDetail.vod_content) {
    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  return {
    id: id.toString(),
    title: videoDetail.vod_name,
    poster: videoDetail.vod_pic,
    episodes,
    episodes_titles: titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: videoDetail.vod_year
      ? videoDetail.vod_year.match(/\d{4}/)?.[0] || ''
      : 'unknown',
    desc: cleanHtmlTags(videoDetail.vod_content),
    type_name: videoDetail.type_name,
    douban_id: videoDetail.vod_douban_id,
    vod_remarks: videoDetail.vod_remarks,
    vod_total: videoDetail.vod_total,
    proxyMode: apiSite.proxyMode || false,
  };
}

export async function getDetailFromApiV2(
  apiSite: ApiSite,
  id: string
): Promise<SearchResult> {
  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情请求失败: ${response.status}`);
  }

  const data = await response.json();

  if (
    !data ||
    !data.list ||
    !Array.isArray(data.list) ||
    data.list.length === 0
  ) {
    throw new Error('获取到的详情内容无效');
  }

  const videoDetail = data.list[0];
  let episodes: string[] = [];
  let titles: string[] = [];

  if (videoDetail.vod_play_url) {
    const vodPlayUrlArray = videoDetail.vod_play_url.split('$$$');
    vodPlayUrlArray.forEach((url: string) => {
      const matchEpisodes: string[] = [];
      const matchTitles: string[] = [];
      const titleUrlArray = url.split('#');
      titleUrlArray.forEach((titleUrl: string) => {
        const episodeTitleUrl = titleUrl.split('$');
        if (
          episodeTitleUrl.length === 2 &&
          episodeTitleUrl[1].endsWith('.m3u8')
        ) {
          matchTitles.push(episodeTitleUrl[0]);
          matchEpisodes.push(episodeTitleUrl[1]);
        }
      });
      if (matchEpisodes.length > episodes.length) {
        episodes = matchEpisodes;
        titles = matchTitles;
      }
    });
  }

  if (episodes.length === 0 && videoDetail.vod_content) {
    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  return {
    id: id.toString(),
    title: videoDetail.vod_name,
    poster: videoDetail.vod_pic,
    episodes,
    episodes_titles: titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: videoDetail.vod_year
      ? videoDetail.vod_year.match(/\d{4}/)?.[0] || ''
      : 'unknown',
    desc: cleanHtmlTags(videoDetail.vod_content),
    type_name: videoDetail.type_name,
    douban_id: videoDetail.vod_douban_id,
    vod_remarks: videoDetail.vod_remarks,
    vod_total: videoDetail.vod_total,
    proxyMode: apiSite.proxyMode || false,
  };
}

async function handleSpecialSourceDetail(
  id: string,
  apiSite: ApiSite
): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情页请求失败: ${response.status}`);
  }

  const html = await response.text();
  let matches: string[] = [];

  if (apiSite.key === 'ffzy') {
    const ffzyPattern =
      /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
    matches = html.match(ffzyPattern) || [];
  }

  if (matches.length === 0) {
    const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
    matches = html.match(generalPattern) || [];
  }

  // 去重并清理链接前缀
  matches = Array.from(new Set(matches)).map((link: string) => {
    link = link.substring(1); // 去掉开头的 $
    const parenIndex = link.indexOf('(');
    return parenIndex > 0 ? link.substring(0, parenIndex) : link;
  });

  // 根据 matches 数量生成剧集标题
  const episodes_titles = Array.from({ length: matches.length }, (_, i) =>
    (i + 1).toString()
  );

  // 提取标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const titleText = titleMatch ? titleMatch[1].trim() : '';

  // 提取描述
  const descMatch = html.match(
    /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/
  );
  const descText = descMatch ? cleanHtmlTags(descMatch[1]) : '';

  // 提取封面
  const coverMatch = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/g);
  const coverUrl = coverMatch ? coverMatch[0].trim() : '';

  // 提取年份
  const yearMatch = html.match(/>(\d{4})</);
  const yearText = yearMatch ? yearMatch[1] : 'unknown';

  return {
    id,
    title: titleText,
    poster: coverUrl,
    episodes: matches,
    episodes_titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year: yearText,
    desc: descText,
    type_name: '',
    douban_id: 0,
    vod_remarks: undefined,
    vod_total: undefined,
    proxyMode: apiSite.proxyMode || false,
  };
}
