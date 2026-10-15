import { createLazyFileRoute, useSearch } from '@tanstack/react-router';

import { MultiviewShell } from '../modules/multiview/multiview-shell';
import { ViewerShell } from '../modules/viewer/viewer-shell';

export const Route = createLazyFileRoute('/')({
  component: ViewerRoute,
});

function ViewerRoute() {
  const search = useSearch({ from: '/' });
  if (search.multiview === true) return <MultiviewShell />;
  return <ViewerShell key={search.party === undefined ? 'viewer' : `party:${search.party}`} />;
}
