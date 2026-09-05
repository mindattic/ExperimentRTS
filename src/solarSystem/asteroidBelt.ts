import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { mulberry32 } from "../terrain/prng";

const ROCK_COUNT = 260;
const BELT_PERIOD_SECONDS = 2600; // one shared slow rotation for the whole belt - fun over accuracy, not per-rock orbits

const tmpMatrix = new Matrix();

/**
 * A field of small rocks scattered in an annulus between the given inner/outer scene distances
 * (Mars and Jupiter), rendered as thin instances of one shared mesh for performance - not
 * individual CelestialBody/TransformNode objects, and every rock shares one slow rotation
 * around the star rather than simulating individual orbits. Individually pickable/orbitable
 * (see getRockWorldPosition) despite not having its own transform node per rock - a selected
 * rock's live world position is composed on demand from its fixed local position (stored at
 * construction) and the shared belt node's own current rotation.
 *
 * Each rock's RADIAL placement within the annulus (radialT, 0 at the inner edge to 1 at the
 * outer) is stored rather than baked into a fixed distance, so the whole belt can be re-laid-out
 * as the inner/outer radii themselves change - see setRadii(), called every frame from
 * SolarSystem.update() with Mars/Jupiter's own live (orbitalScale-blended) distances. Scaling the
 * belt's TransformNode uniformly instead (the same trick orbit lines use) was rejected: it would
 * also scale each individual ROCK's size along with the belt's overall radius, which is wrong -
 * real asteroid sizes don't change, only how far apart Mars and Jupiter (and so the belt between
 * them) currently are.
 */
export class AsteroidBelt {
  private readonly node: TransformNode;
  private readonly rock: Mesh;
  private readonly localPositions: Vector3[] = [];
  private readonly radialT: number[] = [];
  private readonly theta: number[] = [];
  private readonly heightJitterT: number[] = []; // heightJitter as a fraction of (outer - inner), not a fixed value
  private readonly rockScale: Vector3[] = [];
  private readonly rockRotation: Quaternion[] = [];
  private angle = 0;
  private currentInner: number;
  private currentOuter: number;

  constructor(scene: Scene, innerDistance: number, outerDistance: number, seed: number) {
    this.node = new TransformNode("asteroidBelt", scene);
    this.currentInner = innerDistance;
    this.currentOuter = outerDistance;

    this.rock = MeshBuilder.CreatePolyhedron("asteroidRock", { type: 1, size: 40 }, scene);
    const material = new StandardMaterial("asteroidMaterial", scene);
    material.diffuseColor = new Color3(0.35, 0.32, 0.28);
    material.specularColor = Color3.Black();
    // See hullTexture.ts's createHullMaterial for why - same "small object near camera vs a
    // planet a full AU away" depth-comparison mismatch applies to asteroids too.
    material.useLogarithmicDepth = true;
    this.rock.material = material;
    this.rock.parent = this.node;
    this.rock.isPickable = true; // individually selectable via PickingInfo.thinInstanceIndex

    const rand = mulberry32(seed);
    const matrices: Matrix[] = [];
    for (let i = 0; i < ROCK_COUNT; i++) {
      const t = rand();
      const theta = rand() * Math.PI * 2;
      const heightJitterT = (rand() - 0.5) * 0.06;
      this.radialT.push(t);
      this.theta.push(theta);
      this.heightJitterT.push(heightJitterT);
      const distance = innerDistance + t * (outerDistance - innerDistance);
      const heightJitter = heightJitterT * (outerDistance - innerDistance);
      const position = new Vector3(Math.cos(theta) * distance, heightJitter, Math.sin(theta) * distance);
      this.localPositions.push(position);
      const scale = 0.4 + rand() * 1.6;
      const rotation = Quaternion.RotationYawPitchRoll(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2);
      this.rockScale.push(new Vector3(scale, scale, scale));
      this.rockRotation.push(rotation);
      matrices.push(Matrix.Compose(this.rockScale[i], rotation, position));
    }
    this.rock.thinInstanceAdd(matrices, true);
  }

  /** Re-lays-out every rock's position (not size/rotation) for a new inner/outer distance pair -
   * a no-op if unchanged from last call, so calling this unconditionally every frame from
   * SolarSystem.update() is cheap. Each rock keeps its own radialT (relative position within the
   * annulus), so the belt visually stretches/compresses as Mars and Jupiter move apart/together
   * (see orbitalScale.ts) instead of independently drifting away from its own anchoring planets. */
  setRadii(innerDistance: number, outerDistance: number): void {
    if (innerDistance === this.currentInner && outerDistance === this.currentOuter) return;
    this.currentInner = innerDistance;
    this.currentOuter = outerDistance;
    const span = outerDistance - innerDistance;
    for (let i = 0; i < ROCK_COUNT; i++) {
      const distance = innerDistance + this.radialT[i] * span;
      const heightJitter = this.heightJitterT[i] * span;
      const position = this.localPositions[i];
      position.set(Math.cos(this.theta[i]) * distance, heightJitter, Math.sin(this.theta[i]) * distance);
      Matrix.ComposeToRef(this.rockScale[i], this.rockRotation[i], position, tmpMatrix);
      this.rock.thinInstanceSetMatrixAt(i, tmpMatrix, i === ROCK_COUNT - 1);
    }
  }

  update(deltaSeconds: number): void {
    this.angle += deltaSeconds * ((2 * Math.PI) / BELT_PERIOD_SECONDS);
    this.node.rotation.y = this.angle;
  }

  /** The single shared mesh every rock is a thin instance of - compare against
   * PickingInfo.pickedMesh to recognize an asteroid pick. */
  get rockMesh(): Mesh {
    return this.rock;
  }

  get rockCount(): number {
    return this.localPositions.length;
  }

  /** Current world position of one rock (index = PickingInfo.thinInstanceIndex) - composes its
   * fixed local position with the belt node's own live rotation, since thin instances have no
   * individual TransformNode of their own to read a world matrix from directly. */
  getRockWorldPosition(index: number, out: Vector3): void {
    Vector3.TransformCoordinatesToRef(this.localPositions[index], this.node.getWorldMatrix(), out);
  }
}
