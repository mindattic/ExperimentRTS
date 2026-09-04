import { Mesh, StandardMaterial, VertexData, Scene, Color3 } from "@babylonjs/core";
import { mulberry32 } from "../terrain/prng";

const STAR_COUNT = 4000;

/**
 * Distant background stars - single-pixel GL point sprites (StandardMaterial's pointsCloud
 * mode), not modeled billboarded planes, since a point is inherently always camera-facing and
 * dramatically cheaper for thousands of them. Scattered uniformly on a sphere just inside the
 * camera's far clip plane, as close to "fixed at infinity" as this scene's clipping range
 * allows - some parallax is visible when a camera travels all the way out to the outer system,
 * an inherent limit of not having a separate skybox-style unclipped background layer.
 */
export class Starfield {
  constructor(scene: Scene, radius: number, seed = 42) {
    const rand = mulberry32(seed);
    const positions: number[] = [];
    const colors: number[] = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const ringRadius = Math.sqrt(Math.max(0, 1 - u * u));
      positions.push(ringRadius * Math.cos(theta) * radius, u * radius, ringRadius * Math.sin(theta) * radius);
      const brightness = 0.55 + rand() * 0.45;
      colors.push(brightness, brightness, brightness, 1);
    }

    const mesh = new Mesh("starfield", scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.colors = colors;
    vertexData.applyToMesh(mesh);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true; // a point cloud this large has no meaningful bounding sphere to cull against

    const material = new StandardMaterial("starfieldMaterial", scene);
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.pointsCloud = true;
    material.pointSize = 2;
    mesh.material = material;
  }
}
