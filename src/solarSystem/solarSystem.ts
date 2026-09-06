import { Color3, DirectionalLight, type LinesMesh, Scene, Vector3 } from "@babylonjs/core";
import { graphicsSettings } from "../settings/graphicsSettings";
import { Star } from "../environment/star";
import { Starfield } from "../environment/starfield";
import { CelestialBody } from "./celestialBody";
import { AsteroidBelt } from "./asteroidBelt";
import { BODY_DEFS, COLOR_MAP_SOURCES, sceneDistance, actualSceneDistance, orbitPeriodSeconds, spinPeriodSeconds, moonOrbitPeriodSeconds, STAR_RADIUS, STAR_RADIUS_ACTUAL } from "./scale";
import { orbitalScale } from "./orbitalScale";
import { mulberry32 } from "../terrain/prng";
import type { ColorImageData, HeightmapImageData } from "../terrain/heightmapImage";

const tmpSunDirection = new Vector3();

function jitteredAxis(base: Vector3, rand: () => number, spread: number): Vector3 {
  const jitter = new Vector3((rand() - 0.5) * spread, 0, (rand() - 0.5) * spread);
  return base.add(jitter).normalize();
}

/** Deterministic per-body orbit-line color, keyed off the body's own procedural-terrain seed
 * (already a unique per-body number) so every orbit reads as visually distinct rather than one
 * indistinguishable gray loop for the whole system - full saturation/value, only hue varies.
 * Exported so other per-body UI (e.g. OffscreenIndicatorUI's arrows) can match a body's own
 * orbit line color exactly, not just look similar. */
export function orbitLineColorFor(seed: number): Color3 {
  const hue = mulberry32(seed * 7919 + 13)() * 360;
  return Color3.FromHSV(hue, 0.55, 0.95);
}

/** Owns the star, every CelestialBody, the decorative asteroid belt, and the background starfield. */
export class SolarSystem {
  readonly star: Star;
  readonly bodies: CelestialBody[];
  readonly belt: AsteroidBelt;
  focusedIndex: number;
  /** The CelestialOrbit each line was drawn from, and the gameplay-scale semi-major axis it was
   * drawn AT (a fixed one-time mesh, never rebuilt) - so SolarSystem.update can keep it visually
   * attached to its body by applying a uniform mesh.scaling = currentSMA/gameplaySMA every frame
   * instead of regenerating geometry. currentRatio tracks the last-applied scale so update() can
   * skip the (Babylon-dirtying) write when nothing's actually changed, the same way
   * AsteroidBelt.setRadii already no-ops when unchanged. */
  private readonly orbitLines: {
    mesh: LinesMesh;
    gameplaySemiMajorAxis: number;
    getCurrentSemiMajorAxis: () => number;
    currentRatio: number;
  }[] = [];
  /** Belt inner/outer are re-derived every frame from Mars/Jupiter's own LIVE (possibly
   * orbitalScale-blended) semi-major axis - same 1.3x/0.8x factors used to compute them once at
   * construction below, just re-evaluated continuously so the belt stretches/compresses along
   * with Mars and Jupiter instead of staying frozen at gameplay scale (see AsteroidBelt.setRadii's
   * own comment for why a uniform mesh-scale trick isn't used here, unlike orbit lines). */
  private readonly beltMars: CelestialBody;
  private readonly beltJupiter: CelestialBody;
  private currentStarRadius = STAR_RADIUS;
  /** Last blend value the size pass below applied - lets it skip re-writing every body's
   * spinNode.scaling when blend hasn't moved (most frames, once a transition finishes), same
   * no-op-guard idea as the orbit-line scaling loop just above it. Sentinel -1 so the very first
   * update() always applies (blend's real range is 0..1). */
  private currentSizeBlend = -1;

  /** @param farClip Camera far-clip distance (see main.ts) - the starfield sits just inside it,
   * as close to "fixed at infinity" as the clipping range allows.
   * @param colorImages Preloaded real color/diffuse maps for landable bodies (see
   * COLOR_MAP_SOURCES/preloadColorMaps) - gas giants' real color textures are looked up
   * directly from COLOR_MAP_SOURCES by URL below instead, since they're loaded as a plain GPU
   * Texture rather than CPU-decoded pixel data (see CelestialBody's constructor doc comment). */
  constructor(
    scene: Scene,
    farClip: number,
    heightmapImages: Partial<Record<string, HeightmapImageData>> = {},
    colorImages: Partial<Record<string, ColorImageData>> = {},
  ) {
    this.star = new Star(scene, STAR_RADIUS);
    new Starfield(scene, farClip * 0.95);

    const rand = mulberry32(777);
    const baseOrbitAxis = new Vector3(0.12, 0.98, 0.15).normalize();
    const baseSpinAxis = new Vector3(0.15, 0.97, -0.18).normalize();

    // Two passes: bodies orbiting the star directly, then bodies orbiting another body (moons -
    // see BodyDef.orbitsAround) once their parent already exists, so their orbitNode can be
    // reparented to it. That reparenting is the whole trick: CelestialOrbit's ellipse math
    // (origin-focused, in positionAt()) doesn't need to know anything about moons at all - once
    // its orbitNode's parent is the planet's own orbitNode instead of the scene root, ordinary
    // scene-graph composition carries the moon's small local ellipse along with wherever the
    // planet currently is, for free.
    const starOrbitingDefs = BODY_DEFS.filter((def) => !def.orbitsAround);
    const moonDefs = BODY_DEFS.filter((def) => def.orbitsAround);

    this.bodies = starOrbitingDefs.map((def, index) => {
      const gameplaySemiMajorAxis = sceneDistance(def.auDistance);
      const body = new CelestialBody(
        scene,
        def,
        {
          name: def.name,
          semiMajorAxis: gameplaySemiMajorAxis,
          eccentricity: def.eccentricity,
          orbitPeriodSeconds: orbitPeriodSeconds(def.orbitYears),
          orbitAxis: jitteredAxis(baseOrbitAxis, rand, 0.06),
          spinPeriodSeconds: def.retrograde ? -spinPeriodSeconds(def) : spinPeriodSeconds(def),
          spinAxis: jitteredAxis(baseSpinAxis, rand, 0.15),
          startAngle: (index / starOrbitingDefs.length) * Math.PI * 2 + rand() * 0.5,
        },
        {
          heightmapImage: heightmapImages[def.name],
          actualSemiMajorAxis: actualSceneDistance(def.auDistance),
          colorImage: colorImages[def.name],
          gasGiantColorTextureUrl: COLOR_MAP_SOURCES[def.name]?.url,
        },
      );
      const line = body.orbit.createOrbitLine(scene, `${def.name}OrbitLine`, orbitLineColorFor(def.seed));
      this.orbitLines.push({ mesh: line, gameplaySemiMajorAxis, getCurrentSemiMajorAxis: () => body.orbit.semiMajorAxis, currentRatio: 1 });
      return body;
    });

    for (const def of moonDefs) {
      const parent = this.bodies.find((b) => b.def.name === def.orbitsAround);
      if (!parent) continue; // BODY_DEFS is static and self-consistent - shouldn't happen
      const gameplaySemiMajorAxis = parent.radius * (def.moonOrbitRadiusInParentRadii ?? 6);
      // parent.actualRadius (the parent's TRUE real-world radius), not parent.radius (its
      // compressed gameplay radius) - moonOrbitRadiusInParentRadiiActual is a real-world ratio
      // (real distance / real parent radius), so it must be anchored on the parent's own real
      // radius to land on the same genuinely-1:1 scale actualSceneDistance() uses for planets
      // (see EARTH_RADIUS_ACTUAL's comment in scale.ts for why the gameplay radius was wrong here).
      const actualSemiMajorAxis = def.moonOrbitRadiusInParentRadiiActual
        ? parent.actualRadius * def.moonOrbitRadiusInParentRadiiActual
        : gameplaySemiMajorAxis;
      const moon = new CelestialBody(
        scene,
        def,
        {
          name: def.name,
          semiMajorAxis: gameplaySemiMajorAxis,
          eccentricity: def.eccentricity,
          orbitPeriodSeconds: moonOrbitPeriodSeconds(def),
          orbitAxis: jitteredAxis(baseOrbitAxis, rand, 0.2),
          spinPeriodSeconds: def.retrograde ? -spinPeriodSeconds(def) : spinPeriodSeconds(def),
          spinAxis: jitteredAxis(baseSpinAxis, rand, 0.15),
          startAngle: rand() * Math.PI * 2,
        },
        {
          heightmapImage: heightmapImages[def.name],
          actualSemiMajorAxis,
          colorImage: colorImages[def.name],
        },
      );
      moon.orbit.orbitNode.parent = parent.orbit.orbitNode;
      moon.parentBody = parent;
      const line = moon.orbit.createOrbitLine(scene, `${def.name}OrbitLine`, orbitLineColorFor(def.seed), parent.orbit.orbitNode);
      this.orbitLines.push({ mesh: line, gameplaySemiMajorAxis, getCurrentSemiMajorAxis: () => moon.orbit.semiMajorAxis, currentRatio: 1 });
      this.bodies.push(moon);
    }

    this.beltMars = this.bodies.find((b) => b.def.name === "Mars")!;
    this.beltJupiter = this.bodies.find((b) => b.def.name === "Jupiter")!;
    const beltInner = this.beltMars.gameplaySemiMajorAxis * 1.3;
    const beltOuter = this.beltJupiter.gameplaySemiMajorAxis * 0.8;
    this.belt = new AsteroidBelt(scene, beltInner, beltOuter, 909);

    this.focusedIndex = BODY_DEFS.findIndex((b) => b.name === "Earth");

    this.setOrbitLinesVisible(graphicsSettings.showOrbitLines);
  }

  get focused(): CelestialBody {
    return this.bodies[this.focusedIndex];
  }

  setOrbitLinesVisible(visible: boolean): void {
    for (const line of this.orbitLines) line.mesh.setEnabled(visible);
  }

  /**
   * Updates every body's orbit/spin (cheap transform math), the belt's shared rotation, and
   * the sun's direction relative to the focused body (or `sunDirectionOverride`, if given) - but
   * only runs the focused body's terrain LOD/generation queue at full fidelity. Pass the
   * camera's position local to the focused body's spinNode (same convention PlanetTerrain.update
   * already expects).
   *
   * @param sunDirectionOverride Lights using this precomputed direction instead of deriving one
   * from `focused` - used mid-transit (main.ts's beginTransit/beginFreeCamZoomTo), where
   * `focused` deliberately stays the departure body until arrival (terrain LOD/ground-mode
   * thresholds need that), but the sun should already be tracking whichever body is actually
   * being approached - otherwise the target planet keeps the departure body's stale day/night
   * angle for the whole flight and only snaps correct the instant it completes ("when flying
   * towards a planet it doesn't update the lighting on the planet"). Callers blend this smoothly
   * between the departure and destination bodies' own directions over the flight (see
   * transitSunDirOverride's own comment) rather than switching abruptly the instant the flight
   * begins, which read as a sudden, jarring change ("why does the planet light up when double
   * clicked?").
   */
  update(deltaSeconds: number, focusedCameraLocalPosition: Vector3, sun: DirectionalLight, sunDirectionOverride?: Vector3): void {
    const blend = orbitalScale.blend;
    for (const body of this.bodies) {
      // A no-op for bodies actualSemiMajorAxis === gameplaySemiMajorAxis (not in the toggle's
      // scope, or Earth itself - the fixed anchor both modes agree on) - cheap enough (~12
      // bodies) not to bother skipping those explicitly.
      body.orbit.setSemiMajorAxis(body.gameplaySemiMajorAxis + (body.actualSemiMajorAxis - body.gameplaySemiMajorAxis) * blend);
      body.orbit.update(deltaSeconds);
    }
    // Orbit-line meshes are drawn once at gameplay scale and never rebuilt (see
    // CelestialOrbit.createOrbitLine) - a uniform mesh scale keeps each one visually attached to
    // its body's current (possibly blended) distance instead of the geometry going stale. Skipped
    // when the ratio hasn't actually moved (most bodies, most frames) - same no-op guard as
    // AsteroidBelt.setRadii, since writing .scaling unconditionally would dirty the TransformNode
    // and force a world-matrix recompute every frame for lines that never move.
    for (const line of this.orbitLines) {
      const ratio = line.getCurrentSemiMajorAxis() / line.gameplaySemiMajorAxis;
      if (ratio === line.currentRatio) continue;
      line.currentRatio = ratio;
      line.mesh.scaling.setAll(ratio);
    }
    this.belt.setRadii(this.beltMars.orbit.semiMajorAxis * 1.3, this.beltJupiter.orbit.semiMajorAxis * 0.8);
    this.belt.update(deltaSeconds);
    // Blends each body's RENDERED SIZE toward its real diameter ratio via a uniform
    // spinNode.scaling factor, not by touching `radius` or regenerating terrain geometry -
    // spinNode is the parent of the terrain patches, the gas-giant mesh+ring, Base's fixed
    // surface offset, AND (whenever this body is focused) the orbit/ground camera itself, so
    // scaling it uniformly grows/shrinks the visible planet in world space for free while
    // leaving every LOCAL (body-radii-relative) distance - camera thresholds, terrain LOD's own
    // distance math, Base's surface anchor - completely unaffected (see the plan notes for why
    // this is safe). `blend` is shared by every body, so this whole pass is skipped (not just
    // per-body, like the orbit-line loop above) whenever it hasn't moved since last frame.
    if (blend !== this.currentSizeBlend) {
      this.currentSizeBlend = blend;
      for (const body of this.bodies) {
        const ratio = 1 + (body.actualRadius / body.radius - 1) * blend;
        body.orbit.spinNode.scaling.setAll(ratio);
      }
    }
    // Blends the same way every body's own distance does - see STAR_RADIUS_ACTUAL's own comment
    // on why this genuinely shrinks (not grows) at full Actual scale.
    const starRadius = STAR_RADIUS + (STAR_RADIUS_ACTUAL - STAR_RADIUS) * blend;
    if (starRadius !== this.currentStarRadius) {
      this.currentStarRadius = starRadius;
      this.star.setRadius(starRadius);
    }

    this.focused.terrain?.update(focusedCameraLocalPosition);

    if (sunDirectionOverride) {
      sun.direction.copyFrom(sunDirectionOverride);
    } else {
      this.focused.orbit.sunDirectionTo(Vector3.Zero(), tmpSunDirection);
      sun.direction.copyFrom(tmpSunDirection);
    }
  }
}
