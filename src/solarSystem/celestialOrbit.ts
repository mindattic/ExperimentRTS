import { Color3, MeshBuilder, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";

const ORBIT_LINE_SEGMENTS = 128;

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

    this.orbitNode = new TransformNode(`${options.name}Orbit`, scene);
    this.spinNode = new TransformNode(`${options.name}Spin`, scene);
    this.spinNode.parent = this.orbitNode;
    this.spinNode.rotationQuaternion = new Quaternion();

    this.update(0);
  }

  /** Draws a static line tracing the orbit ellipse, for orientation at a distance. */
  createOrbitLine(scene: Scene, name: string, color = new Color3(0.45, 0.5, 0.6)): void {
    const points: Vector3[] = [];
    for (let i = 0; i <= ORBIT_LINE_SEGMENTS; i++) {
      points.push(this.positionAt((i / ORBIT_LINE_SEGMENTS) * Math.PI * 2));
    }
    const line = MeshBuilder.CreateLines(name, { points }, scene);
    line.color = color;
    line.isPickable = false;
  }

  /** World-space point on the orbit ellipse at parameter `theta` (0..2π), focus at the origin. */
  positionAt(theta: number): Vector3 {
    const x = this.semiMajor * Math.cos(theta) - this.focalDistance;
    const y = this.semiMinor * Math.sin(theta);
    return this.orbitU.scale(x).add(this.orbitV.scale(y));
  }

  update(deltaSeconds: number): void {
    this.orbitAngle += deltaSeconds * ((2 * Math.PI) / this.orbitPeriodSeconds);
    this.orbitNode.position.copyFrom(this.positionAt(this.orbitAngle));

    this.spinAngle += deltaSeconds * ((2 * Math.PI) / this.spinPeriodSeconds);
    Quaternion.RotationAxisToRef(this.spinAxis, this.spinAngle, this.spinNode.rotationQuaternion!);
  }

  /** Direction light travels from `starWorldPosition` to this body's current orbital position. */
  sunDirectionTo(starWorldPosition: Vector3, out: Vector3): void {
    this.orbitNode.position.subtractToRef(starWorldPosition, out);
    out.normalize();
  }
}
