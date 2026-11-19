import { RotateCcw } from 'lucide-react';
import { useFormatter, useTranslations } from 'use-intl';

import type { PlayerColors } from '../../core/player-colors';
import type { ReplaySaberSettings } from '../../core/viewer-settings';
import { ColorPicker } from '../settings/components/color-picker';
import { SettingRow } from '../settings/components/setting-row';
import { SettingSection } from '../settings/components/setting-section';
import { SliderSetting } from '../settings/components/slider-setting';
import { SaberSettingsControls } from '../settings/saber-settings-controls';
import {
  BR_ORTHO_ZOOM,
  brSaberSettings,
  DEFAULT_BR_PLAYER_OVERRIDES,
  MAX_BR_NAME_LENGTH,
  rgbToHex,
  type BrPlayerOverrides,
  type BrSettings,
} from './br-settings';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface BrSettingsPlayer {
  /** From brPlayerKeys */
  key: string;
  /** Resolved name, before the display name override. */
  name: string;
  /** Generated colours, before the colour overrides. */
  colors: PlayerColors;
}

interface BrSettingsTabProps {
  players: readonly BrSettingsPlayer[];
  settings: BrSettings;
  /** The Cosmetics saber settings every player starts from. */
  sabers: ReplaySaberSettings;
  onChange: (settings: BrSettings) => void;
}

type ColorKey = 'leftColor' | 'rightColor';
type VisibilityKey = 'showSabers' | 'showTrails' | 'showHeadset' | 'showLabel';

const visibilityKeys: VisibilityKey[] = ['showSabers', 'showTrails', 'showHeadset', 'showLabel'];
const orthoViews = ['left', 'back', 'right'] as const;
const orthoViewLabels = { left: 'leftView', back: 'backView', right: 'rightView' } as const;

/** The Battle Royale tab of the settings drawer: ortho main camera, HUD and per-player overrides. */
export function BrSettingsTab({ players, settings, sabers, onChange }: BrSettingsTabProps) {
  const format = useFormatter();
  const t = useTranslations('br.settings');
  const ts = useTranslations('settings');
  const tc = useTranslations('settings.camera');
  const brSabers = brSaberSettings(sabers);

  function updatePlayer(key: string, patch: Partial<BrPlayerOverrides>) {
    const current = settings.players[key] ?? DEFAULT_BR_PLAYER_OVERRIDES;
    onChange({ ...settings, players: { ...settings.players, [key]: { ...current, ...patch } } });
  }

  return (
    <div className="flex flex-col gap-5 px-5 py-4">
      <SliderSetting
        defaultValue={BR_ORTHO_ZOOM.default}
        id="br-ortho-zoom"
        label={t('orthoZoom')}
        detail={t('orthoZoomDescription')}
        value={settings.orthoZoom}
        minimum={BR_ORTHO_ZOOM.minimum}
        maximum={BR_ORTHO_ZOOM.maximum}
        step={0.05}
        display={(value) => t('zoomValue', { value: format.number(value, 'decimal') })}
        onChange={(orthoZoom) => {
          onChange({ ...settings, orthoZoom });
        }}
      />
      <div className="flex flex-col gap-2">
        <p className="text-sm">{t('orthoView')}</p>
        <ToggleGroup
          className="grid w-full grid-cols-3"
          type="single"
          value={settings.orthoView}
          aria-label={t('orthoView')}
          onValueChange={(value) => {
            const orthoView = orthoViews.find((view) => view === value);
            if (orthoView !== undefined) onChange({ ...settings, orthoView });
          }}
        >
          {orthoViews.map((view) => (
            <ToggleGroupItem key={view} className="w-full cursor-pointer" value={view}>
              {tc(orthoViewLabels[view])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-muted-foreground text-xs">{t('orthoViewDescription')}</p>
      </div>
      <SettingRow label={t('hitScoresOnly')} detail={t('hitScoresOnlyDescription')}>
        <Switch
          className="cursor-pointer"
          checked={settings.hitScoresOnly}
          onCheckedChange={(hitScoresOnly) => {
            onChange({ ...settings, hitScoresOnly });
          }}
        />
      </SettingRow>
      <Separator />
      <SettingSection title={t('players')}>
        <Accordion type="multiple">
          {players.map((player, index) => {
            const overrides = settings.players[player.key] ?? DEFAULT_BR_PLAYER_OVERRIDES;
            const left = overrides.leftColor ?? rgbToHex(player.colors.left);
            const right = overrides.rightColor ?? rgbToHex(player.colors.right);
            const name = overrides.name.trim() === '' ? player.name : overrides.name;

            function color(key: ColorKey, value: string) {
              const label = t(key);
              const resetLabel = ts('resetSetting', { setting: label });
              return (
                <SettingRow label={label}>
                  <div className="flex items-center gap-1">
                    <ColorPicker
                      label={label}
                      inputLabel={t('hexColorInput', { setting: label })}
                      value={value}
                      onChange={(next) => {
                        updatePlayer(player.key, { [key]: next });
                      }}
                    />
                    <Button
                      className="size-5 cursor-pointer"
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={overrides[key] === null}
                      aria-label={resetLabel}
                      title={resetLabel}
                      onClick={() => {
                        updatePlayer(player.key, { [key]: null });
                      }}
                    >
                      <RotateCcw data-icon="inline-start" />
                    </Button>
                  </div>
                </SettingRow>
              );
            }

            return (
              // A player listed twice shares one set of overrides, so the index keeps the items apart
              <AccordionItem key={index} value={String(index)}>
                <AccordionTrigger className="cursor-pointer items-center">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-3 shrink-0 rounded-sm"
                      style={{ background: `linear-gradient(135deg, ${left} 50%, ${right} 50%)` }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{name}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="flex flex-col gap-5">
                  <Button
                    className="cursor-pointer self-end"
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      updatePlayer(player.key, DEFAULT_BR_PLAYER_OVERRIDES);
                    }}
                  >
                    <RotateCcw data-icon="inline-start" />
                    {t('resetPlayer')}
                  </Button>
                  <SettingSection title={t('colors')}>
                    {color('leftColor', left)}
                    {color('rightColor', right)}
                  </SettingSection>
                  <Separator />
                  <SettingSection title={t('displayName')}>
                    <Input
                      aria-label={t('displayName')}
                      autoComplete="off"
                      maxLength={MAX_BR_NAME_LENGTH}
                      placeholder={player.name}
                      spellCheck={false}
                      value={overrides.name}
                      onChange={(event) => {
                        updatePlayer(player.key, { name: event.currentTarget.value });
                      }}
                    />
                    <p className="text-muted-foreground text-xs">{t('displayNameDescription')}</p>
                  </SettingSection>
                  <Separator />
                  <SettingSection title={t('visibility')}>
                    <p className="text-muted-foreground text-xs">{t('visibilityDescription')}</p>
                    {visibilityKeys.map((key) => (
                      <SettingRow key={key} label={t(key)}>
                        <Switch
                          className="cursor-pointer"
                          checked={overrides[key]}
                          onCheckedChange={(value) => {
                            updatePlayer(player.key, { [key]: value });
                          }}
                        />
                      </SettingRow>
                    ))}
                  </SettingSection>
                  <Separator />
                  <SettingSection title={t('saberStyle')}>
                    <SliderSetting
                      defaultValue={DEFAULT_BR_PLAYER_OVERRIDES.saberOpacity}
                      id={`br-${index}-saber-opacity`}
                      label={t('saberOpacity')}
                      detail={t('saberOpacityDescription')}
                      value={overrides.saberOpacity}
                      minimum={0}
                      maximum={1}
                      step={0.05}
                      display={(value) => format.number(value, 'percent', { maximumFractionDigits: 0 })}
                      onChange={(saberOpacity) => {
                        updatePlayer(player.key, { saberOpacity });
                      }}
                    />
                    <SettingRow label={t('customSaberStyle')} detail={t('customSaberStyleDescription')}>
                      <Switch
                        className="cursor-pointer"
                        checked={overrides.saber !== null}
                        onCheckedChange={(custom) => {
                          updatePlayer(player.key, { saber: custom ? {} : null });
                        }}
                      />
                    </SettingRow>
                  </SettingSection>
                  {overrides.saber !== null && (
                    <SaberSettingsControls
                      settings={{ ...brSabers, ...overrides.saber }}
                      defaults={brSabers}
                      idPrefix={`br-${index}`}
                      visibilityToggles={false}
                      onChange={(patch) => {
                        updatePlayer(player.key, { saber: { ...overrides.saber, ...patch } });
                      }}
                    />
                  )}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </SettingSection>
    </div>
  );
}
