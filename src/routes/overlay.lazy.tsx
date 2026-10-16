import { createLazyFileRoute, useSearch } from '@tanstack/react-router';

import { MultiviewShell } from '../modules/multiview/multiview-shell';
import { OVERLAY_MULTIVIEW_PLAYER_DEFAULTS } from '../modules/overlay/overlay-defaults';
import { OverlayShell } from '../modules/overlay/overlay-shell';

export const Route = createLazyFileRoute('/overlay')({
  component: OverlayRoute,
});

function OverlayRoute() {
  const search = useSearch({ from: '/overlay' });
  if (search.multiview === true)
    return <MultiviewShell Tile={OverlayShell} playerDefaults={OVERLAY_MULTIVIEW_PLAYER_DEFAULTS} />;
  return <OverlayShell />;
}
