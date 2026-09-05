import { Color3, DirectionalLight, type LinesMesh, Scene, Vector3 } from "@babylonjs/core";
import { graphicsSettings } from "../settings/graphicsSettings";
import { Star } from "../environment/star";
import { Starfield } from "../environment/starfield";
import { CelestialBody } from "./celestialBody";
import { AsteroidBelt } from "./asteroidBelt";
import { BODY_DEFS, sceneDistance, actualSceneDistance, orbitPeriodSeconds, spinPeriodSeconds, moonOrbitPeriodSeconds, STAR_RADIUS } from "./scale";
import { orbitalScale } from "./orbitalScale";
import { mulberry32 } from "../terrain/prng";
import type { HeightmapImageData } from "../terrain/heightmapImage";

const tmpSunDirection = new Vector3();

function jitteredAxis(base: Vector3, rand: () => number, spread: number): Vector3 {
  const jitter = new Vector3((rand() - 0.5) * spread, 0, (rand() - 0.5) * spread);
  return base.add(jitter).normalize();
}

/** Deterministic per-body orbit-line color, keyed off the body's own procedural-terrain seed
 * (already a unique per-body number) so every orbit reads as visually distinct rather than one
 * indistinguishable gray loop for the whole system - full saturation/value, only hue varies. */
function orbitLineColorFor(seed: number): Color3 {
  const hue = mulberry32(seed * 7919 + 13)() * 360;
  return Color3.FromHSV(hue, 0.55, 0.95);
}

/** Owns the star, every CelestialBody, the decorative asteroid belt, and the background starfield. */
export class SolarSystem {
  readonly star: Star;
  readonly bodies: CelestialBody[];
  readonly belt: AsteroidBelt;
  focusedIndex: number;
  private readonly orbitLineMeshes: LinesMesh[] = [];
  /** Parallel to orbitLineMeshes - the CelestialOrbit each line was drawn from, and the
   * gameplay-scale semi-major axis it was drawn AT (a fixed one-time mesh, never rebuilt) - so
   * SolarSystem.update can keep it visually attached to its body by applying a uniform
   * mesh.scaling = currentSMA/gameplaySMA every frame instead of regenerating geometry. */
  private readonly orbitLines: { mesh: LinesMesh; gameplaySemiMajorAxis: number; getCurrentSemiMajorAxis: () => number }[] = [];

  /** @param farClip Camera far-clip distance (see main.ts) - the starfield sits just inside it,
   * as close to "fixed at infinity" as the clipping range allows. */
  constructor(scene: Scene, farClip: number, heightmapImages: Partial<Record<string, HeightmapImageData>> = {}) {
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
        heightmapImages[def.name],
        actualSceneDistance(def.auDistance),
      );
      const line = body.orbit.createOrbitLine(scene, `${def.name}OrbitLine`, orbitLineColorFor(def.seed));
      this.orbitLineMeshes.push(line);
      this.orbitLines.push({ mesh: line, gameplaySemiMajorAxis, getCurrentSemiMajorAxis: () => body.orbit.semiMajorAxis });
      return body;
    });

    for (const def of moonDefs) {
      const parent = this.bodies.find((b) => b.def.name === def.orbitsAround);
      if (!parent) continue; // BODY_DEFS is static and self-consistent - shouldn't happen
      const gameplaySemiMajorAxis = parent.radius * (def.moonOrbitRadiusInParentRadii ?? 6);
      const actualSemiMajorAxis = def.moonOrbitRadiusInParentRadiiActual
        ? parent.radius * def.moonOrbitRadiusInParentRadiiActual
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
        heightmapImages[def.name],
        actualSemiMajorAxis,
      );
      moon.orbit.orbitNode.parent = parent.orbit.orbitNode;
      const line = moon.orbit.createOrbitLine(scene, `${def.name}OrbitLine`, orbitLineColorFor(def.seed), parent.orbit.orbitNode);
      this.orbitLineMeshes.push(line);
      this.orbitLines.push({ mesh: line, gameplaySemiMajorAxis, getCurrentSemiMajorAxis: () => moon.orbit.semiMajorAxis });
      this.bodies.push(moon);
    }

    const marsIndex = BODY_DEFS.findIndex((b) => b.name === "Mars");
    const jupiterIndex = BODY_DEFS.findIndex((b) => b.name === "Jupiter");
    const beltInner = sceneDistance(BODY_DEFS[marsIndex].auDistance) * 1.3;
    const beltOuter = sceneDistance(BODY_DEFS[jupiterIndex].auDistance) * 0.8;
    this.belt = new AsteroidBelt(scene, beltInner, beltOuter, 909);

    this.focusedIndex = BODY_DEFS.findIndex((b) => b.name === "Earth");

    this.setOrbitLinesVisible(graphicsSettings.showOrbitLines);
  }

  get focused(): CelestialBody {
    return this.bodies[this.focusedIndex];
  }

  setOrbitLinesVisible(visible: boolean): void {
    for (const line of this.orbitLineMeshes) line.setEnabled(visible);
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
    // its body's current (possibly blended) distance instead of the geometry going stale.
    for (const line of this.orbitLines) {
      line.mesh.scaling.setAll(line.getCurrentSemiMajorAxis() / line.gameplaySemiMajorAxis);
    }
    this.belt.update(deltaSeconds);

    this.focused.terrain?.update(focusedCameraLocalPosition);

    if (sunDirectionOverride) {
      sun.direction.copyFrom(sunDirectionOverride);
    } else {
      this.focused.orbit.sunDirectionTo(Vector3.Zero(), tmpSunDirection);
      sun.direction.copyFrom(tmpSunDirection);
    }
  }
}
