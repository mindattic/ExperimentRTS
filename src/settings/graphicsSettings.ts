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
const DEFAULT_DEVELOPER_MODE = true;
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
  /** Selection-area drag direction (see SelectionAreaUI): normally up/right grows, left/down
   * shrinks - flipped when this is true. */
  invertSelectionAreaResize = false;
  /** Shows the bottom-left developer stats overlay (main.ts) - distance from the focused body,
   * FPS, current mode, etc. On by default for this project's dev-focused current stage. */
  developerMode = DEFAULT_DEVELOPER_MODE;
  /** Off by default per explicit request - the colored orbit-line loops (planets, moons,
   * stations) clutter the view once there are many of them on screen at once. */
  showOrbitLines = false;
  /** Off by default per explicit request - same declutter reasoning as showOrbitLines. */
  showShipTrajectories = false;
  /** Debug/preview toggle: always splits terrain to a fixed depth regardless of camera distance
   * (see planetTerrain.ts), instead of the normal distance-based LOD - "what does full terrain
   * detail look like from far away." Off by default; genuinely heavy when on (that same fixed
   * depth is deliberately capped well below MAX_DEPTH - see FORCE_DETAIL_MAX_DEPTH's own comment
   * for why forcing the real max depth everywhere is computationally infeasible). */
  forceMaxTerrainDetail = false;
  /** Ambient auto-relevel strength for OrbitTrackballCamera's roll, 0-1: 0 (default) means the
   * camera only ever re-levels via the explicit reorient hotkey (this session's original
   * behavior, unchanged); 1 snaps to level every frame (effectively instant); values in between
   * blend toward level continuously at a rate scaled by this value. Independent of (and stacks
   * harmlessly with) the hotkey's own one-shot reorient(). */
  reorientationStrength = 0;

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

  setInvertSelectionAreaResize(value: boolean): void {
    this.invertSelectionAreaResize = value;
    this.save();
  }

  setDeveloperMode(value: boolean): void {
    this.developerMode = value;
    this.save();
  }

  setShowOrbitLines(value: boolean): void {
    this.showOrbitLines = value;
    this.save();
  }

  setShowShipTrajectories(value: boolean): void {
    this.showShipTrajectories = value;
    this.save();
  }

  setForceMaxTerrainDetail(value: boolean): void {
    this.forceMaxTerrainDetail = value;
    this.save();
  }

  setReorientationStrength(value: number): void {
    this.reorientationStrength = Math.min(1, Math.max(0, value));
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as {
          presetIndex?: number;
          nightBrightness?: number;
          invertSelectionAreaResize?: boolean;
          developerMode?: boolean;
          showOrbitLines?: boolean;
          showShipTrajectories?: boolean;
          forceMaxTerrainDetail?: boolean;
          reorientationStrength?: number;
        };
        if (typeof data.presetIndex === "number") this.presetIndex = data.presetIndex;
        if (typeof data.nightBrightness === "number") this.nightBrightness = data.nightBrightness;
        if (typeof data.invertSelectionAreaResize === "boolean") this.invertSelectionAreaResize = data.invertSelectionAreaResize;
        if (typeof data.developerMode === "boolean") this.developerMode = data.developerMode;
        if (typeof data.showOrbitLines === "boolean") this.showOrbitLines = data.showOrbitLines;
        if (typeof data.showShipTrajectories === "boolean") this.showShipTrajectories = data.showShipTrajectories;
        if (typeof data.forceMaxTerrainDetail === "boolean") this.forceMaxTerrainDetail = data.forceMaxTerrainDetail;
        if (typeof data.reorientationStrength === "number") this.reorientationStrength = data.reorientationStrength;
      }
    } catch {
      // localStorage unavailable or corrupted - fall back to default silently.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          presetIndex: this.presetIndex,
          nightBrightness: this.nightBrightness,
          invertSelectionAreaResize: this.invertSelectionAreaResize,
          developerMode: this.developerMode,
          showOrbitLines: this.showOrbitLines,
          showShipTrajectories: this.showShipTrajectories,
          forceMaxTerrainDetail: this.forceMaxTerrainDetail,
          reorientationStrength: this.reorientationStrength,
        }),
      );
    } catch {
      // Best-effort persistence only.
    }
  }
}

export const graphicsSettings = new GraphicsSettings();
