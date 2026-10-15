import { describe, expect, test } from 'vite-plus/test';

import { serverSourceUrl } from './server-source-url';

const currentOrigin = 'https://chroviewer.artemis.shyyluna.dev';

describe('serverSourceUrl', () => {
  test('routes an external HTTPS URL through the same-origin server endpoint', () => {
    const target = 'https://scoresaber.com/api/v2/leaderboards/42/scores?limit=1';
    expect(serverSourceUrl(target, currentOrigin)).toBe(
      `/api/source?${new URLSearchParams({ url: target }).toString()}`,
    );
  });

  test('leaves relative and same-origin URLs unchanged', () => {
    expect(serverSourceUrl('/api/source?url=already-routed', currentOrigin)).toBe('/api/source?url=already-routed');
    expect(serverSourceUrl(`${currentOrigin}/health`, currentOrigin)).toBe(`${currentOrigin}/health`);
  });

  test('leaves HTTP URLs unchanged because the server endpoint only permits HTTPS sources', () => {
    expect(serverSourceUrl('http://localhost:3000/api', currentOrigin)).toBe('http://localhost:3000/api');
  });
});
