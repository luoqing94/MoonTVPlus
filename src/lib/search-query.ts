export type SplitQuery = {
  head: string;
  rest: string[];
};

/**
 * Split a search query on whitespace.
 * The first token is sent to CMS search; later tokens filter titles locally.
 */
export function splitQuery(query: string): SplitQuery {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { head: query, rest: [] };
  }
  return { head: tokens[0], rest: tokens.slice(1) };
}

export function titleContainsAllTokens(
  title: string,
  tokens: string[]
): boolean {
  if (tokens.length === 0) return true;
  const normalizedTitle = title.toLowerCase();
  return tokens.every((token) => normalizedTitle.includes(token.toLowerCase()));
}

export function filterMoviesByRestTokens<T extends { title?: string }>(
  movies: T[],
  rest: string[]
): T[] {
  if (rest.length === 0) return movies;
  return movies.filter((movie) =>
    titleContainsAllTokens(movie.title ?? '', rest)
  );
}
