import { expect, test } from 'vite-plus/test';

import { postBloomSize } from './math';

test('small compositor tiles never allocate an upscaled bloom pyramid', () => {
  expect(postBloomSize(312, 175, 640)).toEqual({ width: 312, height: 175 });
  expect(postBloomSize(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
  expect(postBloomSize(1, 1, 384)).toEqual({ width: 1, height: 1 });
});
