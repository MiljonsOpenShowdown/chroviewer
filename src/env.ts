import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

import { enabledViewerSourcesSchema } from './sources/source-options';

const localHostnames = new Set(['localhost', '0.0.0.0', '127.0.0.1', '[::1]']);

const publicApiUrl = z
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return url.protocol === 'https:' || (url.protocol === 'http:' && localHostnames.has(url.hostname));
    },
    { message: 'must be https, or localhost http' },
  )
  .transform((value) => value.replace(/\/$/, ''));
const publicWebSocketUrl = z
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return url.protocol === 'wss:' || (url.protocol === 'ws:' && localHostnames.has(url.hostname));
    },
    { message: 'must be wss, or localhost ws' },
  )
  .transform((value) => value.replace(/\/$/, ''));
export const env = createEnv({
  isServer: false,
  clientPrefix: 'VITE_',
  client: {
    VITE_BEATSAVER_API_URL: publicApiUrl.default('https://api.beatsaver.com'),
    VITE_SCORESABER_API_URL: publicApiUrl.default('https://scoresaber.com'),
    VITE_BEATLEADER_API_URL: publicApiUrl.default('https://api.beatleader.com'),
    VITE_LUDUS_URL: publicApiUrl.default('https://ludus-1.scoresaber.com'),
    VITE_TA_LIVE_SOCKET_URL: publicWebSocketUrl.default('wss://server.tournamentassistant.net:8676'),
    VITE_COCU_LIVE_SOCKET_URL: publicWebSocketUrl.default('wss://ws.compcube.net'),
    VITE_ENABLED_SOURCES: enabledViewerSourcesSchema,
  },
  runtimeEnvStrict: {
    VITE_BEATSAVER_API_URL: import.meta.env.VITE_BEATSAVER_API_URL,
    VITE_SCORESABER_API_URL: import.meta.env.VITE_SCORESABER_API_URL,
    VITE_BEATLEADER_API_URL: import.meta.env.VITE_BEATLEADER_API_URL,
    VITE_LUDUS_URL: import.meta.env.VITE_LUDUS_URL,
    VITE_TA_LIVE_SOCKET_URL: import.meta.env.VITE_TA_LIVE_SOCKET_URL,
    VITE_COCU_LIVE_SOCKET_URL: import.meta.env.VITE_COCU_LIVE_SOCKET_URL,
    VITE_ENABLED_SOURCES: import.meta.env.VITE_ENABLED_SOURCES,
  },
  emptyStringAsUndefined: true,
});

// Public configuration name used by the live viewer. Vite supplies it from
// VITE_TA_LIVE_SOCKET_URL at build time.
export const TALiveSocketUrl = env.VITE_TA_LIVE_SOCKET_URL;
export const CoCuLiveSocketUrl = env.VITE_COCU_LIVE_SOCKET_URL;
