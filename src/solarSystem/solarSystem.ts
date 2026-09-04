import { Color3, DirectionalLight, Scene, Vector3 } from "@babylonjs/core";
import { Star } from "../environment/star";
import { Starfield } from "../environment/starfield";
import { CelestialBody } from "./celestialBody";
import { AsteroidBelt } from "./asteroidBelt";
import { BODY_DEFS, sceneDistance, orbitPeriodSeconds, spinPeriodSeconds, moonOrbitPeriodSeconds, STAR_RADIUS } from "./scale";
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
      const body = new CelestialBody(
        scene,
        def,
        {
          name: def.name,
          semiMajorAxis: sceneDistance(def.auDistance),
          eccentricity: def.eccentricity,
          orbitPeriodSeconds: orbitPeriodSeconds(def.orbitYears),
          orbitAxis: jitteredAxis(baseOrbitAxis, rand, 0.06),
          spinPeriodSeconds: def.retrograde ? -spinPeriodSeconds(def) : spinPeriodSeconds(def),
          spinAxis: jitteredAxis(baseSpinAxis, rand, 0.15),
          startAngle: (index / starOrbitingDefs.length) * Math.PI * 2 + rand() * 0.5,
        },
        heightmapImages[def.name],
      );
      body.orbit.createOrbitLine(scene, `${def.name}OrbitLine`, orbitLineColorFor(def.seed));
      return body;
    });

    for (const def of moonDefs) {
      const parent = this.bodies.find((b) => b.def.name === def.orbitsAround);
      if (!parent) continue; // BODY_DEFS is static and self-consistent - shouldn't happen
      const moon = new CelestialBody(
        scene,
        def,
        {
          name: def.name,
          semiMajorAxis: parent.radius * (def.moonOrbitRadiusInParentRadii ?? 6),
          eccentricity: def.eccentricity,
          orbitPeriodSeconds: moonOrbitPeriodSeconds(def),
          orbitAxis: jitteredAxis(baseOrbitAxis, rand, 0.2),
          spinPeriodSeconds: def.retrograde ? -spinPeriodSeconds(def) : spinPeriodSeconds(def),
          spinAxis: jitteredAxis(baseSpinAxis, rand, 0.15),
          startAngle: rand() * Math.PI * 2,
        },
        heightmapImages[def.name],
      );
      moon.orbit.orbitNode.parent = parent.orbit.orbitNode;
      moon.orbit.createOrbitLine(scene, `${def.name}OrbitLine`, orbitLineColorFor(def.seed), parent.orbit.orbitNode);
      this.bodies.push(moon);
    }

    const marsIndex = BODY_DEFS.findIndex((b) => b.name === "Mars");
    const jupiterIndex = BODY_DEFS.findIndex((b) => b.name === "Jupiter");
    const beltInner = sceneDistance(BODY_DEFS[marsIndex].auDistance) * 1.3;
    const beltOuter = sceneDistance(BODY_DEFS[jupiterIndex].auDistance) * 0.8;
    this.belt = new AsteroidBelt(scene, beltInner, beltOuter, 909);

    this.focusedIndex = BODY_DEFS.findIndex((b) => b.name === "Earth");
  }

  get focused(): CelestialBody {
    return this.bodies[this.focusedIndex];
  }

  /**
   * Updates every body's orbit/spin (cheap transform math), the belt's shared rotation, and
   * the sun's direction relative to the focused body - but only runs the focused body's
   * terrain LOD/generation queue at full fidelity. Pass the camera's position local to the
   * focused body's spinNode (same convention PlanetTerrain.update already expects).
   */
  update(deltaSeconds: number, focusedCameraLocalPosition: Vector3, sun: DirectionalLight): void {
    for (const body of this.bodies) {
      body.orbit.update(deltaSeconds);
    }
    this.belt.update(deltaSeconds);

    this.focused.terrain?.update(focusedCameraLocalPosition);

    this.focused.orbit.sunDirectionTo(Vector3.Zero(), tmpSunDirection);
    sun.direction.copyFrom(tmpSunDirection);
  }
}
