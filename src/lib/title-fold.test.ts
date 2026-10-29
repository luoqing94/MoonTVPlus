import {
  buildTitleFoldGroups,
  normalizeTitle,
  pickRepresentativeBucket,
  sortYearRows,
  type FoldYearRow,
} from './title-fold';
import { SearchResult } from './types';

function makeItem(
  partial: Partial<SearchResult> & Pick<SearchResult, 'title' | 'source' | 'id'>
): SearchResult {
  return {
    poster: '',
    episodes: ['u1'],
    episodes_titles: [''],
    source_name: partial.source_name || partial.source,
    year: partial.year || 'unknown',
    ...partial,
  } as SearchResult;
}

describe('title-fold', () => {
  it('normalizes titles by stripping spaces and punctuation', () => {
    expect(normalizeTitle('狂 飙（第一季）')).toBe('狂飙第一季');
    expect(normalizeTitle(' 庆余年 ')).toBe('庆余年');
  });

  it('picks representative by source count then newer year', () => {
    const rows: FoldYearRow[] = [
      {
        year: '2023',
        mapKey: 'a-movie-2023',
        group: [],
        sourceNames: ['a', 'b'],
        sourceCount: 2,
        episodes: 1,
        poster: '',
        title: 't',
        type: 'movie',
        desc: '',
        vodRemarks: '',
        isAnime: false,
      },
      {
        year: '2025',
        mapKey: 'a-movie-2025',
        group: [],
        sourceNames: ['a', 'b', 'c'],
        sourceCount: 3,
        episodes: 1,
        poster: '',
        title: 't',
        type: 'movie',
        desc: '',
        vodRemarks: '',
        isAnime: false,
      },
      {
        year: '2024',
        mapKey: 'a-movie-2024',
        group: [],
        sourceNames: ['a', 'b', 'c'],
        sourceCount: 3,
        episodes: 1,
        poster: '',
        title: 't',
        type: 'movie',
        desc: '',
        vodRemarks: '',
        isAnime: false,
      },
    ];
    expect(pickRepresentativeBucket(rows).year).toBe('2025');
  });

  it('sorts year rows newer to older with unknown last', () => {
    const sorted = sortYearRows([
      {
        year: 'unknown',
        mapKey: 'x',
        group: [],
        sourceNames: [],
        sourceCount: 0,
        episodes: 1,
        poster: '',
        title: 't',
        type: 'movie',
        desc: '',
        vodRemarks: '',
        isAnime: false,
      },
      {
        year: '2020',
        mapKey: 'y',
        group: [],
        sourceNames: [],
        sourceCount: 0,
        episodes: 1,
        poster: '',
        title: 't',
        type: 'movie',
        desc: '',
        vodRemarks: '',
        isAnime: false,
      },
      {
        year: '2024',
        mapKey: 'z',
        group: [],
        sourceNames: [],
        sourceCount: 0,
        episodes: 1,
        poster: '',
        title: 't',
        type: 'movie',
        desc: '',
        vodRemarks: '',
        isAnime: false,
      },
    ]);
    expect(sorted.map((r) => r.year)).toEqual(['2024', '2020', 'unknown']);
  });

  it('folds same normalized title across type/year into one group', () => {
    const a = makeItem({
      title: '狂飙',
      source: 's1',
      id: '1',
      source_name: '桃花',
      year: '2023',
      type_name: '电影',
    });
    const b = makeItem({
      title: '狂飙',
      source: 's2',
      id: '2',
      source_name: '精品',
      year: '2023',
      type_name: '电视剧',
      episodes: ['u1', 'u2'],
      episodes_titles: ['1', '2'],
    });
    const c = makeItem({
      title: '狂飙',
      source: 's3',
      id: '3',
      source_name: '精品98',
      year: '2025',
      type_name: '电影',
    });
    const groups = buildTitleFoldGroups([
      ['狂飙-movie-2023', [a]],
      ['狂飙-tv-2023', [b]],
      ['狂飙-movie-2025', [c]],
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].yearRows).toHaveLength(2);
    // 2023 merged movie+tv → 2 sources; 2025 → 1 → representative is 2023
    expect(groups[0].representative.year).toBe('2023');
    expect(groups[0].representative.sourceCount).toBe(2);
    expect(groups[0].allSourceNames.sort()).toEqual(
      ['精品', '精品98', '桃花'].sort()
    );
    expect(groups[0].yearRows.map((r) => r.year)).toEqual(['2025', '2023']);
  });
});
