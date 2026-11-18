import { useFormatter, useTranslations } from 'use-intl';

import { menuHiddenSaberModelIds, replaySaberModelIds, type ReplaySaberSettings } from '../../core/viewer-settings';
import { SettingRow } from './components/setting-row';
import { SettingSection } from './components/setting-section';
import { SliderSetting } from './components/slider-setting';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface SaberSettingsControlsProps {
  settings: ReplaySaberSettings;
  /** What each slider's reset button goes back to. */
  defaults: ReplaySaberSettings;
  /** Prefixes the slider ids, so several sets of controls can share a page. */
  idPrefix: string;
  /** Shows the Show sabers and Show trails switches. */
  visibilityToggles: boolean;
  onChange: (patch: Partial<ReplaySaberSettings>) => void;
}

type NumericSaberSetting = Exclude<
  keyof ReplaySaberSettings,
  'showSabers' | 'saberModel' | 'showSaberTrails' | 'replayTrailStyle' | 'replayTrailSmoothing'
>;

interface SaberSliderOptions {
  minimum: number;
  maximum: number;
  step: number;
  display: (value: number) => string;
}

/** The saber, trail, hilt and alignment controls of the Cosmetics tab, also used per player on Battle Royale. */
export function SaberSettingsControls({
  settings,
  defaults,
  idPrefix,
  visibilityToggles,
  onChange,
}: SaberSettingsControlsProps) {
  const format = useFormatter();
  const t = useTranslations('settings.saber');

  function update<K extends keyof ReplaySaberSettings>(key: K, value: ReplaySaberSettings[K]) {
    onChange({ [key]: value });
  }

  function slider(key: NumericSaberSetting, options: SaberSliderOptions) {
    return (
      <SliderSetting
        key={key}
        defaultValue={defaults[key]}
        id={`${idPrefix}-${key}`}
        label={t(key)}
        value={settings[key]}
        minimum={options.minimum}
        maximum={options.maximum}
        step={options.step}
        display={options.display}
        onChange={(value) => {
          update(key, value);
        }}
      />
    );
  }

  const centimeters = (value: number) => t('centimeters', { value: format.number(value * 100, 'decimal') });
  const millimeters = (value: number) => t('millimeters', { value: format.number(value * 1000, 'decimal') });
  const degrees = (value: number) => t('degrees', { value: format.number(value, 'decimal') });
  const integer = (value: number) => format.number(value, 'integer');
  const percent = (value: number) => format.number(value, 'percent', { maximumFractionDigits: 0 });
  const multiplier = (value: number) => t('multiplier', { value: format.number(value, 'decimal') });

  return (
    <>
      <SettingSection title={t('blade')}>
        <SettingRow label={t('saberModel')}>
          <Select
            value={settings.saberModel}
            onValueChange={(saberModel) => {
              const selected = replaySaberModelIds.find((model) => model === saberModel);
              if (selected !== undefined) update('saberModel', selected);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {/* A hidden saber still shows while selected, so the trigger has a label; dev builds list them all for testing */}
                {replaySaberModelIds
                  .filter(
                    (model) =>
                      import.meta.env.DEV || !menuHiddenSaberModelIds.has(model) || model === settings.saberModel,
                  )
                  .map((model) => (
                    <SelectItem key={model} value={model}>
                      {t(`saberModels.${model}`)}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
        {visibilityToggles && (
          <SettingRow label={t('showSabers')}>
            <Switch
              checked={settings.showSabers}
              onCheckedChange={(showSabers) => {
                update('showSabers', showSabers);
              }}
            />
          </SettingRow>
        )}
        {slider('saberWidth', {
          minimum: 0.25,
          maximum: 3,
          step: 0.01,
          display: percent,
        })}
        {settings.saberModel.startsWith('mos-') &&
          slider('mosSaberBrightness', {
            minimum: 0,
            maximum: 2,
            step: 0.01,
            display: percent,
          })}
        {settings.saberModel === 'default' && (
          <>
            {slider('saberScale', {
              minimum: 0.25,
              maximum: 3,
              step: 0.01,
              display: percent,
            })}
            {slider('saberBladeLength', {
              minimum: 0.1,
              maximum: 2,
              step: 0.001,
              display: centimeters,
            })}
            {slider('saberBladeThickness', {
              minimum: 0.001,
              maximum: 0.03,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberCoreThickness', {
              minimum: 0.0005,
              maximum: 0.02,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberCoreInset', {
              minimum: 0,
              maximum: 0.2,
              step: 0.001,
              display: millimeters,
            })}
          </>
        )}
      </SettingSection>
      <Separator />
      <SettingSection title={t('trail')}>
        {visibilityToggles && (
          <SettingRow label={t('showSaberTrails')}>
            <Switch
              checked={settings.showSaberTrails}
              onCheckedChange={(showSaberTrails) => {
                update('showSaberTrails', showSaberTrails);
              }}
            />
          </SettingRow>
        )}
        <SettingRow label={t('replayTrailSmoothing')}>
          <Switch
            checked={settings.replayTrailSmoothing}
            onCheckedChange={(replayTrailSmoothing) => {
              update('replayTrailSmoothing', replayTrailSmoothing);
            }}
          />
        </SettingRow>
        <SettingRow label={t('replayTrailShape')}>
          <ToggleGroup
            type="single"
            value={settings.replayTrailStyle}
            aria-label={t('replayTrailShape')}
            onValueChange={(replayTrailStyle) => {
              if (replayTrailStyle === 'flag' || replayTrailStyle === 'rectangle') {
                update('replayTrailStyle', replayTrailStyle);
              }
            }}
          >
            <ToggleGroupItem value="flag">{t('trailFlag')}</ToggleGroupItem>
            <ToggleGroupItem value="rectangle">{t('trailRectangle')}</ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
        {slider('replayTrailLength', {
          minimum: 0.02,
          maximum: 1.5,
          step: 0.001,
          display: centimeters,
        })}
        {slider('replayTrailThinness', {
          minimum: 0,
          maximum: 0.95,
          step: 0.01,
          display: percent,
        })}
        {slider('replayTrailSamples', {
          minimum: 2,
          maximum: 128,
          step: 1,
          display: integer,
        })}
        {slider('replayTrailFade', {
          minimum: 0.1,
          maximum: 5,
          step: 0.1,
          display: multiplier,
        })}
        {slider('replayTrailOpacity', {
          minimum: 0,
          maximum: 2,
          step: 0.01,
          display: percent,
        })}
        {slider('replayTrailMotionThreshold', {
          minimum: 0.0001,
          maximum: 0.02,
          step: 0.0001,
          display: millimeters,
        })}
      </SettingSection>
      {settings.saberModel === 'default' && (
        <>
          <Separator />
          <SettingSection title={t('hilt')}>
            {slider('saberGripLength', {
              minimum: 0.02,
              maximum: 0.3,
              step: 0.001,
              display: centimeters,
            })}
            {slider('saberGripThickness', {
              minimum: 0.002,
              maximum: 0.03,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberGuardSize', {
              minimum: 0.005,
              maximum: 0.08,
              step: 0.0005,
              display: millimeters,
            })}
            {slider('saberGuardThickness', {
              minimum: 0.0005,
              maximum: 0.01,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberCollarSize', {
              minimum: 0.002,
              maximum: 0.04,
              step: 0.0005,
              display: millimeters,
            })}
            {slider('saberCollarThickness', {
              minimum: 0.0005,
              maximum: 0.01,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberCollarSpacing', {
              minimum: 0,
              maximum: 0.2,
              step: 0.001,
              display: millimeters,
            })}
            {slider('saberRingCount', {
              minimum: 0,
              maximum: 5,
              step: 1,
              display: integer,
            })}
            {slider('saberRingSize', {
              minimum: 0.002,
              maximum: 0.03,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberRingThickness', {
              minimum: 0.001,
              maximum: 0.02,
              step: 0.0001,
              display: millimeters,
            })}
            {slider('saberRingSpacing', {
              minimum: 0,
              maximum: 0.04,
              step: 0.0005,
              display: millimeters,
            })}
            {slider('saberPommelLength', {
              minimum: 0.002,
              maximum: 0.05,
              step: 0.0005,
              display: millimeters,
            })}
            {slider('saberPommelThickness', {
              minimum: 0.002,
              maximum: 0.03,
              step: 0.0001,
              display: millimeters,
            })}
          </SettingSection>
          <Separator />
          <SettingSection title={t('alignment')}>
            {slider('saberXOffset', {
              minimum: -0.25,
              maximum: 0.25,
              step: 0.001,
              display: centimeters,
            })}
            {slider('saberYOffset', {
              minimum: -0.25,
              maximum: 0.25,
              step: 0.001,
              display: centimeters,
            })}
            {slider('saberZOffset', {
              minimum: -0.25,
              maximum: 0.25,
              step: 0.001,
              display: centimeters,
            })}
            {slider('saberXRotation', {
              minimum: -45,
              maximum: 45,
              step: 0.1,
              display: degrees,
            })}
            {slider('saberYRotation', {
              minimum: -45,
              maximum: 45,
              step: 0.1,
              display: degrees,
            })}
            {slider('saberZRotation', {
              minimum: -45,
              maximum: 45,
              step: 0.1,
              display: degrees,
            })}
          </SettingSection>
        </>
      )}
    </>
  );
}
