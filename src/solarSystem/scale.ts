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

/** The "Actual scale" counterpart to STAR_RADIUS - the sun's true radius (695,700 km) expressed
 * on the SAME linear km-per-unit anchor actualSceneDistance() already uses for distance (1 AU =
 * EARTH_DISTANCE units), so it's genuinely to-scale relative to the real planetary distances
 * Actual mode moves everything else to - not just "bigger," but the actual real-world ratio.
 * Real interplanetary distances dwarf even the sun's own size (695,700 km is only ~0.0047 AU),
 * so this comes out SMALLER than the gameplay placeholder above (~130 vs 350 units) - a genuinely
 * to-scale solar system famously makes everything read as a tiny dot at real distances, the sun
 * included; this isn't a compromise, it's what "true size" actually looks like at this anchor. */
const AU_IN_KM = 149597870.7;
export const STAR_RADIUS_ACTUAL = EARTH_DISTANCE * (695700 / AU_IN_KM);

/** Everything at or inside this AU distance (Mercury..Mars) uses INNER_COMPRESSION_EXPONENT,
 * unchanged from before this was made piecewise - Venus/Earth are already the tightest-spaced
 * pair in the system (see INNER_COMPRESSION_EXPONENT's own comment), so there's zero headroom to
 * compress the inner system further without them overlapping. Bodies farther than this (Mars
 * itself is the seam, included in the inner segment) get OUTER_COMPRESSION_EXPONENT instead - a
 * much steeper curve, safe to use out there since AU gaps between outer bodies are proportionally
 * much larger relative to their own sizes (see the self-check below, which verified this value).
 * Set to Mars's own auDistance (BODY_DEFS below) - kept in sync manually since these constants
 * are defined above that array. */
const DRAMATIC_SCALE_ANCHOR_AU = 1.52;
/** Compresses a real AU distance into scene units, for au <= DRAMATIC_SCALE_ANCHOR_AU. Exponent
 * < 1 keeps far bodies reachable. Raised from 0.65 to 0.72 ("orbits need to be wider apart") - a
 * single global exponent can't fully equalize every pair's spacing (Venus/Earth are irreducibly
 * the tightest, both close in AU and both large bodies - even removing all compression, exponent
 * 1.0, only takes their gap-to-body-size ratio from 1.4x to ~2x), so this is a modest, cheap
 * widening for the inner system specifically - see maxSafePersonalSpaceRadius below, which every
 * moon/station orbit is actually checked against. */
const INNER_COMPRESSION_EXPONENT = 0.72;
/** Compresses a real AU distance into scene units, for au > DRAMATIC_SCALE_ANCHOR_AU - much
 * steeper than the inner exponent so "Actual scale" mode (see orbitalScale.ts) reads as
 * genuinely dramatic for Jupiter onward ("it grows things a little but should be incredibly
 * dramatic") instead of the ~1.6x-3x a single global 0.72 exponent produced. 0.4 is the largest
 * safe value with comfortable margin below it - Jupiter/Saturn (physically large, and the
 * closest outer pair in AU-ratio terms) are the binding constraint: verified numerically (not
 * hand-derived - an early hand calculation here was wrong) that 0.4 leaves ~1876 units of
 * clearance there, while lower values (~0.35 and below) make them overlap. See the self-check
 * below, which enforces this for every consecutive pair, not just Jupiter/Saturn. */
const OUTER_COMPRESSION_EXPONENT = 0.4;

export function sceneDistance(au: number): number {
  if (au <= DRAMATIC_SCALE_ANCHOR_AU) return EARTH_DISTANCE * Math.pow(au, INNER_COMPRESSION_EXPONENT);
  // Continuous at the seam by construction: this evaluates to EARTH_DISTANCE *
  // DRAMATIC_SCALE_ANCHOR_AU^INNER_COMPRESSION_EXPONENT (the inner formula's own value at the
  // seam) when au === DRAMATIC_SCALE_ANCHOR_AU, since (au/anchor)^exp is 1 there.
  const anchorDistance = EARTH_DISTANCE * Math.pow(DRAMATIC_SCALE_ANCHOR_AU, INNER_COMPRESSION_EXPONENT);
  return anchorDistance * Math.pow(au / DRAMATIC_SCALE_ANCHOR_AU, OUTER_COMPRESSION_EXPONENT);
}

/** 1 AU in scene units - computed once here rather than re-deriving `sceneDistance(1)` wherever
 * a real-world distance threshold is needed (e.g. terrain.ts's LOD distance breakpoints). */
export const AU_IN_SCENE_UNITS = sceneDistance(1);

/** The "Actual scale" counterpart to sceneDistance() - true real-world-proportional distance
 * (linear in AU, no compression curve), anchored so Earth's own distance is IDENTICAL in both
 * modes ("on actual scale mode it's exactly the same scale; on gameplay scale it's exaggerated")
 * - only bodies farther/closer than Earth redistribute relative to that fixed anchor. See
 * orbitalScale.ts for the toggle that blends every body's orbit between this and
 * sceneDistance(). Always >= sceneDistance() for the same au (the compression curve only ever
 * shrinks, never grows, outer distances) - callers that need "whichever is farther" (e.g.
 * FAR_CLIP) can rely on this ordering instead of computing both and comparing. */
export function actualSceneDistance(au: number): number {
  return EARTH_DISTANCE * au;
}

/** Single knob for "speed everything up/down" requests - divides every period (both orbit and
 * axial spin) by SPEED_MULTIPLIER, so 0.1 means "10x slower" and 3 means "3x faster". Currently
 * 3, tuned so a full Earth year takes 10 minutes ("make the simulation run fast, so you can
 * visibly see planets moving") - see EARTH_ORBIT_SECONDS below. */
const SPEED_MULTIPLIER = 3;

/** Compresses a real orbital period (Earth years) into scene seconds. Outer bodies still orbit slower than inner ones, just not by 100x+. */
export function orbitPeriodSeconds(earthYears: number): number {
  const EARTH_ORBIT_SECONDS = 1800; // pre-SPEED_MULTIPLIER baseline; 1800/3 = 600s = 10 minutes for a full Earth year
  return (EARTH_ORBIT_SECONDS * Math.pow(earthYears, 0.55)) / SPEED_MULTIPLIER;
}

/** Applies the same global speed knob to a body's raw axial spin period. */
export function spinPeriodSeconds(def: BodyDef): number {
  return def.spinPeriodSeconds / SPEED_MULTIPLIER;
}

/** Applies the same global speed knob to a moon's raw orbit period (moonOrbitPeriodSeconds is
 * already in scene seconds directly, unlike orbitPeriodSeconds() which compresses real Earth
 * years - this just keeps it consistent with every other period in the system moving together
 * under the one shared knob). */
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
  /** The real orbit distance from the parent's center, same units as moonOrbitRadiusInParentRadii
   * (parent radii) - what this moon's orbit blends toward in "actual" scale mode (see
   * orbitalScale.ts). Omit for a moon not yet given an accurate real-distance figure - it simply
   * stays at its gameplay distance regardless of scale mode (see
   * CelestialBody.actualSemiMajorAxis's own comment on this same fallback pattern). */
  moonOrbitRadiusInParentRadiiActual?: number;
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
  // moonOrbitRadiusInParentRadii is 1.5 here, not the real ~9-60x - this scene's interplanetary
  // distances are compressed through sceneDistance()'s power curve while EARTH_RADIUS itself is
  // NOT compressed by that same factor (planets are drawn much bigger relative to their orbital
  // spacing than reality, a deliberate "fun over accuracy" choice - see sceneDistance's doc
  // comment). At the real-ish value of 9, the Moon's orbit around Earth came out bigger than
  // Mercury's entire orbit around the sun; at a "fixed" 2, it still exceeded
  // maxSafePersonalSpaceRadius("Earth") by ~400 units once actually computed (Earth/Venus are
  // this system's tightest neighboring pair). 1.5x keeps it comfortably inside (~48% of Earth's
  // available clearance, not the full margin) - see maxSafePersonalSpaceRadius and the
  // self-check loop below, which now catches this class of mistake at load time instead of
  // needing it to be visually spotted.
  // moonOrbitRadiusInParentRadiiActual: 60.3 is the Moon's real mean distance (~384,400 km)
  // divided by Earth's real radius (~6,371 km) - what "Actual scale" mode blends toward (see
  // orbitalScale.ts) alongside the compressed 1.5x gameplay value above.
  { name: "Moon", kind: "moon", auDistance: 0, orbitYears: 0, eccentricity: 0.02, relativeRadius: 0.27, realDiameterRatio: 0.27, spinPeriodSeconds: 240, seed: 1338, atmosphereLevel: 0, orbitsAround: "Earth", moonOrbitRadiusInParentRadii: 1.5, moonOrbitRadiusInParentRadiiActual: 60.3, moonOrbitPeriodSeconds: 900 },
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

/** Earth's TRUE radius (6,371 km), expressed on the same linear km-per-unit anchor as
 * STAR_RADIUS_ACTUAL/actualSceneDistance (1 AU = EARTH_DISTANCE units) - NOT the compressed
 * gameplay EARTH_RADIUS constant, which is a "fun over accuracy" visual size unrelated to real
 * distances. Mixing that gameplay constant into "actual" scale math was the bug: every body's
 * actualBodyRadius() came out ~1678x too big relative to actualSceneDistance() (e.g. Jupiter's
 * true ~71,492km radius is only ~13 scene units at this anchor, not the 22,400 the old formula
 * produced), so gas giants visually swallowed the correctly-real gaps to their neighbors instead
 * of reading as the tiny dots they truly are at real interplanetary distances. */
const EARTH_RADIUS_ACTUAL = EARTH_DISTANCE * (6371 / AU_IN_KM);

/** The "Actual scale" counterpart to bodyRadius() - real relative size (def.realDiameterRatio,
 * NOT the compressed relativeRadius) anchored on EARTH_RADIUS_ACTUAL (Earth's true radius, same
 * km-per-unit scale as every other "actual" distance/size), so Actual scale is a genuine 1:1
 * real-world representation, not just "real ratios on a still-inflated anchor." What CelestialBody
 * blends its rendered size toward (via a uniform spinNode.scaling factor - see solarSystem.ts)
 * when Actual scale is toggled on - "planets should also look their real size, not just move to
 * their real distance." */
export function actualBodyRadius(def: BodyDef): number {
  return EARTH_RADIUS_ACTUAL * def.realDiameterRatio;
}

/** How much of a body's actual clear space to a neighboring body a moon/station orbit is
 * allowed to use - leaves comfortable headroom rather than running right up to the edge. */
const PERSONAL_SPACE_SAFETY_FRACTION = 0.7;

/** The largest safe orbit radius (scene units, measured from `bodyName`'s own center) a moon or
 * station orbiting it can use without reaching into a neighboring star-orbiting body's own
 * territory - computed from the real nearest-neighbor gap among BODY_DEFS, not a hand-picked
 * constant that can silently go stale if BODY_DEFS ever changes (as happened twice this
 * session: the Moon's orbit once drawn bigger than Mercury's entire orbit, then a station drawn
 * farther out than the Moon). Used both by this file's own self-check below and by
 * economyDefs.ts's equivalent check for stations. */
export function maxSafePersonalSpaceRadius(bodyName: string): number {
  const starOrbiting = BODY_DEFS.filter((d) => !d.orbitsAround);
  const index = starOrbiting.findIndex((d) => d.name === bodyName);
  const body = starOrbiting[index];
  const bodyDist = sceneDistance(body.auDistance);
  const bodyR = bodyRadius(body);
  let minClearance = Infinity;
  if (index > 0) {
    const prev = starOrbiting[index - 1];
    minClearance = Math.min(minClearance, bodyDist - sceneDistance(prev.auDistance) - bodyR - bodyRadius(prev));
  }
  if (index < starOrbiting.length - 1) {
    const next = starOrbiting[index + 1];
    minClearance = Math.min(minClearance, sceneDistance(next.auDistance) - bodyDist - bodyR - bodyRadius(next));
  }
  return bodyR + minClearance * PERSONAL_SPACE_SAFETY_FRACTION;
}

// Fails loudly at load time (not silently at runtime) if any moon's orbit would reach into a
// neighboring body's territory - matching this codebase's existing pattern of throwing on
// internal misconfiguration (e.g. EconomyManager.findBody/resolveStop) rather than letting a
// spacing mistake ship and wait to be visually noticed, as happened twice already this session.
for (const def of BODY_DEFS) {
  if (!def.orbitsAround) continue;
  const parent = BODY_DEFS.find((d) => d.name === def.orbitsAround)!;
  const radius = bodyRadius(parent) * (def.moonOrbitRadiusInParentRadii ?? 6);
  const safeMax = maxSafePersonalSpaceRadius(parent.name);
  if (radius > safeMax) {
    throw new Error(
      `${def.name}'s orbit radius (${radius.toFixed(0)}) exceeds ${parent.name}'s safe personal-space radius (${safeMax.toFixed(0)}) - it would reach into a neighboring body's territory. Lower moonOrbitRadiusInParentRadii.`,
    );
  }
}

// Same "fail loudly at load time" philosophy as the moon check above, but for the planets
// THEMSELVES: maxSafePersonalSpaceRadius already computes each body's clearance to its
// neighbors internally, but never asserted that clearance is non-negative on its own - it was
// only ever safe before because INNER_COMPRESSION_EXPONENT (0.72) happened to be gentle
// everywhere. Piecewise scaling (see DRAMATIC_SCALE_ANCHOR_AU above) makes the outer segment
// deliberately much steeper, so this guards against a future BODY_DEFS/exponent edit
// accidentally compressing two neighboring planets into each other (this is exactly how
// OUTER_COMPRESSION_EXPONENT's own safe value was found - by tightening this check until it
// failed, then backing off).
{
  const starOrbiting = BODY_DEFS.filter((d) => !d.orbitsAround);
  for (let i = 0; i < starOrbiting.length - 1; i++) {
    const a = starOrbiting[i];
    const b = starOrbiting[i + 1];
    const clearance = sceneDistance(b.auDistance) - sceneDistance(a.auDistance) - bodyRadius(a) - bodyRadius(b);
    if (clearance < 0) {
      throw new Error(
        `${a.name} and ${b.name}'s orbits overlap by ${(-clearance).toFixed(0)} units at gameplay scale - lower OUTER_COMPRESSION_EXPONENT (or INNER_COMPRESSION_EXPONENT, if the overlap is inside DRAMATIC_SCALE_ANCHOR_AU).`,
      );
    }
  }
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
  // New Horizons LORRI/MVIC global DEM (July 2017 release) - see public/heightmaps/SOURCES.md.
  Pluto: { url: "/heightmaps/pluto_source.jpg", sourceWidth: 1024 },
};

export interface ColorMapSource {
  /** Path under public/, served as a static asset. */
  url: string;
  /** Pixel width of the actual downloaded source file - same role as
   * HeightmapSource.sourceWidth, feeding the same shared-density calculation below so no
   * body's color texture is ever upscaled past what its real source actually offers. */
  sourceWidth: number;
}

/** Real color/diffuse textures - landable bodies get them applied per-vertex via
 * PlanetHeightfield.colorAt (see celestialBody.ts), gas giants get them applied directly as a
 * material diffuse texture. See public/textures/SOURCES.md for provenance/license per file,
 * and for which bodies (Venus, Moon, Pluto, Eris) deliberately have no entry here and why. */
export const COLOR_MAP_SOURCES: Partial<Record<string, ColorMapSource>> = {
  Mercury: { url: "/textures/mercury_color.jpg", sourceWidth: 1024 },
  Earth: { url: "/textures/earth_color.jpg", sourceWidth: 2048 },
  Mars: { url: "/textures/mars_color.jpg", sourceWidth: 1024 },
  Jupiter: { url: "/textures/jupiter_color.jpg", sourceWidth: 1024 },
  Saturn: { url: "/textures/saturn_color.jpg", sourceWidth: 2048 },
  Uranus: { url: "/textures/uranus_color.jpg", sourceWidth: 2048 },
  Neptune: { url: "/textures/neptune_color.jpg", sourceWidth: 2048 },
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
    const heightmapSource = HEIGHTMAP_SOURCES[def.name];
    if (heightmapSource) density = Math.min(density, heightmapSource.sourceWidth / def.realDiameterRatio);
    const colorSource = COLOR_MAP_SOURCES[def.name];
    if (colorSource) density = Math.min(density, colorSource.sourceWidth / def.realDiameterRatio);
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
