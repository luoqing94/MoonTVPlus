import { readFileSync } from 'fs';
import path from 'path';

/**
 * iOS Safari/Chrome auto-zooms focused form controls whose computed
 * font-size is below 16px. Tailwind `text-sm` is 0.875rem (14px);
 * `text-base` is 1rem (16px).
 */
describe('main search input iOS focus zoom', () => {
  const source = readFileSync(
    path.join(__dirname, 'SearchPageClient.tsx'),
    'utf8'
  );

  const searchInputMatch = source.match(
    /id=['"]searchInput['"][\s\S]*?className=['"]([^'"]+)['"]/
  );

  it('declares the #searchInput field', () => {
    expect(searchInputMatch).not.toBeNull();
  });

  it('uses text-base (16px) instead of text-sm (14px)', () => {
    const classNames = (searchInputMatch?.[1] ?? '').split(/\s+/);
    expect(classNames).toContain('text-base');
    expect(classNames).not.toContain('text-sm');
  });
});
