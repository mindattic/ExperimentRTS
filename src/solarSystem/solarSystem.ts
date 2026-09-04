import { DirectionalLight, Scene, Vector3 } from "@babylonjs/core";
import { Star } from "../environment/star";
import { CelestialBody } from "./celestialBody";
import { AsteroidBelt } from "./asteroidBelt";
import { BODY_DEFS, sceneDistance, orbitPeriodSeconds, STAR_RADIUS } from "./scale";
import { mulberry32 } from "../terrain/prng";

const tmpSunDirection = new Vector3();

function jitteredAxis(base: Vector3, rand: () => number, spread: number): Vector3 {
  const jitter = new Vector3((rand() - 0.5) * spread, 0, (rand() - 0.5) * spread);
  return base.add(jitter).normalize();
}

/** Owns the star, every CelestialBody, and the decorative asteroid belt. */
export class SolarSystem {
  readonly star: Star;
  readonly bodies: CelestialBody[];
  readonly belt: AsteroidBelt;
  focusedIndex: number;

  constructor(scene: Scene) {
    this.star = new Star(scene, STAR_RADIUS);

    const rand = mulberry32(777);
    const baseOrbitAxis = new Vector3(0.12, 0.98, 0.15).normalize();
    const baseSpinAxis = new Vector3(0.15, 0.97, -0.18).normalize();

    this.bodies = BODY_DEFS.map((def, index) => {
      const body = new CelestialBody(scene, def, {
        name: def.name,
        semiMajorAxis: sceneDistance(def.auDistance),
        eccentricity: def.eccentricity,
        orbitPeriodSeconds: orbitPeriodSeconds(def.orbitYears),
        orbitAxis: jitteredAxis(baseOrbitAxis, rand, 0.06),
        spinPeriodSeconds: def.retrograde ? -def.spinPeriodSeconds : def.spinPeriodSeconds,
        spinAxis: jitteredAxis(baseSpinAxis, rand, 0.15),
        startAngle: (index / BODY_DEFS.length) * Math.PI * 2 + rand() * 0.5,
      });
      body.orbit.createOrbitLine(scene, `${def.name}OrbitLine`);
      return body;
    });

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
