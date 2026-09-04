import { Color3, MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

/**
 * The star itself: fixed at the world origin (a focus of every body's orbital ellipse - see
 * CelestialOrbit, which uses the same origin-at-focus parametrization). It never moves;
 * bodies orbit it.
 */
export class Star {
  constructor(scene: Scene, radius: number) {
    const mesh = MeshBuilder.CreateSphere("star", { diameter: radius * 2, segments: 16 }, scene);
    const material = new StandardMaterial("starMaterial", scene);
    material.emissiveColor = new Color3(1.0, 0.92, 0.75);
    material.disableLighting = true;
    mesh.material = material;
  }
}
