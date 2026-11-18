import { useRef, useState } from 'react';

import { ArrowRight, File as FileIcon, FolderOpen, Link as LinkIcon, X } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { isViewerSourceEnabled } from '../../../sources/source-config';
import { configurableViewerSources, type MapLookup } from '../../../sources/source-types';
import type { BrEntry } from '../../br/br-search';
import { isRemoteSourceUrl } from '../viewer-search';
import type { ViewerSource } from '../viewer-types';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { InputGroup, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import logoUrl from '@/app/assets/logo.svg?url';

interface SourcePickerProps {
  choices: MapLookup[];
  input: string;
  visible: boolean;
  onChoose: (choice: MapLookup) => void;
  onAboutClick: () => void;
  onInputChange: (input: string) => void;
  onOpenFiles: () => void;
  onSubmit: (source: ViewerSource) => void;
  onStartBattleRoyale: (entries: BrEntry[]) => void;
}

const initialSource = configurableViewerSources.find(isViewerSourceEnabled) ?? 'link';

function brEntryKey(entry: BrEntry) {
  switch (entry.kind) {
    case 'scoresaber':
    case 'beatleader':
      return `${entry.kind}:${entry.id}`;
    case 'url':
      return `url:${entry.url}`;
    case 'file':
      return `file:${entry.file.name}:${entry.file.size}:${entry.file.lastModified}`;
  }
}

function brEntryText(entry: BrEntry) {
  switch (entry.kind) {
    case 'scoresaber':
    case 'beatleader':
      return entry.id;
    case 'url':
      return entry.url;
    case 'file':
      return entry.file.name;
  }
}

function BrEntryIcon({ entry }: { entry: BrEntry }) {
  if (entry.kind === 'url') return <LinkIcon className="size-4 shrink-0" />;
  if (entry.kind === 'file') return <FileIcon className="size-4 shrink-0" />;
  return <img className="size-4 shrink-0" src={`${import.meta.env.BASE_URL}${entry.kind}.svg`} alt={entry.kind} />;
}

export function SourcePicker({
  choices,
  input,
  visible,
  onChoose,
  onAboutClick,
  onInputChange,
  onOpenFiles,
  onSubmit,
  onStartBattleRoyale,
}: SourcePickerProps) {
  const t = useTranslations('source');
  const [source, setSource] = useState<ViewerSource>(initialSource);
  // The Battle Royale list survives tab switches and unchecking the box
  const [battleRoyale, setBattleRoyale] = useState(false);
  const [brEntries, setBrEntries] = useState<BrEntry[]>([]);
  const brFileInputRef = useRef<HTMLInputElement>(null);
  const scoreSaber = source === 'scoresaber';
  const beatLeader = source === 'beatleader';
  const isScore = scoreSaber || beatLeader;
  const link = source === 'link';
  const brActive = battleRoyale && source !== 'beatsaver';
  const trimmedInput = input.trim();
  const validInput =
    trimmedInput !== '' && (!isScore || /^\d+$/.test(trimmedInput)) && (!link || isRemoteSourceUrl(trimmedInput));
  const inputLabel = scoreSaber
    ? t('scoresaberInputLabel')
    : beatLeader
      ? t('beatleaderInputLabel')
      : link
        ? t('linkInputLabel')
        : t('beatsaverInputLabel');
  const inputPlaceholder = scoreSaber
    ? t('scoresaberInputPlaceholder')
    : beatLeader
      ? t('beatleaderInputPlaceholder')
      : link
        ? t('linkInputPlaceholder')
        : t('beatsaverInputPlaceholder');

  function addBrEntries(added: BrEntry[]) {
    setBrEntries((current) => {
      const keys = new Set(current.map(brEntryKey));
      const next = [...current];
      for (const entry of added) {
        const key = brEntryKey(entry);
        if (keys.has(key)) continue;
        keys.add(key);
        next.push(entry);
      }
      return next;
    });
  }

  function addBrInput() {
    if (!validInput) return;
    addBrEntries([
      scoreSaber
        ? { kind: 'scoresaber', id: trimmedInput }
        : beatLeader
          ? { kind: 'beatleader', id: trimmedInput }
          : { kind: 'url', url: trimmedInput },
    ]);
    onInputChange('');
  }

  return (
    <>
      {visible && (
        <Card
          className="bg-card/65 fixed top-1/2 left-1/2 z-20 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden border-white/15 p-5 shadow-2xl shadow-black/35 backdrop-blur-2xl"
          role="group"
          aria-label={t('loadGroup')}
        >
          <div className="pointer-events-none absolute inset-x-16 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <h1 className="font-pixel mb-4 flex flex-col items-center justify-center gap-1 text-center text-xl font-medium tracking-widest [-webkit-text-stroke:0.8px_currentColor]">
            <img className="size-20 drop-shadow-[0_2px_3px_rgba(0,0,0,0.3)]" src={logoUrl} alt="" aria-hidden="true" />
            ChroViewer
          </h1>
          <ToggleGroup
            className="bg-muted/60 mb-3 grid auto-cols-fr grid-flow-col rounded-lg border p-1"
            type="single"
            value={source}
            aria-label={t('sourceType')}
            onValueChange={(value) => {
              if (value === 'beatsaver' || value === 'link' || value === 'scoresaber' || value === 'beatleader')
                setSource(value);
            }}
          >
            {isViewerSourceEnabled('beatsaver') && (
              <ToggleGroupItem
                className="data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:hover:bg-background h-9 gap-1.5 px-2 text-sm hover:bg-white/10 data-[state=on]:shadow-sm sm:gap-2"
                value="beatsaver"
                aria-label={t('beatsaver')}
              >
                <img
                  className="size-4 sm:size-5"
                  src={`${import.meta.env.BASE_URL}beatsaver.svg`}
                  alt=""
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">{t('beatsaver')}</span>
              </ToggleGroupItem>
            )}
            {isViewerSourceEnabled('scoresaber') && (
              <ToggleGroupItem
                className="data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:hover:bg-background h-9 gap-1.5 px-2 text-sm hover:bg-white/10 data-[state=on]:shadow-sm sm:gap-2"
                value="scoresaber"
                aria-label={t('scoresaber')}
              >
                <img
                  className="size-4 sm:size-5"
                  src={`${import.meta.env.BASE_URL}scoresaber.svg`}
                  alt=""
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">{t('scoresaber')}</span>
              </ToggleGroupItem>
            )}
            {isViewerSourceEnabled('beatleader') && (
              <ToggleGroupItem
                className="data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:hover:bg-background h-9 gap-1.5 px-2 text-sm hover:bg-white/10 data-[state=on]:shadow-sm sm:gap-2"
                value="beatleader"
                aria-label={t('beatleader')}
              >
                <img
                  className="size-4 sm:size-5"
                  src={`${import.meta.env.BASE_URL}beatleader.svg`}
                  alt=""
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">{t('beatleader')}</span>
              </ToggleGroupItem>
            )}
            <ToggleGroupItem
              className="data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:hover:bg-background h-9 gap-1.5 px-2 text-sm hover:bg-white/10 data-[state=on]:shadow-sm sm:gap-2"
              value="link"
              aria-label={t('link')}
            >
              <LinkIcon className="size-4 sm:size-5" />
              <span className="hidden sm:inline">{t('link')}</span>
            </ToggleGroupItem>
          </ToggleGroup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (brActive) addBrInput();
              else onSubmit(source);
            }}
          >
            <InputGroup>
              <InputGroupInput
                type={link ? 'url' : 'text'}
                inputMode={isScore ? 'numeric' : link ? 'url' : 'text'}
                pattern={isScore ? '[0-9]*' : undefined}
                value={input}
                aria-label={inputLabel}
                placeholder={inputPlaceholder}
                onChange={(event) => {
                  onInputChange(event.currentTarget.value);
                }}
              />
              {(!link || brActive) && (
                <InputGroupButton
                  aria-label={t('openFiles')}
                  title={t('openFiles')}
                  onClick={brActive ? () => brFileInputRef.current?.click() : onOpenFiles}
                >
                  <FolderOpen />
                </InputGroupButton>
              )}
              <InputGroupButton
                type="submit"
                aria-label={
                  brActive ? t('brAddEntry') : isScore ? t('loadReplay') : link ? t('loadLink') : t('loadMap')
                }
                disabled={!validInput}
              >
                <ArrowRight />
              </InputGroupButton>
            </InputGroup>
          </form>
          {source !== 'beatsaver' && (
            <label
              className="text-muted-foreground mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm select-none"
              htmlFor="battle-royale"
            >
              <Checkbox
                id="battle-royale"
                checked={battleRoyale}
                onCheckedChange={(checked) => {
                  setBattleRoyale(checked === true);
                }}
              />
              {t('battleRoyale')}
            </label>
          )}
          {brActive && (
            <section className="mt-3 grid gap-2">
              {brEntries.length > 0 && (
                <ul className="grid max-h-40 gap-1 overflow-y-auto" aria-label={t('brEntries')}>
                  {brEntries.map((entry) => (
                    <li
                      key={brEntryKey(entry)}
                      className="bg-background/40 flex h-8 items-center gap-2 rounded-md border pr-0.5 pl-2 text-sm"
                    >
                      <BrEntryIcon entry={entry} />
                      <span className="min-w-0 flex-1 truncate">{brEntryText(entry)}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 cursor-pointer"
                        aria-label={t('brRemoveEntry', { entry: brEntryText(entry) })}
                        onClick={() => {
                          setBrEntries((current) => current.filter((other) => other !== entry));
                        }}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                type="button"
                className="w-full cursor-pointer"
                disabled={brEntries.length < 2}
                onClick={() => {
                  onStartBattleRoyale(brEntries);
                }}
              >
                {t('brStart')}
              </Button>
            </section>
          )}
          <input
            ref={brFileInputRef}
            type="file"
            className="hidden"
            multiple
            accept=".dat,.bsor"
            onChange={(event) => {
              addBrEntries([...(event.currentTarget.files ?? [])].map((file): BrEntry => ({ kind: 'file', file })));
              event.currentTarget.value = '';
            }}
          />
          {scoreSaber && choices.length > 0 && (
            <section>
              <h2 className="text-muted-foreground mt-4 mb-2 text-xs font-medium">{t('multipleMatches')}</h2>
              <ul className="grid gap-1">
                {choices.map((choice) => (
                  <li key={choice.hash}>
                    <Button
                      type="button"
                      className="h-auto w-full justify-start text-left whitespace-normal"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onChoose(choice);
                      }}
                    >
                      {choice.label}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <button
            className="text-muted-foreground decoration-border hover:text-foreground hover:decoration-muted-foreground focus-visible:ring-ring/40 mx-auto mt-4 block rounded-sm text-[11px] underline underline-offset-4 transition-colors outline-none focus-visible:ring-3"
            type="button"
            aria-haspopup="dialog"
            onClick={onAboutClick}
          >
            {t('about')}
          </button>
        </Card>
      )}
    </>
  );
}
