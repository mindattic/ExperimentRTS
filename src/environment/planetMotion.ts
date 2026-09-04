import { Color3, MeshBuilder, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";

const ORBIT_AXIS = new Vector3(0.12, 0.98, 0.15).normalize();
const ORBIT_PERIOD_SECONDS = 240;
const ECCENTRICITY = 0.5;
const ORBIT_LINE_SEGMENTS = 128;

const SPIN_AXIS = new Vector3(0.15, 0.97, -0.18).normalize();
const SPIN_PERIOD_SECONDS = 80;

/**
 * Owns the planet's two motions, kept as separate nodes so terrain/cameras can be parented
 * once and get both for free:
 *  - `orbitNode`: translates along an elliptical path around the star (which stays fixed at
 *    one focus - see Star). Slow, in minutes.
 *  - `spinNode` (child of orbitNode): the planet's own axial rotation. Terrain and both
 *    cameras are parented here, so a ground-mode anchor stays glued to the same physical
 *    point on the surface as the planet spins under it, instead of sliding out from under
 *    the camera.
 *
 * The directional light is NOT parented (its direction is a world-space vector Babylon
 * doesn't transform by any node), so day/night comes purely from the changing relative
 * position between the star's fixed world position and orbitNode's current orbital position -
 * see `sunDirectionTo`.
 */
export class PlanetMotion {
  readonly orbitNode: TransformNode;
  readonly spinNode: TransformNode;

  private readonly semiMajor: number;
  private readonly semiMinor: number;
  private readonly focalDistance: number;
  private readonly orbitU: Vector3;
  private readonly orbitV: Vector3;
  private orbitAngle = 0;
  private spinAngle = 0;

  constructor(scene: Scene, planetRadius: number) {
    this.semiMajor = planetRadius * 42;
    this.semiMinor = this.semiMajor * Math.sqrt(1 - ECCENTRICITY * ECCENTRICITY);
    this.focalDistance = this.semiMajor * ECCENTRICITY;

    let arbitrary = Vector3.Right();
    if (Math.abs(Vector3.Dot(arbitrary, ORBIT_AXIS)) > 0.9) arbitrary = Vector3.Forward();
    this.orbitU = Vector3.Cross(ORBIT_AXIS, arbitrary).normalize();
    this.orbitV = Vector3.Cross(ORBIT_AXIS, this.orbitU).normalize();

    this.orbitNode = new TransformNode("planetOrbit", scene);
    this.spinNode = new TransformNode("planetSpin", scene);
    this.spinNode.parent = this.orbitNode;
    this.spinNode.rotationQuaternion = new Quaternion();

    this.update(0);
  }

  /** Draws a static line tracing the orbit ellipse, for orientation at a distance. */
  createOrbitLine(scene: Scene): void {
    const points: Vector3[] = [];
    for (let i = 0; i <= ORBIT_LINE_SEGMENTS; i++) {
      points.push(this.positionAt((i / ORBIT_LINE_SEGMENTS) * Math.PI * 2));
    }
    const line = MeshBuilder.CreateLines("planetOrbitLine", { points }, scene);
    line.color = new Color3(0.45, 0.5, 0.6);
    line.isPickable = false;
  }

  /** World-space point on the orbit ellipse at parameter `theta` (0..2π), focus at the origin. */
  positionAt(theta: number): Vector3 {
    const x = this.semiMajor * Math.cos(theta) - this.focalDistance;
    const y = this.semiMinor * Math.sin(theta);
    return this.orbitU.scale(x).add(this.orbitV.scale(y));
  }

  update(deltaSeconds: number): void {
    this.orbitAngle += deltaSeconds * ((2 * Math.PI) / ORBIT_PERIOD_SECONDS);
    this.orbitNode.position.copyFrom(this.positionAt(this.orbitAngle));

    this.spinAngle += deltaSeconds * ((2 * Math.PI) / SPIN_PERIOD_SECONDS);
    Quaternion.RotationAxisToRef(SPIN_AXIS, this.spinAngle, this.spinNode.rotationQuaternion!);
  }

  /** Direction light travels from `starWorldPosition` to the planet's current orbital position. */
  sunDirectionTo(starWorldPosition: Vector3, out: Vector3): void {
    this.orbitNode.position.subtractToRef(starWorldPosition, out);
    out.normalize();
  }
}
