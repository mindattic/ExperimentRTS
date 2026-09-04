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

/** Compresses a real orbital period (Earth years) into scene seconds. Outer bodies still orbit slower than inner ones, just not by 100x+. */
export function orbitPeriodSeconds(earthYears: number): number {
  const EARTH_ORBIT_SECONDS = 1800; // 30 minutes for a full Earth year, per "slow down further, minutes not seconds"
  return EARTH_ORBIT_SECONDS * Math.pow(earthYears, 0.55);
}

export type BodyKind = "rocky" | "dwarf" | "gasGiant";

export interface BodyDef {
  name: string;
  kind: BodyKind;
  /** Real distance from the sun, astronomical units (mean, for eccentric orbits). */
  auDistance: number;
  /** Real orbital period, Earth years. */
  orbitYears: number;
  /** Orbital eccentricity (0 = circle). */
  eccentricity: number;
  /** Radius relative to EARTH_RADIUS, hand-compressed (not real ratios). */
  relativeRadius: number;
  /** Axial spin period, scene seconds - independent of orbit, tuned for a visible day/night cycle. */
  spinPeriodSeconds: number;
  /** Seed for procedural terrain (rocky/dwarf bodies only). */
  seed: number;
  /** Starting atmosphere level, 0-1 (static demo value - see terrainMaterial.ts, Phase 5). */
  atmosphereLevel: number;
  /** Spins opposite to the others - astronomically correct for Venus (and Uranus, though its
   * defining quirk is really its ~98° axial tilt rather than direction). */
  retrograde?: boolean;
}

// Eccentricities are capped well below their real values (e.g. real Mercury=0.21, Pluto=0.25,
// Eris=0.44) - at real eccentricity, several pairs' orbital ranges (particularly the crossing
// Neptune/Pluto/Eris trio, which only avoid colliding in reality via orbital resonance we
// don't simulate) overlap once combined with each body's own radius. Capping at 0.02 keeps
// every body's radial range tight around its semi-major axis so neighbors never collide.
export const BODY_DEFS: readonly BodyDef[] = [
  { name: "Mercury", kind: "rocky", auDistance: 0.39, orbitYears: 0.24, eccentricity: 0.02, relativeRadius: 0.45, spinPeriodSeconds: 150, seed: 101, atmosphereLevel: 0 },
  { name: "Venus", kind: "rocky", auDistance: 0.72, orbitYears: 0.62, eccentricity: 0.01, relativeRadius: 0.9, spinPeriodSeconds: 260, seed: 102, atmosphereLevel: 0.15, retrograde: true },
  { name: "Earth", kind: "rocky", auDistance: 1.0, orbitYears: 1.0, eccentricity: 0.02, relativeRadius: 1.0, spinPeriodSeconds: 200, seed: 1337, atmosphereLevel: 0.4 },
  { name: "Mars", kind: "rocky", auDistance: 1.52, orbitYears: 1.88, eccentricity: 0.02, relativeRadius: 0.55, spinPeriodSeconds: 210, seed: 103, atmosphereLevel: 0.05 },
  { name: "Jupiter", kind: "gasGiant", auDistance: 5.2, orbitYears: 11.9, eccentricity: 0.02, relativeRadius: 4.0, spinPeriodSeconds: 90, seed: 104, atmosphereLevel: 0 },
  { name: "Saturn", kind: "gasGiant", auDistance: 9.5, orbitYears: 29.4, eccentricity: 0.02, relativeRadius: 3.5, spinPeriodSeconds: 95, seed: 105, atmosphereLevel: 0 },
  { name: "Uranus", kind: "gasGiant", auDistance: 19.2, orbitYears: 84.0, eccentricity: 0.02, relativeRadius: 2.6, spinPeriodSeconds: 130, seed: 106, atmosphereLevel: 0 },
  { name: "Neptune", kind: "gasGiant", auDistance: 30.1, orbitYears: 164.8, eccentricity: 0.01, relativeRadius: 2.5, spinPeriodSeconds: 135, seed: 107, atmosphereLevel: 0 },
  { name: "Pluto", kind: "dwarf", auDistance: 39.5, orbitYears: 248.0, eccentricity: 0.02, relativeRadius: 0.3, spinPeriodSeconds: 300, seed: 108, atmosphereLevel: 0 },
  { name: "Eris", kind: "dwarf", auDistance: 68.0, orbitYears: 559.0, eccentricity: 0.02, relativeRadius: 0.28, spinPeriodSeconds: 320, seed: 109, atmosphereLevel: 0 },
];

export function bodyRadius(def: BodyDef): number {
  return EARTH_RADIUS * def.relativeRadius;
}
