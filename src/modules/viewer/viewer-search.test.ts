import { expect, test } from 'vite-plus/test';

import * as z from 'zod/mini';

import { hasConfiguredShowcase, hasExternallyConfiguredSettings, viewerSearchSchema } from './viewer-search';

test('standalone showcase map previews do not claim configured showcase loading', () => {
  expect(hasConfiguredShowcase({ showcase: true, showcaseConfig: undefined })).toBe(false);
});

test('configured showcases retain ownership of map loading', () => {
  expect(hasConfiguredShowcase({ showcase: true, showcaseConfig: '{"maps":[]}' })).toBe(true);
  expect(hasConfiguredShowcase({ showcase: false, showcaseConfig: '{"maps":[]}' })).toBe(false);
});

test('recognizes query-driven viewer settings as external configuration', () => {
  expect(hasExternallyConfiguredSettings(z.parse(viewerSearchSchema, {}))).toBe(false);
  expect(hasExternallyConfiguredSettings(z.parse(viewerSearchSchema, { renderScale: 0.75 }))).toBe(true);
  expect(
    hasExternallyConfiguredSettings(z.parse(viewerSearchSchema, { settings: { replayCameraFov: 90 } })),
  ).toBe(true);
});
