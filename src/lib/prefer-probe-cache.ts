import { titleFoldStorageKey } from '@/lib/title-fold';


function getSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch {
    /* private mode */
  }
  return null;
}

export const PREFER_PROBE_SESSION_PREFIX = 'prefer_probe_v1:';

export type PreferProbeEntry = {
  year?: string;
  source: string;
  id: string;
  source_name?: string;
  quality: string;
  loadSpeed: string;
  pingTime: number;
  bitrate?: string;
  scoreHint?: number;
  probedAt: number;
};

export type PreferProbeCache = {
  v: 1;
  titleKey: string;
  updatedAt: number;
  entries: Record<string, PreferProbeEntry>;
};

export function preferProbeSourceKey(source: string, id: string): string {
  return `${source}::${id}`;
}

export function readProbeCache(titleOrKey: string): PreferProbeCache | null {
  const titleKey = titleFoldStorageKey(titleOrKey);
  const store = getSessionStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(
      `${PREFER_PROBE_SESSION_PREFIX}${titleKey}`
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreferProbeCache;
    if (!parsed || parsed.v !== 1 || !parsed.entries) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRaw(cache: PreferProbeCache): boolean {
  const store = getSessionStorage();
  if (!store) return false;
  try {
    store.setItem(
      `${PREFER_PROBE_SESSION_PREFIX}${cache.titleKey}`,
      JSON.stringify(cache)
    );
    return true;
  } catch {
    // QuotaExceeded：尝试丢掉最旧的一半条目后再写
    try {
      const entries = Object.entries(cache.entries);
      if (entries.length <= 2) return false;
      entries.sort((a, b) => (a[1].probedAt || 0) - (b[1].probedAt || 0));
      const keep = entries.slice(Math.floor(entries.length / 2));
      const pruned: PreferProbeCache = {
        ...cache,
        entries: Object.fromEntries(keep),
        updatedAt: Date.now(),
      };
      store.setItem(
        `${PREFER_PROBE_SESSION_PREFIX}${pruned.titleKey}`,
        JSON.stringify(pruned)
      );
      return true;
    } catch {
      return false;
    }
  }
}

export function writeProbeResults(
  titleOrKey: string,
  results: PreferProbeEntry[]
): PreferProbeCache | null {
  if (!results.length) return readProbeCache(titleOrKey);
  const titleKey = titleFoldStorageKey(titleOrKey);
  const existing = readProbeCache(titleKey) || {
    v: 1 as const,
    titleKey,
    updatedAt: Date.now(),
    entries: {},
  };
  const next: PreferProbeCache = {
    ...existing,
    titleKey,
    updatedAt: Date.now(),
    entries: { ...existing.entries },
  };
  results.forEach((item) => {
    const key = preferProbeSourceKey(item.source, item.id);
    next.entries[key] = { ...item, probedAt: item.probedAt || Date.now() };
  });
  writeRaw(next);
  return next;
}

export function mergeProbeResult(
  titleOrKey: string,
  entry: PreferProbeEntry
): PreferProbeCache | null {
  return writeProbeResults(titleOrKey, [entry]);
}

/** 缓存是否足够用来尝试整组优选：至少覆盖 2 个不同年份，或条目数 ≥ 3 */
export function isProbeCacheSufficientForWholeGroup(
  cache: PreferProbeCache | null,
  currentYear?: string
): boolean {
  if (!cache) return false;
  const entries = Object.values(cache.entries);
  if (entries.length === 0) return false;
  const years = new Set(
    entries
      .map((e) => e.year || 'unknown')
      .filter((y) => y && y !== 'unknown')
  );
  if (years.size >= 2) return true;
  if (entries.length >= 3) return true;
  if (
    currentYear &&
    entries.some(
      (e) => e.year && e.year !== 'unknown' && e.year !== currentYear
    )
  ) {
    return true;
  }
  return false;
}

export const ENABLE_BACKGROUND_PROBE_KEY = 'enableBackgroundProbe';
export const TITLE_FOLD_ENABLED_KEY = 'titleFoldEnabled';

export function readBoolLocalSetting(
  key: string,
  defaultValue: boolean
): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw);
    } catch {
      return raw === 'true';
    }
  } catch {
    return defaultValue;
  }
}

export function isBackgroundProbeEnabled(): boolean {
  return readBoolLocalSetting(ENABLE_BACKGROUND_PROBE_KEY, true);
}

export function isTitleFoldEnabled(): boolean {
  return readBoolLocalSetting(TITLE_FOLD_ENABLED_KEY, true);
}
