import { createFileRoute } from '@tanstack/react-router';

import { viewerSearchSchema } from '../modules/viewer/viewer-search';

// Controls-free viewer for broadcast overlays. Unlike / it has no link
// previews, so no server metadata requests block the page.
export const Route = createFileRoute('/overlay')({
  ssr: false,
  validateSearch: viewerSearchSchema,
  head: () => ({ meta: [{ title: 'ChroViewer Overlay' }] }),
});
