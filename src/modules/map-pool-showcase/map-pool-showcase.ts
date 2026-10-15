export interface MapPoolShowcaseMap {
  reference: string;
  key: string;
  hash: string;
  name: string;
  artist: string;
  mapper: string;
  coverUrl: string;
  durationSeconds: number;
  previewStartSeconds: number;
  bpm: number;
  characteristic: string;
  difficulty: string;
  difficultyLabel?: string;
  njs?: number;
  nps?: number;
}

export interface MapPoolShowcaseConfig {
  maps: MapPoolShowcaseMap[];
  loop: boolean;
  startMode: 'start' | 'preview';
  durationMode: 'full' | 'seconds';
  durationSeconds: number;
}

export function difficultyRank(value: string) {
  const source = value.toLowerCase();
  const normalized = source.replace(/[^a-z0-9]/g, '');
  if (source.includes('+') || ['expertplus', 'expertp', 'expert5', 'explus', 'exp'].includes(normalized)) return 9;
  return ({ easy: 1, normal: 3, hard: 5, expert: 7 } as Record<string, number>)[normalized];
}
