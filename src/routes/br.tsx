import { createFileRoute } from '@tanstack/react-router';

import { brSearchSchema } from '../modules/br/br-search';

// Several replays of one map, played together in one scene
export const Route = createFileRoute('/br')({
  ssr: false,
  validateSearch: brSearchSchema,
  head: () => ({ meta: [{ title: 'ChroViewer Battle Royale' }] }),
});
