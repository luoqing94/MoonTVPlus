/* eslint-disable @typescript-eslint/no-explicit-any */

import { SearchResult } from '@/lib/types';

export type AggEntry = [string, SearchResult[]];

export type FoldYearRow = {
  year: string;
  mapKey: string;
  group: SearchResult[];
  sourceNames: string[];
  sourceCount: number;
  episodes: number;
  poster: string;
  title: string;
  type: 'movie' | 'tv';
  doubanId?: number;
  desc: string;
  vodRemarks: string;
  isAnime: boolean;
  typeName?: string;
};

export type TitleFoldGroup = {
  foldKey: string;
  normalizedTitle: string;
  representative: FoldYearRow;
  yearRows: FoldYearRow[];
  /** 整组源名并集（仅展示） */
  allSourceNames: string[];
};

/** 与搜索页 / 播放页一致的标题规范化 */
export function normalizeTitle(title: string): string {
  return (title || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[()（）[\]【】{}「」『』<>《》]/g, '')
    .replace(/[^\w\u4e00-\u9fa5]/g, '');
}

export function titleFoldStorageKey(title: string): string {
  return normalizeTitle(title).toLowerCase();
}

function parseYearNum(year: string): number | null {
  if (!year || year === 'unknown') return null;
  if (!/^\d{4}$/.test(year)) return null;
  const n = Number.parseInt(year, 10);
  return Number.isNaN(n) ? null : n;
}

function countEpisodes(group: SearchResult[]): number {
  const countMap = new Map<number, number>();
  group.forEach((g) => {
    const len = g.episodes?.length || 0;
    if (len > 0) countMap.set(len, (countMap.get(len) || 0) + 1);
  });
  let max = 0;
  let res = 0;
  countMap.forEach((v, k) => {
    if (v > max) {
      max = v;
      res = k;
    }
  });
  return res;
}

function uniqueSourceNames(group: SearchResult[]): string[] {
  return Array.from(
    new Set(group.map((g) => g.source_name).filter(Boolean))
  ) as string[];
}

function pickDoubanId(group: SearchResult[]): number | undefined {
  const countMap = new Map<number, number>();
  group.forEach((g) => {
    if (g.douban_id && g.douban_id > 0) {
      countMap.set(g.douban_id, (countMap.get(g.douban_id) || 0) + 1);
    }
  });
  let max = 0;
  let res: number | undefined;
  countMap.forEach((v, k) => {
    if (v > max) {
      max = v;
      res = k;
    }
  });
  return res;
}

function typeFromMapKey(
  mapKey: string,
  episodes: number
): 'movie' | 'tv' {
  const lastDashIndex = mapKey.lastIndexOf('-');
  const secondLastDashIndex = mapKey.lastIndexOf('-', lastDashIndex - 1);
  if (secondLastDashIndex > 0) {
    const t = mapKey.substring(secondLastDashIndex + 1, lastDashIndex);
    if (t === 'movie' || t === 'tv') return t;
  }
  return episodes === 1 ? 'movie' : 'tv';
}

function yearFromMapKey(mapKey: string, fallback: string): string {
  const lastDashIndex = mapKey.lastIndexOf('-');
  if (lastDashIndex > 0) {
    const y = mapKey.substring(lastDashIndex + 1);
    if (y) return y;
  }
  return fallback || 'unknown';
}

function toYearRow(mapKey: string, group: SearchResult[]): FoldYearRow {
  const episodes = countEpisodes(group);
  const sourceNames = uniqueSourceNames(group);
  const year = yearFromMapKey(mapKey, group[0]?.year || 'unknown');
  return {
    year,
    mapKey,
    group,
    sourceNames,
    sourceCount: sourceNames.length,
    episodes,
    poster: group[0]?.poster || '',
    title: group[0]?.title || '',
    type: typeFromMapKey(mapKey, episodes),
    doubanId: pickDoubanId(group),
    desc: group.find((e) => e.desc?.trim())?.desc || '',
    vodRemarks:
      group.find((e) => e.vod_remarks?.trim())?.vod_remarks || '',
    isAnime: false,
    typeName:
      group.find((g) => g.type_name || g.class)?.type_name ||
      group.find((g) => g.class)?.class,
  };
}

/** 来源数最多的年份档；并列取年份更新；再并列保持出现顺序 */
export function pickRepresentativeBucket(
  rows: FoldYearRow[]
): FoldYearRow {
  if (rows.length === 0) {
    throw new Error('pickRepresentativeBucket: empty rows');
  }
  let best = rows[0];
  for (let i = 1; i < rows.length; i += 1) {
    const cur = rows[i];
    if (cur.sourceCount > best.sourceCount) {
      best = cur;
      continue;
    }
    if (cur.sourceCount < best.sourceCount) continue;
    const curY = parseYearNum(cur.year);
    const bestY = parseYearNum(best.year);
    if (curY !== null && bestY === null) {
      best = cur;
      continue;
    }
    if (curY === null || bestY === null) continue;
    if (curY > bestY) best = cur;
  }
  return best;
}

/** 年份新→旧，unknown 垫底 */
export function sortYearRows(rows: FoldYearRow[]): FoldYearRow[] {
  return [...rows].sort((a, b) => {
    const aY = parseYearNum(a.year);
    const bY = parseYearNum(b.year);
    if (aY === null && bY === null) return 0;
    if (aY === null) return 1;
    if (bY === null) return -1;
    return bY - aY;
  });
}

/**
 * 将现有「标题+类型+年份」聚合条目按规范化标题折叠。
 * 跨 movie/tv 类型合并到同一主卡。
 */
export function buildTitleFoldGroups(aggEntries: AggEntry[]): TitleFoldGroup[] {
  const byTitle = new Map<string, FoldYearRow[]>();
  const titleOrder: string[] = [];

  aggEntries.forEach(([mapKey, group]) => {
    const title = group[0]?.title || '';
    const normalized = normalizeTitle(title);
    const foldKey = normalized.toLowerCase() || mapKey;
    const row = toYearRow(mapKey, group);
    const existing = byTitle.get(foldKey);
    if (!existing) {
      byTitle.set(foldKey, [row]);
      titleOrder.push(foldKey);
    } else {
      // 同年份（含 unknown）合并组，避免 movie/tv 拆成两行同年
      const sameYear = existing.find((r) => r.year === row.year);
      if (sameYear) {
        const prevLen = sameYear.group.length;
        const addLen = row.group.length;
        sameYear.group = [...sameYear.group, ...row.group];
        sameYear.sourceNames = uniqueSourceNames(sameYear.group);
        sameYear.sourceCount = sameYear.sourceNames.length;
        sameYear.episodes = countEpisodes(sameYear.group);
        if (!sameYear.poster && row.poster) sameYear.poster = row.poster;
        if (!sameYear.doubanId && row.doubanId) sameYear.doubanId = row.doubanId;
        if (!sameYear.desc && row.desc) sameYear.desc = row.desc;
        if (!sameYear.vodRemarks && row.vodRemarks) {
          sameYear.vodRemarks = row.vodRemarks;
        }
        // 类型：后并入的条目更多时覆盖
        if (addLen > prevLen) {
          sameYear.type = row.type;
        }
      } else {
        existing.push(row);
      }
    }
  });

  return titleOrder.map((foldKey) => {
    const rows = byTitle.get(foldKey)!;
    const yearRows = sortYearRows(rows);
    const representative = pickRepresentativeBucket(yearRows);
    const allSourceNames = Array.from(
      new Set(yearRows.flatMap((r) => r.sourceNames))
    );
    return {
      foldKey,
      normalizedTitle: foldKey,
      representative,
      yearRows,
      allSourceNames,
    };
  });
}

export type TitleFoldContextSource = {
  source: string;
  id: string;
  source_name?: string;
};

export type TitleFoldContextYear = {
  year: string;
  sources: TitleFoldContextSource[];
};

export type TitleFoldContext = {
  v: 1;
  titleKey: string;
  title: string;
  representativeYear: string;
  years: TitleFoldContextYear[];
};

export const TITLE_FOLD_SESSION_PREFIX = 'title_fold_v1:';

export function buildTitleFoldContext(
  group: TitleFoldGroup,
  displayTitle?: string
): TitleFoldContext {
  return {
    v: 1,
    titleKey: group.foldKey,
    title: displayTitle || group.representative.title,
    representativeYear: group.representative.year,
    years: group.yearRows.map((row) => ({
      year: row.year,
      sources: row.group.map((item) => ({
        source: item.source,
        id: item.id,
        source_name: item.source_name,
      })),
    })),
  };
}


function getSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch {
    /* private mode */
  }
  return null;
}

export function writeTitleFoldContext(ctx: TitleFoldContext): void {
  const store = getSessionStorage();
  if (!store) return;
  try {
    store.setItem(
      `${TITLE_FOLD_SESSION_PREFIX}${ctx.titleKey}`,
      JSON.stringify(ctx)
    );
  } catch {
    /* quota / private mode */
  }
}

export function readTitleFoldContext(
  titleOrKey: string
): TitleFoldContext | null {
  const store = getSessionStorage();
  if (!store) return null;
  const key = titleFoldStorageKey(titleOrKey);
  try {
    const raw = store.getItem(`${TITLE_FOLD_SESSION_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TitleFoldContext;
    if (!parsed || parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}
