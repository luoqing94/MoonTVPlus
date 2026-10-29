import {
  isProbeCacheSufficientForWholeGroup,
  preferProbeSourceKey,
  readProbeCache,
  writeProbeResults,
} from './prefer-probe-cache';

describe('prefer-probe-cache', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('writes and reads probe entries by normalized title key', () => {
    writeProbeResults('狂 飙', [
      {
        source: 'a',
        id: '1',
        year: '2023',
        quality: '1080p',
        loadSpeed: '1.2 MB/s',
        pingTime: 40,
        probedAt: Date.now(),
      },
    ]);
    const cache = readProbeCache('狂飙');
    expect(cache).not.toBeNull();
    expect(cache!.entries[preferProbeSourceKey('a', '1')].quality).toBe(
      '1080p'
    );
  });

  it('marks cache sufficient when two years are covered', () => {
    writeProbeResults('庆余年', [
      {
        source: 'a',
        id: '1',
        year: '2019',
        quality: '720p',
        loadSpeed: '未知',
        pingTime: 0,
        probedAt: 1,
      },
      {
        source: 'b',
        id: '2',
        year: '2024',
        quality: '1080p',
        loadSpeed: '未知',
        pingTime: 0,
        probedAt: 2,
      },
    ]);
    expect(
      isProbeCacheSufficientForWholeGroup(readProbeCache('庆余年'), '2019')
    ).toBe(true);
  });

  it('is insufficient with a single entry', () => {
    writeProbeResults('孤片', [
      {
        source: 'a',
        id: '1',
        year: '2020',
        quality: '720p',
        loadSpeed: '未知',
        pingTime: 0,
        probedAt: 1,
      },
    ]);
    expect(
      isProbeCacheSufficientForWholeGroup(readProbeCache('孤片'), '2020')
    ).toBe(false);
  });
});
