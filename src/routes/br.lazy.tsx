import { createLazyFileRoute } from '@tanstack/react-router';

import { BrShell } from '../modules/br/br-shell';

export const Route = createLazyFileRoute('/br')({
  component: BrShell,
});
