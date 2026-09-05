import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { mulberry32 } from "../terrain/prng";

const ROCK_COUNT = 260;
const BELT_PERIOD_SECONDS = 2600; // one shared slow rotation for the whole belt - fun over accuracy, not per-rock orbits

/**
 * A field of small rocks scattered in an annulus between the given inner/outer scene distances
 * (Mars and Jupiter), rendered as thin instances of one shared mesh for performance - not
 * individual CelestialBody/TransformNode objects, and every rock shares one slow rotation
 * around the star rather than simulating individual orbits. Individually pickable/orbitable
 * (see getRockWorldPosition) despite not having its own transform node per rock - a selected
 * rock's live world position is composed on demand from its fixed local position (stored at
 * construction) and the shared belt node's own current rotation.
 */
export class AsteroidBelt {
  private readonly node: TransformNode;
  private readonly rock: Mesh;
  private readonly localPositions: Vector3[] = [];
  private angle = 0;

  constructor(scene: Scene, innerDistance: number, outerDistance: number, seed: number) {
    this.node = new TransformNode("asteroidBelt", scene);

    this.rock = MeshBuilder.CreatePolyhedron("asteroidRock", { type: 1, size: 40 }, scene);
    const material = new StandardMaterial("asteroidMaterial", scene);
    material.diffuseColor = new Color3(0.35, 0.32, 0.28);
    material.specularColor = Color3.Black();
    this.rock.material = material;
    this.rock.parent = this.node;
    this.rock.isPickable = true; // individually selectable via PickingInfo.thinInstanceIndex

    const rand = mulberry32(seed);
    const matrices: Matrix[] = [];
    for (let i = 0; i < ROCK_COUNT; i++) {
      const distance = innerDistance + rand() * (outerDistance - innerDistance);
      const theta = rand() * Math.PI * 2;
      const heightJitter = (rand() - 0.5) * (outerDistance - innerDistance) * 0.06;
      const position = new Vector3(Math.cos(theta) * distance, heightJitter, Math.sin(theta) * distance);
      this.localPositions.push(position);
      const scale = 0.4 + rand() * 1.6;
      const rotation = Quaternion.RotationYawPitchRoll(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2);
      matrices.push(Matrix.Compose(new Vector3(scale, scale, scale), rotation, position));
    }
    this.rock.thinInstanceAdd(matrices, true);
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
