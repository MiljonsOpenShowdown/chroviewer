import { useMemo, useState } from 'react';

import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { MAX_HSV_PROFILE_BYTES, parseHitScoreVisualizerProfile } from '../../core/replay/hit-score-visualizer-profile';
import {
  DEFAULT_REPLAY_SABER_SETTINGS,
  DEFAULT_VIEWER_SETTINGS,
  type ViewerSettings,
} from '../../core/viewer-settings';
import { ColorPicker } from './components/color-picker';
import { SettingRow } from './components/setting-row';
import { SettingSection } from './components/setting-section';
import { SaberSettingsControls } from './saber-settings-controls';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';

interface CosmeticsSettingsProps {
  settings: ViewerSettings;
  environments: readonly { id: string; title: string }[];
  onChange: (settings: ViewerSettings) => void;
}

type ColorSetting = Extract<
  keyof ViewerSettings,
  | 'leftColor'
  | 'rightColor'
  | 'obstacleColor'
  | 'environmentLeftColor'
  | 'environmentRightColor'
  | 'environmentWhiteColor'
  | 'environmentLeftBoostColor'
  | 'environmentRightBoostColor'
  | 'environmentWhiteBoostColor'
>;

type CosmeticSection = 'colors' | 'hsv' | 'sabers';

const cosmeticSections: CosmeticSection[] = ['colors', 'hsv', 'sabers'];
const colorSettings: ColorSetting[] = [
  'leftColor',
  'rightColor',
  'obstacleColor',
  'environmentLeftColor',
  'environmentRightColor',
  'environmentWhiteColor',
  'environmentLeftBoostColor',
  'environmentRightBoostColor',
  'environmentWhiteBoostColor',
];
const cosmeticSectionsStorageKey = 'chroviewer.settings.cosmetic-sections';

function loadOpenSections(storage: Pick<Storage, 'getItem'> = localStorage) {
  const saved = storage.getItem(cosmeticSectionsStorageKey)?.split(',') ?? [];
  return cosmeticSections.filter((section) => saved.includes(section));
}

function saveOpenSections(sections: readonly CosmeticSection[], storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(cosmeticSectionsStorageKey, sections.join(','));
}

export function CosmeticsSettings({ settings, environments, onChange }: CosmeticsSettingsProps) {
  const ts = useTranslations('settings');
  const tc = useTranslations('settings.cosmetics');
  const [openSections, setOpenSections] = useState(loadOpenSections);
  const hsvProfile = useMemo(
    () => (settings.hsvProfile.trim() === '' ? null : parseHitScoreVisualizerProfile(settings.hsvProfile)),
    [settings.hsvProfile],
  );

  function update<K extends keyof ViewerSettings>(key: K, value: ViewerSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function color(key: ColorSetting) {
    const resetLabel = ts('resetSetting', { setting: tc(key) });

    return (
      <SettingRow key={key} label={tc(key)}>
        <div className="flex items-center gap-1">
          <ColorPicker
            label={tc(key)}
            inputLabel={tc('hexColorInput', { setting: tc(key) })}
            disabled={key.startsWith('environment') ? !settings.customEnvironmentColors : !settings.customColors}
            value={settings[key]}
            onChange={(color) => {
              update(key, color);
            }}
          />
          <Button
            className="size-5"
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={settings[key] === DEFAULT_VIEWER_SETTINGS[key]}
            aria-label={resetLabel}
            title={resetLabel}
            onClick={() => {
              update(key, DEFAULT_VIEWER_SETTINGS[key]);
            }}
          >
            <RotateCcw data-icon="inline-start" />
          </Button>
        </div>
      </SettingRow>
    );
  }

  function resetColors() {
    onChange({
      ...settings,
      leftColor: DEFAULT_VIEWER_SETTINGS.leftColor,
      rightColor: DEFAULT_VIEWER_SETTINGS.rightColor,
      obstacleColor: DEFAULT_VIEWER_SETTINGS.obstacleColor,
      environmentLeftColor: DEFAULT_VIEWER_SETTINGS.environmentLeftColor,
      environmentRightColor: DEFAULT_VIEWER_SETTINGS.environmentRightColor,
      environmentWhiteColor: DEFAULT_VIEWER_SETTINGS.environmentWhiteColor,
      environmentLeftBoostColor: DEFAULT_VIEWER_SETTINGS.environmentLeftBoostColor,
      environmentRightBoostColor: DEFAULT_VIEWER_SETTINGS.environmentRightBoostColor,
      environmentWhiteBoostColor: DEFAULT_VIEWER_SETTINGS.environmentWhiteBoostColor,
    });
  }

  return (
    <TabsContent value="cosmetics" className="min-h-0 overflow-y-auto data-[state=inactive]:hidden">
      <Accordion
        type="multiple"
        value={openSections}
        className="px-5 py-4"
        onValueChange={(sections) => {
          const nextSections = cosmeticSections.filter((section) => sections.includes(section));
          setOpenSections(nextSections);
          saveOpenSections(nextSections);
        }}
      >
        <AccordionItem value="colors">
          <AccordionTrigger className="text-base font-semibold tracking-tight">{tc('overrides')}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-5">
            <SettingSection title={tc('environment')}>
              <SettingRow label={tc('useMapEnvironment')} detail={tc('useMapEnvironmentDescription')}>
                <Switch
                  checked={settings.useMapEnvironment}
                  onCheckedChange={(value) => update('useMapEnvironment', value)}
                />
              </SettingRow>
              <SettingRow label={tc('enableEnvironmentOverride')}>
                <Switch
                  disabled={settings.useMapEnvironment}
                  checked={settings.overrideEnvironment}
                  onCheckedChange={(overrideEnvironment) => {
                    update('overrideEnvironment', overrideEnvironment);
                  }}
                />
              </SettingRow>
              <SettingRow label={tc('stage')}>
                <Select
                  disabled={settings.useMapEnvironment || !settings.overrideEnvironment}
                  value={settings.environmentOverrideId}
                  onValueChange={(environmentOverrideId) => {
                    update('environmentOverrideId', environmentOverrideId);
                  }}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {environments.map((environment) => (
                        <SelectItem key={environment.id} value={environment.id}>
                          {environment.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow label={tc('preferReplayEnvironment')} detail={tc('preferReplayEnvironmentDescription')}>
                <Switch
                  disabled={settings.useMapEnvironment}
                  checked={settings.preferReplayEnvironment}
                  onCheckedChange={(preferReplayEnvironment) => {
                    update('preferReplayEnvironment', preferReplayEnvironment);
                  }}
                />
              </SettingRow>
            </SettingSection>
            <Separator />
            <SettingSection
              title={tc('colors')}
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={colorSettings.every((key) => settings[key] === DEFAULT_VIEWER_SETTINGS[key])}
                  onClick={resetColors}
                >
                  <RotateCcw data-icon="inline-start" />
                  {ts('resetAll')}
                </Button>
              }
            >
              <SettingRow label={tc('enableColorOverrides')}>
                <Switch
                  checked={settings.customColors}
                  onCheckedChange={(customColors) => {
                    update('customColors', customColors);
                  }}
                />
              </SettingRow>
              <SettingRow label={tc('preferReplayColors')} detail={tc('preferReplayColorsDescription')}>
                <Switch
                  checked={settings.preferReplayColors}
                  onCheckedChange={(preferReplayColors) => {
                    update('preferReplayColors', preferReplayColors);
                  }}
                />
              </SettingRow>
              {colorSettings.filter((key) => !key.startsWith('environment')).map(color)}
              <Separator />
              <SettingRow label={tc('preferReplayEnvironmentColors')}>
                <Switch
                  disabled={settings.customEnvironmentColors}
                  checked={settings.preferReplayEnvironmentColors}
                  onCheckedChange={(value) => update('preferReplayEnvironmentColors', value)}
                />
              </SettingRow>
              <SettingRow label={tc('customEnvironmentColors')} detail={tc('customEnvironmentColorsDescription')}>
                <Switch
                  checked={settings.customEnvironmentColors}
                  onCheckedChange={(value) => update('customEnvironmentColors', value)}
                />
              </SettingRow>
              {colorSettings.filter((key) => key.startsWith('environment')).map(color)}
            </SettingSection>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="hsv">
          <AccordionTrigger className="text-base font-semibold tracking-tight">{tc('hsv')}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-4">
            <SettingRow label={tc('enableHsvOverride')}>
              <Switch
                checked={settings.overrideHsvProfile}
                onCheckedChange={(overrideHsvProfile) => {
                  update('overrideHsvProfile', overrideHsvProfile);
                }}
              />
            </SettingRow>
            <SettingRow label={tc('preferReplayHsv')} detail={tc('preferReplayHsvDescription')}>
              <Switch
                checked={settings.preferReplayHsvProfile}
                onCheckedChange={(preferReplayHsvProfile) => {
                  update('preferReplayHsvProfile', preferReplayHsvProfile);
                }}
              />
            </SettingRow>
            <div className="flex min-w-0 flex-col gap-1.5">
              <InputGroup className="h-auto min-h-20 items-stretch">
                <InputGroupTextarea
                  id="viewer-hsv-profile"
                  className="[field-sizing:fixed] max-h-40 min-h-20 resize-none overflow-auto font-mono text-xs"
                  value={settings.hsvProfile}
                  maxLength={MAX_HSV_PROFILE_BYTES}
                  placeholder={tc('hsvProfilePlaceholder')}
                  aria-label={tc('hsvProfileInput')}
                  spellCheck={false}
                  aria-invalid={hsvProfile?.isErr() === true}
                  onChange={(event) => {
                    update('hsvProfile', event.target.value);
                  }}
                />
              </InputGroup>
              {hsvProfile?.isErr() === true && (
                <p className="text-destructive text-xs">
                  {tc('hsvProfileInvalid', {
                    reason: hsvProfile.error.message,
                  })}
                </p>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="sabers">
          <AccordionTrigger className="text-base font-semibold tracking-tight">{tc('sabers')}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-5">
            <Button
              className="self-end"
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange({ ...settings, ...DEFAULT_REPLAY_SABER_SETTINGS });
              }}
            >
              <RotateCcw data-icon="inline-start" />
              {ts('resetAll')}
            </Button>
            <SaberSettingsControls
              settings={settings}
              defaults={DEFAULT_REPLAY_SABER_SETTINGS}
              idPrefix="viewer"
              visibilityToggles
              onChange={(patch) => {
                onChange({ ...settings, ...patch });
              }}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </TabsContent>
  );
}
