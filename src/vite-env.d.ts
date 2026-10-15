interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_BEATLEADER_API_URL?: string;
  readonly VITE_BEATSAVER_API_URL?: string;
  readonly VITE_COCU_LIVE_SOCKET_URL?: string;
  readonly VITE_ENABLED_SOURCES?: string;
  readonly VITE_LUDUS_URL?: string;
  readonly VITE_SCORESABER_API_URL?: string;
  readonly VITE_TA_LIVE_SOCKET_URL?: string;
}
