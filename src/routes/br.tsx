import { createFileRoute } from '@tanstack/react-router';

import { ErrorFallback, PendingFallback } from '../app/route-fallbacks';
import { brSearchSchema } from '../modules/br/br-search';

// Several replays of one map, played together in one scene
export const Route = createFileRoute('/br')({
  ssr: false,
  validateSearch: brSearchSchema,
  // The page itself is transparent (for embeds); /br has no canvas behind these yet, so they get the viewer's black
  pendingComponent: () => (
    <div className="size-full bg-black">
      <PendingFallback />
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="size-full bg-black">
      <ErrorFallback error={error} />
    </div>
  ),
  head: () => ({ meta: [{ title: 'ChroViewer Battle Royale' }] }),
});
