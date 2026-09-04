export interface QualityPreset {
  label: string;
  patchResolution: number;
}

/** Vertices-per-side of a terrain patch. Higher = smoother terrain, more triangles per patch. */
export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { label: "Low", patchResolution: 17 },
  { label: "Medium", patchResolution: 25 },
  { label: "High", patchResolution: 33 },
  { label: "Ultra", patchResolution: 41 },
];

const STORAGE_KEY = "experimentrts.graphics";
const DEFAULT_PRESET_INDEX = 2; // High
const DEFAULT_NIGHT_BRIGHTNESS = 0.05;
export const MIN_NIGHT_BRIGHTNESS = 0.02;
export const MAX_NIGHT_BRIGHTNESS = 0.3;

/**
 * Terrain quality and night-side minimum brightness, persisted to localStorage. Quality takes
 * effect for terrain generated from this point forward (newly-visited planets, or after a
 * reload) - it doesn't retroactively re-mesh already-generated patches on the currently-
 * focused body. Night brightness applies live (read every frame - see main.ts).
 */
class GraphicsSettings {
  presetIndex = DEFAULT_PRESET_INDEX;
  nightBrightness = DEFAULT_NIGHT_BRIGHTNESS;

  constructor() {
    this.load();
  }

  get patchResolution(): number {
    return QUALITY_PRESETS[this.presetIndex].patchResolution;
  }

  setPresetIndex(index: number): void {
    this.presetIndex = Math.min(QUALITY_PRESETS.length - 1, Math.max(0, index));
    this.save();
  }

  setNightBrightness(value: number): void {
    this.nightBrightness = Math.min(MAX_NIGHT_BRIGHTNESS, Math.max(MIN_NIGHT_BRIGHTNESS, value));
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as { presetIndex?: number; nightBrightness?: number };
        if (typeof data.presetIndex === "number") this.presetIndex = data.presetIndex;
        if (typeof data.nightBrightness === "number") this.nightBrightness = data.nightBrightness;
      }
    } catch {
      // localStorage unavailable or corrupted - fall back to default silently.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ presetIndex: this.presetIndex, nightBrightness: this.nightBrightness }));
    } catch {
      // Best-effort persistence only.
    }
  }
}

export const graphicsSettings = new GraphicsSettings();
