import { Color3, Matrix, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { mulberry32 } from "../terrain/prng";

const ROCK_COUNT = 260;
const BELT_PERIOD_SECONDS = 2600; // one shared slow rotation for the whole belt - fun over accuracy, not per-rock orbits

/**
 * A decorative, non-selectable field of small rocks scattered in an annulus between the given
 * inner/outer scene distances (Mars and Jupiter). Not a CelestialBody - just a visual: every
 * rock shares one slow rotation around the star rather than simulating individual orbits.
 */
export class AsteroidBelt {
  private readonly node: TransformNode;
  private angle = 0;

  constructor(scene: Scene, innerDistance: number, outerDistance: number, seed: number) {
    this.node = new TransformNode("asteroidBelt", scene);

    const rock = MeshBuilder.CreatePolyhedron("asteroidRock", { type: 1, size: 40 }, scene);
    const material = new StandardMaterial("asteroidMaterial", scene);
    material.diffuseColor = new Color3(0.35, 0.32, 0.28);
    material.specularColor = Color3.Black();
    rock.material = material;
    rock.parent = this.node;
    rock.isPickable = false; // decorative only - not a selectable/landable CelestialBody

    const rand = mulberry32(seed);
    const matrices: Matrix[] = [];
    for (let i = 0; i < ROCK_COUNT; i++) {
      const distance = innerDistance + rand() * (outerDistance - innerDistance);
      const theta = rand() * Math.PI * 2;
      const heightJitter = (rand() - 0.5) * (outerDistance - innerDistance) * 0.06;
      const position = new Vector3(Math.cos(theta) * distance, heightJitter, Math.sin(theta) * distance);
      const scale = 0.4 + rand() * 1.6;
      const rotation = Quaternion.RotationYawPitchRoll(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2);
      matrices.push(Matrix.Compose(new Vector3(scale, scale, scale), rotation, position));
    }
    rock.thinInstanceAdd(matrices, true);
  }

  update(deltaSeconds: number): void {
    this.angle += deltaSeconds * ((2 * Math.PI) / BELT_PERIOD_SECONDS);
    this.node.rotation.y = this.angle;
  }
}
