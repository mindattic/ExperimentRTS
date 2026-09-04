import { Color3, MeshBuilder, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";

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
 */
export class CelestialOrbit {
  readonly orbitNode: TransformNode;
  readonly spinNode: TransformNode;

  private readonly semiMajor: number;
  private readonly semiMinor: number;
  private readonly focalDistance: number;
  private readonly orbitU: Vector3;
  private readonly orbitV: Vector3;
  private readonly orbitPeriodSeconds: number;
  private readonly spinPeriodSeconds: number;
  private readonly spinAxis: Vector3;
  private readonly positionSamples: Vector3[];
  private orbitAngle: number;
  private spinAngle = 0;

  constructor(scene: Scene, options: CelestialOrbitOptions) {
    this.semiMajor = options.semiMajorAxis;
    this.semiMinor = this.semiMajor * Math.sqrt(1 - options.eccentricity * options.eccentricity);
    this.focalDistance = this.semiMajor * options.eccentricity;
    this.orbitPeriodSeconds = options.orbitPeriodSeconds;
    this.spinPeriodSeconds = options.spinPeriodSeconds;
    this.spinAxis = options.spinAxis;
    this.orbitAngle = options.startAngle;

    const orbitAxis = options.orbitAxis;
    let arbitrary = Vector3.Right();
    if (Math.abs(Vector3.Dot(arbitrary, orbitAxis)) > 0.9) arbitrary = Vector3.Forward();
    this.orbitU = Vector3.Cross(orbitAxis, arbitrary).normalize();
    this.orbitV = Vector3.Cross(orbitAxis, this.orbitU).normalize();

    this.positionSamples = [];
    for (let i = 0; i < ORBIT_SAMPLE_COUNT; i++) {
      this.positionSamples.push(this.positionAt((i / ORBIT_SAMPLE_COUNT) * Math.PI * 2));
    }

    this.orbitNode = new TransformNode(`${options.name}Orbit`, scene);
    this.spinNode = new TransformNode(`${options.name}Spin`, scene);
    this.spinNode.parent = this.orbitNode;
    this.spinNode.rotationQuaternion = new Quaternion();

    this.update(0);
  }

  /** Interpolates the cached position table at `theta` (any real number - wraps automatically)
   * into `out`, instead of recomputing positionAt()'s trig fresh. */
  private sampledPositionToRef(theta: number, out: Vector3): void {
    const twoPi = Math.PI * 2;
    const wrapped = ((theta % twoPi) + twoPi) % twoPi;
    const f = (wrapped / twoPi) * ORBIT_SAMPLE_COUNT;
    const i0 = Math.floor(f) % ORBIT_SAMPLE_COUNT;
    const i1 = (i0 + 1) % ORBIT_SAMPLE_COUNT;
    Vector3.LerpToRef(this.positionSamples[i0], this.positionSamples[i1], f - Math.floor(f), out);
  }

  /** Draws a static line tracing the orbit ellipse, for orientation at a distance. `parentNode`
   * carries the line along with a moving parent (a moon's orbit line needs to follow its
   * planet) - the line's own points are always expressed in the same local-to-focus space as
   * positionAt(), so it only reads correctly unparented (world space, star-orbiting bodies) or
   * parented to whatever that focus actually is (a moon's parent planet). */
  createOrbitLine(scene: Scene, name: string, color = new Color3(0.45, 0.5, 0.6), parentNode: TransformNode | null = null): void {
    const points: Vector3[] = [];
    for (let i = 0; i <= ORBIT_LINE_SEGMENTS; i++) {
      points.push(this.positionAt((i / ORBIT_LINE_SEGMENTS) * Math.PI * 2));
    }
    const line = MeshBuilder.CreateLines(name, { points }, scene);
    line.color = color;
    line.alpha = 0.2; // 80% transparent
    line.isPickable = false;
    line.parent = parentNode;
  }

  /** World-space point on the orbit ellipse at parameter `theta` (0..2π), focus at the origin. */
  positionAt(theta: number): Vector3 {
    const x = this.semiMajor * Math.cos(theta) - this.focalDistance;
    const y = this.semiMinor * Math.sin(theta);
    return this.orbitU.scale(x).add(this.orbitV.scale(y));
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
