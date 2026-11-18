import { useFormatter, useTranslations } from 'use-intl';

import type { Rgb } from '../../core/colors';
import type { ReplayScoreState } from '../../core/replay/scoring';
import type { ReplayPlayerView } from '../../renderer/map-view';

import { Card } from '@/components/ui/card';

import { cn } from '@/lib/utils';

interface BrPlayerPanelProps {
  title: string | null;
  players: readonly ReplayPlayerView[];
  /** Live score per player, null until the map is loaded. */
  scores: readonly ReplayScoreState[] | null;
  focusedIndex: number;
  visible: boolean;
  onFocus: (index: number) => void;
}

function cssColor([red, green, blue]: Rgb) {
  return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
}

// Every player with their colours and live score; clicking a row moves the camera and HUD to that player.
export function BrPlayerPanel({ title, players, scores, focusedIndex, visible, onFocus }: BrPlayerPanelProps) {
  const t = useTranslations('br');
  const format = useFormatter();

  return (
    <Card
      className={cn(
        'bg-card/88 fixed top-3 left-3 z-30 flex max-h-[calc(100dvh-6rem)] w-64 flex-col overflow-hidden backdrop-blur-xl transition duration-200 max-sm:top-2 max-sm:left-2 max-sm:w-56',
        !visible && 'pointer-events-none -translate-y-2 opacity-0',
      )}
    >
      <div className="border-border border-b px-3 py-2">
        <p className="text-muted-foreground text-xs">{t('players', { count: players.length })}</p>
        {title !== null && <p className="truncate text-sm font-semibold">{title}</p>}
      </div>
      <ul className="grid gap-0.5 overflow-y-auto p-1">
        {players.map((player, index) => {
          const score = scores?.[index];
          const focused = index === focusedIndex;
          return (
            <li key={index}>
              <button
                type="button"
                className={cn(
                  'hover:bg-accent hover:text-accent-foreground grid w-full cursor-pointer grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  focused && 'bg-accent text-accent-foreground',
                )}
                aria-pressed={focused}
                title={t('focusPlayer', { name: player.name })}
                onClick={() => {
                  onFocus(index);
                }}
              >
                <span
                  className="size-3 rounded-sm"
                  style={{
                    background: `linear-gradient(135deg, ${cssColor(player.colors.left)} 50%, ${cssColor(player.colors.right)} 50%)`,
                  }}
                  aria-hidden="true"
                />
                <span className="truncate font-medium">{player.name}</span>
                <span className="tabular-nums">
                  {score === undefined ? '-' : format.number(score.score, 'integer')}
                </span>
                {score !== undefined && (
                  <span className="text-muted-foreground col-start-2 col-end-4 flex gap-3 text-xs tabular-nums">
                    <span>{t('combo', { combo: score.combo })}</span>
                    <span>{t('misses', { misses: score.misses + score.badCuts })}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
