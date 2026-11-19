import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'use-intl';

import { BeatmapParser } from '../../core/beatmap/worker/client';
import { parseReplayBytes } from '../viewer/replay-loaders';
import { loadBrSession, type BrLoadMessages, type BrSession } from './br-load';
import { takeBrPendingFiles } from './br-pending-files';
import { brEntriesFromSearch, type BrEntry, type BrSearch } from './br-search';
import type { BrMismatch } from './br-validate';

export type BrLoadState =
  | { status: 'loading'; loaded: number; total: number }
  | { status: 'ready'; session: BrSession }
  | { status: 'error'; message: string };

// Loads and validates every replay of a /br page, plus the shared map. The files picked
// on the landing page (see br-pending-files) are appended after the entries from the URL.
export function useBrLoad(search: BrSearch): BrLoadState {
  const t = useTranslations('viewer');
  const [state, setState] = useState<BrLoadState>({ status: 'loading', loaded: 0, total: 0 });
  const filesRef = useRef<File[] | null>(null);
  filesRef.current ??= takeBrPendingFiles();
  const searchKey = JSON.stringify([search.ss, search.bl, search.replayUrl, search.map]);

  useEffect(() => {
    const controller = new AbortController();
    let parser: BeatmapParser | null = null;
    const entries: BrEntry[] = [
      ...brEntriesFromSearch(search),
      ...(filesRef.current ?? []).map((file): BrEntry => ({ kind: 'file', file })),
    ];
    const mismatchMessage = (mismatch: BrMismatch) => {
      const values = {
        player: mismatch.label,
        reference: mismatch.referenceLabel,
        expected: mismatch.expected,
        actual: mismatch.actual,
      };
      return mismatch.field === 'map'
        ? t('errors.brMismatchMap', values)
        : mismatch.field === 'difficulty'
          ? t('errors.brMismatchDifficulty', values)
          : t('errors.brMismatchCharacteristic', values);
    };
    const messages: BrLoadMessages = {
      beatleaderReplayMapMismatch: t('errors.beatleaderReplayMapMismatch'),
      replayDifficultyMismatch: t('errors.replayDifficultyMismatch'),
      replayMapMismatch: t('errors.replayMapMismatch'),
      replayMissingHash: t('errors.replayMissingHash'),
      sourceDisabled: t('errors.sourceDisabled'),
      tooFewPlayers: t('errors.brTooFewPlayers'),
      mapOverrideMismatch: t('errors.brMapOverrideMismatch'),
      mismatch: mismatchMessage,
    };
    setState({ status: 'loading', loaded: 0, total: entries.length });
    void loadBrSession(entries, {
      messages,
      map: search.map,
      signal: controller.signal,
      parseReplay: (data, source = 'local') =>
        parseReplayBytes(data, source, () => (parser ??= new BeatmapParser()), messages.sourceDisabled),
      onPlayerLoaded: (loaded, total) => {
        if (!controller.signal.aborted) setState({ status: 'loading', loaded, total });
      },
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setState(
          result.isErr()
            ? { status: 'error', message: `${t('errors.failedSource')}: ${result.error.message}` }
            : { status: 'ready', session: result.value },
        );
      })
      // A loader that throws instead of returning an error must still end on the error screen
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        setState({ status: 'error', message: `${t('errors.failedSource')}: ${reason}` });
      });
    return () => {
      controller.abort();
      parser?.dispose();
    };
  }, [searchKey]);

  return state;
}
