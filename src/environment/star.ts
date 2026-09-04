import { Color3, MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

/**
 * The star itself: fixed at the world origin (a focus of the planet's orbital ellipse - see
 * PlanetMotion, which uses the same origin-at-focus parametrization). It never moves; the
 * planet orbits it.
 */
export class Star {
  constructor(scene: Scene, planetRadius: number) {
    const mesh = MeshBuilder.CreateSphere("star", { diameter: planetRadius * 3, segments: 16 }, scene);
    const material = new StandardMaterial("starMaterial", scene);
    material.emissiveColor = new Color3(1.0, 0.92, 0.75);
    material.disableLighting = true;
    mesh.material = material;
  }
}
