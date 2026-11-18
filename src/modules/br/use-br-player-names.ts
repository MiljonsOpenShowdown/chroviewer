import { useQueries } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';

import { beatLeaderPlayerQueryOptions } from '../../sources/beatleader/queries';
import { scoreSaberPlayerQueryOptions } from '../../sources/scoresaber/queries';
import { isViewerSourceEnabled } from '../../sources/source-config';
import type { BrPlayer } from './br-load';

// The platform ID of a player whose replay names them only by that ID (TournamentAssistant replay files carry no
// name), or undefined when the player already has a name
function unnamedPlayerId({ profile, replay }: BrPlayer) {
  const player = replay.metadata.player;
  if (profile !== undefined || player === undefined) return undefined;
  return player.name.trim() === '' || player.name === player.id ? player.id : undefined;
}

/**
 * Display name of every player, in order. A player known only by an ID is looked up on ScoreSaber first, then on
 * BeatLeader; until a profile is found, or when neither has one, the name reads "Unknown", never the raw ID.
 */
export function useBrPlayerNames(players: readonly BrPlayer[]) {
  const t = useTranslations('br');
  const scoreSaberEnabled = isViewerSourceEnabled('scoresaber');
  const beatLeaderEnabled = isViewerSourceEnabled('beatleader');
  const ids = players.map(unnamedPlayerId);
  const scoreSaber = useQueries({
    queries: ids.map((id) => scoreSaberPlayerQueryOptions(scoreSaberEnabled ? id : undefined)),
  });
  const beatLeader = useQueries({
    queries: ids.map((id, index) =>
      beatLeaderPlayerQueryOptions(
        beatLeaderEnabled && (!scoreSaberEnabled || scoreSaber[index]?.isError === true) ? id : undefined,
      ),
    ),
  });
  return players.map((player, index) =>
    ids[index] === undefined
      ? player.name
      : (scoreSaber[index]?.data?.name ?? beatLeader[index]?.data?.name ?? t('unknownPlayer')),
  );
}
