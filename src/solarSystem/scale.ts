/**
 * Real Sol-system data (AU distances, Earth-relative radii) compressed into a navigable,
 * non-physically-accurate scale: real proportions would put Pluto ~40x farther from the sun
 * than Earth and Jupiter ~11x Earth's radius - both make an explorable single-session scene
 * impossible. Distances compress through a power curve; sizes come from a hand-picked table
 * with a much narrower range than reality.
 */

/** Scene units per compressed "AU" at Earth's distance (au=1 -> this many units from the star). */
export const EARTH_DISTANCE = 28000;
/** Scene-unit radius for an Earth-like body (matches the original single-planet PLANET_RADIUS). */
export const EARTH_RADIUS = 2000;
/** Scene-unit radius of the star itself - sized to look like a modest sun from Mercury's
 * orbit, not a wall filling the screen, at this compressed distance scale. */
export const STAR_RADIUS = 350;

/**
 * Compresses a real AU distance into scene units. Exponent < 1 keeps far bodies reachable.
 * Tuned (with the eccentricity table below) so no two neighboring orbits' radial bands -
 * [periapsis, apoapsis] plus both bodies' own radii - ever overlap, i.e. planets can never
 * physically collide even at worst-case orbital phase. Verified numerically (every adjacent
 * pair keeps a >500 unit margin) rather than derived analytically - see the plan notes.
 */
export function sceneDistance(au: number): number {
  return EARTH_DISTANCE * Math.pow(au, 0.65);
}

/** Single knob for "slow everything down further" requests - multiplies every period (both
 * orbit and axial spin) by 1/SPEED_MULTIPLIER, so 0.1 means "10x slower" ("slow by 90%"). */
const SPEED_MULTIPLIER = 0.1;

/** Compresses a real orbital period (Earth years) into scene seconds. Outer bodies still orbit slower than inner ones, just not by 100x+. */
export function orbitPeriodSeconds(earthYears: number): number {
  const EARTH_ORBIT_SECONDS = 1800; // 30 minutes for a full Earth year, per "slow down further, minutes not seconds"
  return (EARTH_ORBIT_SECONDS * Math.pow(earthYears, 0.55)) / SPEED_MULTIPLIER;
}

/** Applies the same global slowdown to a body's raw axial spin period. */
export function spinPeriodSeconds(def: BodyDef): number {
  return def.spinPeriodSeconds / SPEED_MULTIPLIER;
}

/** Applies the same global slowdown to a moon's raw orbit period (moonOrbitPeriodSeconds is
 * already in scene seconds directly, unlike orbitPeriodSeconds() which compresses real Earth
 * years - this just keeps it consistent with every other period in the system slowing
 * together under the one shared knob). */
export function moonOrbitPeriodSeconds(def: BodyDef): number {
  return (def.moonOrbitPeriodSeconds ?? 900) / SPEED_MULTIPLIER;
}

export type BodyKind = "rocky" | "dwarf" | "gasGiant" | "moon";

export interface BodyDef {
  name: string;
  kind: BodyKind;
  /** Real distance from the sun, astronomical units (mean, for eccentric orbits). Ignored
   * (use orbitsAround/moonOrbitRadiusInParentRadii instead) when this body orbits another
   * body rather than the star. */
  auDistance: number;
  /** Real orbital period, Earth years. Ignored (use moonOrbitPeriodSeconds instead) for a
   * body that orbits another body rather than the star. */
  orbitYears: number;
  /** Orbital eccentricity (0 = circle). */
  eccentricity: number;
  /** Radius relative to EARTH_RADIUS, hand-compressed (not real ratios) - this project's
   * deliberate "fun over accuracy" visual scale, e.g. gas giants are shrunk way down from
   * their real ~4-11x Earth radius so the whole system stays navigable. */
  relativeRadius: number;
  /** Real diameter relative to Earth = 1.0 (e.g. Jupiter's real 11.2), NOT compressed - used
   * only to scale each body's terrain/texture map resolution proportionally to its actual
   * physical size, independent of the compressed in-game `relativeRadius`. */
  realDiameterRatio: number;
  /** Axial spin period, scene seconds - independent of orbit, tuned for a visible day/night cycle. */
  spinPeriodSeconds: number;
  /** Seed for procedural terrain (rocky/dwarf bodies only, and only as a fallback where no real
   * heightmap is loaded - see heightmapSources.ts). */
  seed: number;
  /** Starting atmosphere level, 0-1 (static demo value - see terrainMaterial.ts, Phase 5). */
  atmosphereLevel: number;
  /** Spins opposite to the others - astronomically correct for Venus (and Uranus, though its
   * defining quirk is really its ~98° axial tilt rather than direction). */
  retrograde?: boolean;
  /** Name of another BODY_DEFS entry this one orbits instead of the star (moons only) - see
   * MOON_DEFS/SolarSystem, which builds these in a second pass once their parent exists, then
   * reparents their CelestialOrbit.orbitNode to the parent's orbitNode so the moon's own
   * origin-focused ellipse math is automatically carried along with wherever the parent
   * currently is, for free, via ordinary scene-graph composition. */
  orbitsAround?: string;
  /** Orbit distance from the parent body's center, in units of the PARENT's own scene-unit
   * radius (not AU) - only used when `orbitsAround` is set. */
  moonOrbitRadiusInParentRadii?: number;
  /** Orbit period, scene seconds directly (not run through orbitPeriodSeconds()'s AU-based
   * compression curve, which is tuned for star-relative distances) - only used when
   * `orbitsAround` is set. */
  moonOrbitPeriodSeconds?: number;
}

// Eccentricities are capped well below their real values (e.g. real Mercury=0.21, Pluto=0.25,
// Eris=0.44) - at real eccentricity, several pairs' orbital ranges (particularly the crossing
// Neptune/Pluto/Eris trio, which only avoid colliding in reality via orbital resonance we
// don't simulate) overlap once combined with each body's own radius. Capping at 0.02 keeps
// every body's radial range tight around its semi-major axis so neighbors never collide.
export const BODY_DEFS: readonly BodyDef[] = [
  { name: "Mercury", kind: "rocky", auDistance: 0.39, orbitYears: 0.24, eccentricity: 0.02, relativeRadius: 0.45, realDiameterRatio: 0.38, spinPeriodSeconds: 150, seed: 101, atmosphereLevel: 0 },
  { name: "Venus", kind: "rocky", auDistance: 0.72, orbitYears: 0.62, eccentricity: 0.01, relativeRadius: 0.9, realDiameterRatio: 0.95, spinPeriodSeconds: 260, seed: 102, atmosphereLevel: 0.15, retrograde: true },
  { name: "Earth", kind: "rocky", auDistance: 1.0, orbitYears: 1.0, eccentricity: 0.02, relativeRadius: 1.0, realDiameterRatio: 1.0, spinPeriodSeconds: 200, seed: 1337, atmosphereLevel: 0.4 },
  // moonOrbitRadiusInParentRadii is 2 here, not the real ~9-60x - this scene's interplanetary
  // distances are compressed through sceneDistance()'s power curve while EARTH_RADIUS itself
  // is NOT compressed by that same factor (planets are drawn much bigger relative to their
  // orbital spacing than reality, a deliberate "fun over accuracy" choice - see sceneDistance's
  // doc comment). At the real-ish value of 9, the Moon's orbit around Earth (radius 9*2000=18000
  // units) came out bigger than Mercury's entire orbit around the sun (radius ~15184 units) -
  // obviously wrong once both are drawn as orbit lines in the same scene. 2x (4000 units) keeps
  // the Moon's near/far points comfortably inside the Earth-Venus/Earth-Mars gaps instead.
  { name: "Moon", kind: "moon", auDistance: 0, orbitYears: 0, eccentricity: 0.02, relativeRadius: 0.27, realDiameterRatio: 0.27, spinPeriodSeconds: 240, seed: 1338, atmosphereLevel: 0, orbitsAround: "Earth", moonOrbitRadiusInParentRadii: 2, moonOrbitPeriodSeconds: 900 },
  { name: "Mars", kind: "rocky", auDistance: 1.52, orbitYears: 1.88, eccentricity: 0.02, relativeRadius: 0.55, realDiameterRatio: 0.53, spinPeriodSeconds: 210, seed: 103, atmosphereLevel: 0.05 },
  { name: "Jupiter", kind: "gasGiant", auDistance: 5.2, orbitYears: 11.9, eccentricity: 0.02, relativeRadius: 4.0, realDiameterRatio: 11.2, spinPeriodSeconds: 90, seed: 104, atmosphereLevel: 0 },
  { name: "Saturn", kind: "gasGiant", auDistance: 9.5, orbitYears: 29.4, eccentricity: 0.02, relativeRadius: 3.5, realDiameterRatio: 9.45, spinPeriodSeconds: 95, seed: 105, atmosphereLevel: 0 },
  { name: "Uranus", kind: "gasGiant", auDistance: 19.2, orbitYears: 84.0, eccentricity: 0.02, relativeRadius: 2.6, realDiameterRatio: 4.01, spinPeriodSeconds: 130, seed: 106, atmosphereLevel: 0 },
  { name: "Neptune", kind: "gasGiant", auDistance: 30.1, orbitYears: 164.8, eccentricity: 0.01, relativeRadius: 2.5, realDiameterRatio: 3.88, spinPeriodSeconds: 135, seed: 107, atmosphereLevel: 0 },
  { name: "Pluto", kind: "dwarf", auDistance: 39.5, orbitYears: 248.0, eccentricity: 0.02, relativeRadius: 0.3, realDiameterRatio: 0.19, spinPeriodSeconds: 300, seed: 108, atmosphereLevel: 0 },
  { name: "Eris", kind: "dwarf", auDistance: 68.0, orbitYears: 559.0, eccentricity: 0.02, relativeRadius: 0.28, realDiameterRatio: 0.18, spinPeriodSeconds: 320, seed: 109, atmosphereLevel: 0 },
];

export function bodyRadius(def: BodyDef): number {
  return EARTH_RADIUS * def.relativeRadius;
}

export interface HeightmapSource {
  /** Path under public/, served as a static asset (see vite's public/ convention). */
  url: string;
  /** Pixel width of the actual downloaded source file - used only to keep
   * sharedHeightmapDensity() honest (never claim more detail than a body's real source has). */
  sourceWidth: number;
  /** Floor (0-255) applied to every sampled pixel before it's mapped to elevation - softens a
   * real data-gap artifact (Venus's Magellan radar mosaic has unmapped polar streaks rendered
   * as pure black) into "low terrain" instead of a fake bottomless canyon. Omit for a source
   * with full real coverage. */
  minSample?: number;
}

/** Real, downloaded elevation maps for the landable rocky bodies + Moon (see
 * public/heightmaps/ and the research notes for provenance/license per file - all USGS
 * Astrogeology / NASA-derived, public domain). Gas giants have no solid surface and Pluto/Eris
 * have no complete real global elevation dataset, so those bodies keep PlanetHeightfield's
 * procedural fallback. */
export const HEIGHTMAP_SOURCES: Partial<Record<string, HeightmapSource>> = {
  Mercury: { url: "/heightmaps/mercury_source.jpg", sourceWidth: 1024 },
  Venus: { url: "/heightmaps/venus_source.jpg", sourceWidth: 1024, minSample: 40 },
  Earth: { url: "/heightmaps/earth_source.png", sourceWidth: 2160 },
  Moon: { url: "/heightmaps/moon_source.jpg", sourceWidth: 1024 },
  Mars: { url: "/heightmaps/mars_source.jpg", sourceWidth: 1024 },
};

/**
 * Shared "pixels per Earth-diameter-unit" density, applied to every body's terrain heightmap
 * AND gas giant texture via textureResolutionFor() - so every body's map resolution is
 * honestly proportional to its REAL physical size (realDiameterRatio), not the compressed
 * in-game visual size, and not an arbitrary fixed resolution picked independent of what's
 * actually available.
 *
 * Derived from whichever real heightmap source is the most resolution-constrained relative to
 * its own real size - naively scaling every body up from Earth's own (very good, 2160px)
 * source would upscale fake detail into Venus, whose real source photo is only 1024px despite
 * being nearly Earth-sized (0.95x diameter). Taking the minimum of (sourceWidth / diameterRatio)
 * across every real source guarantees no body is ever upscaled past what its own source
 * actually offers.
 */
function computeSharedHeightmapDensity(): number {
  let density = Infinity;
  for (const def of BODY_DEFS) {
    const source = HEIGHTMAP_SOURCES[def.name];
    if (!source) continue;
    density = Math.min(density, source.sourceWidth / def.realDiameterRatio);
  }
  return density;
}

export const SHARED_HEIGHTMAP_DENSITY = computeSharedHeightmapDensity();

/** Target width/height (2:1 equirectangular) for a body's terrain heightmap (if it has a real
 * HEIGHTMAP_SOURCES entry) or gas-giant color texture, proportional to its real diameter ratio
 * via SHARED_HEIGHTMAP_DENSITY - e.g. Jupiter (11.2x Earth's real diameter) intentionally gets
 * a texture 11.2x Earth's linear resolution. Clamped to the GPU's actual max texture size so
 * that doesn't produce an unusably large or unsupported texture on real hardware. */
export function textureResolutionFor(def: BodyDef, maxDimension = 8192): { width: number; height: number } {
  const rawWidth = SHARED_HEIGHTMAP_DENSITY * def.realDiameterRatio;
  const width = Math.max(64, Math.min(maxDimension, Math.round(rawWidth / 2) * 2));
  return { width, height: width / 2 };
}
