import {
  filterMoviesByRestTokens,
  splitQuery,
  titleContainsAllTokens,
} from './search-query';

describe('splitQuery', () => {
  it('splits a multi-token query into head and rest', () => {
    expect(splitQuery('奔跑 小孩')).toEqual({
      head: '奔跑',
      rest: ['小孩'],
    });
  });

  it('treats a single-token query as head with empty rest', () => {
    expect(splitQuery('奔跑的小孩')).toEqual({
      head: '奔跑的小孩',
      rest: [],
    });
  });

  it('collapses extra whitespace and keeps later tokens in rest', () => {
    expect(splitQuery('  奔跑   小孩  电影  ')).toEqual({
      head: '奔跑',
      rest: ['小孩', '电影'],
    });
  });

  it('keeps a whitespace-only query unchanged so callers match today', () => {
    expect(splitQuery('   ')).toEqual({
      head: '   ',
      rest: [],
    });
  });
});

describe('titleContainsAllTokens', () => {
  it('is case-insensitive for latin tokens and titles', () => {
    expect(titleContainsAllTokens('Running Kid', ['running', 'KID'])).toBe(
      true
    );
    expect(titleContainsAllTokens('RUNNING KID', ['running'])).toBe(true);
    expect(titleContainsAllTokens('Running Kid', ['run', 'teen'])).toBe(false);
  });

  it('requires every token to appear in the title', () => {
    expect(titleContainsAllTokens('奔跑的小孩', ['奔跑', '小孩'])).toBe(true);
    expect(titleContainsAllTokens('奔跑的少年', ['奔跑', '小孩'])).toBe(false);
  });

  it('returns true when there are no tokens', () => {
    expect(titleContainsAllTokens('anything', [])).toBe(true);
  });

  it('matches exact-search with all tokens instead of the spaced full query', () => {
    const query = '奔跑 小孩';
    const { head, rest } = splitQuery(query);
    const tokens = [head, ...rest];

    expect('奔跑的小孩'.includes(query)).toBe(false);
    expect(titleContainsAllTokens('奔跑的小孩', tokens)).toBe(true);
    expect(titleContainsAllTokens('The Running Kid', ['running', 'KID'])).toBe(
      true
    );
  });
});

describe('filterMoviesByRestTokens', () => {
  const movies = [
    { title: '奔跑的小孩' },
    { title: '奔跑吧兄弟' },
    { title: 'The Running Kid' },
  ];

  it('returns movies unchanged when rest is empty', () => {
    expect(filterMoviesByRestTokens(movies, [])).toEqual(movies);
  });

  it('keeps titles that contain every rest token, case-insensitively', () => {
    expect(filterMoviesByRestTokens(movies, ['小孩'])).toEqual([
      { title: '奔跑的小孩' },
    ]);
    expect(filterMoviesByRestTokens(movies, ['kid'])).toEqual([
      { title: 'The Running Kid' },
    ]);
  });

  it('drops titles missing any rest token', () => {
    expect(filterMoviesByRestTokens(movies, ['小孩', 'movie'])).toEqual([]);
  });
});
