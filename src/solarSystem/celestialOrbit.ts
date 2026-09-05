import { Color3, type LinesMesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";

const ORBIT_LINE_SEGMENTS = 128;
/** Samples per full orbit in the precomputed position cache - see the class doc comment. At
 * this density (0.5 degrees between samples) linear interpolation between neighbors is
 * visually exact for these near-circular orbits (eccentricity capped at 0.02 system-wide). */
const ORBIT_SAMPLE_COUNT = 720;

export interface CelestialOrbitOptions {
  name: string;
  semiMajorAxis: number;
  eccentricity: number;
  orbitPeriodSeconds: number;
  /** Normal of the orbital plane (inclination). */
  orbitAxis: Vector3;
  spinPeriodSeconds: number;
  /** Axial tilt. */
  spinAxis: Vector3;
  /** Where on the ellipse this body starts, radians - lets bodies not all start aligned. */
  startAngle: number;
}

/**
 * One body's motion around the shared star (fixed at the world origin, a focus of every
 * body's ellipse - see Star), generalized from the original single-planet PlanetMotion so
 * every body in the system can have its own distance/eccentricity/period/inclination/tilt.
 *
 * Two nodes, so terrain/cameras parented once get both motions for free:
 *  - `orbitNode`: translates along the ellipse. Slow, in minutes.
 *  - `spinNode` (child of orbitNode): the body's own axial rotation. Terrain and cameras
 *    parent here so a ground-mode anchor stays glued to the same physical point on the
 *    surface as the body spins under it.
 *
 * The directional light is NOT parented (Babylon doesn't transform light direction by any
 * node), so day/night comes purely from the changing relative position between the star's
 * fixed world position and `orbitNode`'s current position - see `sunDirectionTo`.
 *
 * Position is a lookup into a precomputed table of ORBIT_SAMPLE_COUNT samples spanning one
 * full orbit (generated once, analytically, from positionAt() - see the constructor), rather
 * than calling cos/sin fresh every frame - the whole system reads cached position "tickers"
 * off this table (interpolated between the two nearest samples) each update() instead of
 * recomputing orbital trig per body per frame. The table wraps exactly (index modulo
 * ORBIT_SAMPLE_COUNT), so a body reaching the end of its cached year lands precisely back on
 * its first sample rather than drifting - guaranteed by construction, since both ends of the
 * table come from the same continuous periodic function at theta=0 and theta=2*PI.
 *
 * The cached table stores a **unit ellipse** (semi-major axis of 1, shape/eccentricity baked
 * in) rather than the real semi-major axis - `positionAt(theta) = semiMajor *
 * unitPositionAt(theta)` factors cleanly since every term is linear in semiMajor (semiMinor and
 * focalDistance are themselves `semiMajor * f(eccentricity)`). This lets `setSemiMajorAxis`
 * (the actual/gameplay orbital-scale toggle - see main.ts/orbitalScale.ts) change a body's
 * orbital distance at runtime as a cheap per-frame scalar multiply, with no resampling.
 */
export class CelestialOrbit {
  readonly orbitNode: TransformNode;
  readonly spinNode: TransformNode;

  private readonly eccentricity: number;
  private readonly semiMinorRatio: number; // sqrt(1 - e^2) - semiMinor/semiMajor, independent of scale
  private readonly orbitU: Vector3;
  private readonly orbitV: Vector3;
  private readonly orbitPeriodSeconds: number;
  private readonly spinPeriodSeconds: number;
  private readonly spinAxis: Vector3;
  private readonly unitPositionSamples: Vector3[];
  /** The real, current semi-major axis - everything the cached unit samples get scaled by. Set
   * once at construction, mutable afterward only via setSemiMajorAxis(). */
  private currentSemiMajorAxis: number;
  private orbitAngle: number;
  private spinAngle = 0;

  constructor(scene: Scene, options: CelestialOrbitOptions) {
    this.eccentricity = options.eccentricity;
    this.semiMinorRatio = Math.sqrt(1 - options.eccentricity * options.eccentricity);
    this.currentSemiMajorAxis = options.semiMajorAxis;
    this.orbitPeriodSeconds = options.orbitPeriodSeconds;
    this.spinPeriodSeconds = options.spinPeriodSeconds;
    this.spinAxis = options.spinAxis;
    this.orbitAngle = options.startAngle;

    const orbitAxis = options.orbitAxis;
    let arbitrary = Vector3.Right();
    if (Math.abs(Vector3.Dot(arbitrary, orbitAxis)) > 0.9) arbitrary = Vector3.Forward();
    this.orbitU = Vector3.Cross(orbitAxis, arbitrary).normalize();
    this.orbitV = Vector3.Cross(orbitAxis, this.orbitU).normalize();

    this.unitPositionSamples = [];
    for (let i = 0; i < ORBIT_SAMPLE_COUNT; i++) {
      this.unitPositionSamples.push(this.unitPositionAt((i / ORBIT_SAMPLE_COUNT) * Math.PI * 2));
    }

    this.orbitNode = new TransformNode(`${options.name}Orbit`, scene);
    this.spinNode = new TransformNode(`${options.name}Spin`, scene);
    this.spinNode.parent = this.orbitNode;
    this.spinNode.rotationQuaternion = new Quaternion();

    this.update(0);
  }

  /** Sets the real semi-major axis used by every position read from now on (positionAt,
   * sampledPositionToRef, predictLocalPositionAt) - the toggle between actual and gameplay
   * orbital scale (see SolarSystem.update) calls this every frame with a lerped value. Cheap:
   * the cached unit-ellipse table never needs resampling. */
  setSemiMajorAxis(value: number): void {
    this.currentSemiMajorAxis = value;
  }

  get semiMajorAxis(): number {
    return this.currentSemiMajorAxis;
  }

  /** Interpolates the cached UNIT position table at `theta` (any real number - wraps
   * automatically) into `out`, then scales by the current real semi-major axis - instead of
   * recomputing positionAt()'s trig fresh every frame. */
  private sampledPositionToRef(theta: number, out: Vector3): void {
    const twoPi = Math.PI * 2;
    const wrapped = ((theta % twoPi) + twoPi) % twoPi;
    const f = (wrapped / twoPi) * ORBIT_SAMPLE_COUNT;
    const i0 = Math.floor(f) % ORBIT_SAMPLE_COUNT;
    const i1 = (i0 + 1) % ORBIT_SAMPLE_COUNT;
    Vector3.LerpToRef(this.unitPositionSamples[i0], this.unitPositionSamples[i1], f - Math.floor(f), out);
    out.scaleInPlace(this.currentSemiMajorAxis);
  }

  /** Draws a static line tracing the orbit ellipse, for orientation at a distance. `parentNode`
   * carries the line along with a moving parent (a moon's orbit line needs to follow its
   * planet) - the line's own points are always expressed in the same local-to-focus space as
   * positionAt(), so it only reads correctly unparented (world space, star-orbiting bodies) or
   * parented to whatever that focus actually is (a moon's parent planet). Returns the created
   * mesh so callers can collect it for a "show orbit lines" visibility toggle. */
  createOrbitLine(scene: Scene, name: string, color = new Color3(0.45, 0.5, 0.6), parentNode: TransformNode | null = null): LinesMesh {
    const points: Vector3[] = [];
    for (let i = 0; i <= ORBIT_LINE_SEGMENTS; i++) {
      points.push(this.positionAt((i / ORBIT_LINE_SEGMENTS) * Math.PI * 2));
    }
    const line = MeshBuilder.CreateLines(name, { points }, scene);
    // LinesMesh's own default shader material has no logarithmic-depth support and (without
    // useVertexAlpha, never passed here) never actually enables GL alpha blending regardless of
    // .alpha - at this scene's huge near/far ratio that meant orbit lines rendered fully opaque
    // despite the "80% transparent" intent, and drew in front of/behind planets in the wrong
    // order (every planet/terrain material uses useLogarithmicDepth - see
    // celestialBody.ts/planetTerrain.ts - so a linear-depth line can't be compared against them
    // consistently). A plain unlit StandardMaterial gets both right for free.
    const material = new StandardMaterial(`${name}Material`, scene);
    material.emissiveColor = color;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.alpha = 0.2; // 80% transparent
    material.useLogarithmicDepth = true;
    material.backFaceCulling = false;
    line.material = material;
    line.isPickable = false;
    line.parent = parentNode;
    return line;
  }

  /** Unit-scale (semiMajorAxis = 1) point on the orbit ellipse at parameter `theta` (0..2π),
   * focus at the origin - see the class doc comment on why the cached table stores these
   * instead of real-scale positions. */
  private unitPositionAt(theta: number): Vector3 {
    const x = Math.cos(theta) - this.eccentricity;
    const y = this.semiMinorRatio * Math.sin(theta);
    return this.orbitU.scale(x).add(this.orbitV.scale(y));
  }

  /** World-space point on the orbit ellipse at parameter `theta` (0..2π), focus at the origin,
   * at the current real semi-major axis (see setSemiMajorAxis). */
  positionAt(theta: number): Vector3 {
    return this.unitPositionAt(theta).scaleInPlace(this.currentSemiMajorAxis);
  }

  update(deltaSeconds: number): void {
    this.orbitAngle += deltaSeconds * ((2 * Math.PI) / this.orbitPeriodSeconds);
    this.sampledPositionToRef(this.orbitAngle, this.orbitNode.position);

    this.spinAngle += deltaSeconds * ((2 * Math.PI) / this.spinPeriodSeconds);
    Quaternion.RotationAxisToRef(this.spinAxis, this.spinAngle, this.spinNode.rotationQuaternion!);
  }

  /** Direction light travels from `starWorldPosition` to this body's current orbital position.
   * Uses getAbsolutePosition() (not the local `.position`) so this is correct for a moon too -
   * its orbitNode.position is local to its parent planet's orbitNode, not the world/star frame. */
  sunDirectionTo(starWorldPosition: Vector3, out: Vector3): void {
    this.orbitNode.getAbsolutePosition().subtractToRef(starWorldPosition, out);
    out.normalize();
  }

  /** Local-to-focus position (same frame as positionAt()/orbitNode.position) this body will
   * occupy `secondsFromNow` from now - evaluated directly from the exact analytic ellipse
   * rather than the cached per-frame sample table (sampledPositionToRef), since this is a
   * one-off prediction call (ship departure planning - see economy/shipTransit.ts), not a
   * per-frame lookup, so recomputing the trig fresh here avoids the table's quantization.
   * Composition across a hierarchy (e.g. a station orbiting a planet) is the CALLER's job -
   * this method only ever knows about its own ellipse, exactly like today. */
  predictLocalPositionAt(secondsFromNow: number, out: Vector3): void {
    const theta = this.orbitAngle + secondsFromNow * ((2 * Math.PI) / this.orbitPeriodSeconds);
    out.copyFrom(this.positionAt(theta));
  }
}
