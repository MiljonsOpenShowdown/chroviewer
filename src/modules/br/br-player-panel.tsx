import { useLayoutEffect, useMemo, useRef } from 'react';

import { useFormatter, useTranslations } from 'use-intl';

import type { Rgb } from '../../core/colors';
import type { ReplayScoreState } from '../../core/replay/scoring';
import type { ReplayPlayerView } from '../../renderer/map-view';
import { brPlayerOrder } from './br-player-order';

import { Card } from '@/components/ui/card';

import { cn } from '@/lib/utils';

interface BrPlayerPanelProps {
  title: string | null;
  players: readonly ReplayPlayerView[];
  /** Stable key per entry (brPlayerKeys), so a row keeps its element while it moves. */
  playerKeys: readonly string[];
  /** Live score per player, null until the map is loaded. */
  scores: readonly ReplayScoreState[] | null;
  focusedIndex: number;
  visible: boolean;
  onFocus: (index: number) => void;
}

const rowMoveTransition = 'transform 280ms ease-out';

function cssColor([red, green, blue]: Rgb) {
  return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
}

// The y translation of an element's current (possibly mid-transition) transform, 0 for none
function translateY(element: HTMLElement) {
  const transform = getComputedStyle(element).transform;
  return transform === 'none' || transform === '' ? 0 : new DOMMatrixReadOnly(transform).m42;
}

/**
 * Every player with their colours, live score and accuracy, highest score first; clicking a row moves the camera
 * and HUD to that player. Rows slide to their new place when the order changes.
 */
export function BrPlayerPanel({
  title,
  players,
  playerKeys,
  scores,
  focusedIndex,
  visible,
  onFocus,
}: BrPlayerPanelProps) {
  const t = useTranslations('br');
  const format = useFormatter();
  const currentOrder =
    scores === null ? players.map((_, index) => index) : brPlayerOrder(scores.map((state) => state.score));
  const orderKey = currentOrder.join(',');
  // Only a changed order re-renders the rows in a new order and slides them
  const order = useMemo(() => currentOrder, [orderKey]);
  const rows = useRef(new Map<string, HTMLLIElement>());
  // Each row's layout top (offsetTop, so scrolling the list does not count) after the last order change
  const rowTops = useRef(new Map<string, number>());

  // FLIP: the rows are already in their new places, so each starts from where it was shown and slides back to 0
  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const moving: HTMLLIElement[] = [];
    for (const [key, row] of rows.current) {
      const top = row.offsetTop;
      const previous = rowTops.current.get(key);
      rowTops.current.set(key, top);
      if (previous === undefined) continue;
      // A row still sliding from an earlier change starts from where it is drawn now
      const from = previous + translateY(row) - top;
      if (reduceMotion || Math.abs(from) < 0.5) {
        row.style.transition = '';
        row.style.transform = '';
        continue;
      }
      row.style.transition = 'none';
      row.style.transform = `translateY(${from}px)`;
      moving.push(row);
    }
    if (moving.length === 0) return;
    // Applies the start positions before the transition back to 0
    void moving[0]?.offsetHeight;
    for (const row of moving) {
      row.style.transition = rowMoveTransition;
      row.style.transform = '';
    }
  }, [orderKey]);

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
        {order.map((index) => {
          const player = players[index];
          const key = playerKeys[index] ?? String(index);
          if (player === undefined) return null;
          const score = scores?.[index];
          const focused = index === focusedIndex;
          return (
            <li
              key={key}
              ref={(row) => {
                if (row === null) rows.current.delete(key);
                else rows.current.set(key, row);
              }}
            >
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
                  <>
                    <span className="text-muted-foreground col-start-2 flex gap-3 text-xs tabular-nums">
                      <span>{t('combo', { combo: score.combo })}</span>
                      <span>{t('misses', { misses: score.misses + score.badCuts })}</span>
                    </span>
                    {/* The gameplay HUD's accuracy: 100.00% until the first note */}
                    <span className="text-muted-foreground text-right text-xs tabular-nums">
                      {format.number(score.accuracy, 'precisePercent')}
                    </span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
