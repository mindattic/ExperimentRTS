import { Color3, Mesh, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { CUBE_FACES } from "./cubeSphere";
import { PlanetHeightfield } from "./heightfield";
import { buildPatchMesh } from "./patchMesh";
import { QuadNode } from "./quadNode";

const PATCH_RESOLUTION = 17;
const MAX_DEPTH = 9;
const SPLIT_FACTOR = 2.0;
const MERGE_FACTOR = 2.6;
const MAX_PATCHES_PER_FRAME = 3;

/**
 * Cube-sphere quadtree LOD terrain: 6 root faces, each recursively subdividing near the
 * camera. Patches are generated a few at a time (budgeted per frame) and swapped in once a
 * full set of 4 children is ready, so zooming in doesn't stutter or show pop-through gaps.
 */
export class PlanetTerrain {
  readonly heightfield: PlanetHeightfield;
  private readonly material: StandardMaterial;
  private readonly roots: QuadNode[] = [];
  private readonly generationQueue: QuadNode[] = [];
  private readonly scene: Scene;
  private readonly planetRadius: number;

  constructor(scene: Scene, planetRadius: number, seed: number) {
    this.scene = scene;
    this.planetRadius = planetRadius;
    this.heightfield = new PlanetHeightfield(seed);

    this.material = new StandardMaterial("planetTerrainMaterial", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = Color3.Black();

    for (const face of CUBE_FACES) {
      const root = new QuadNode(face, -1, -1, 2, 0);
      this.roots.push(root);
      this.generationQueue.push(root);
    }
  }

  /** Call once per frame with the camera's world-space position. */
  update(cameraPosition: Vector3): void {
    this.processGenerationQueue();
    for (const root of this.roots) {
      this.visit(root, cameraPosition);
    }
  }

  private processGenerationQueue(): void {
    let budget = MAX_PATCHES_PER_FRAME;
    while (budget > 0 && this.generationQueue.length > 0) {
      const node = this.generationQueue.shift()!;
      if (node.disposed) continue;
      this.generatePatch(node);
      budget--;
    }
  }

  private generatePatch(node: QuadNode): void {
    const { vertexData, center, boundingRadius } = buildPatchMesh(
      node.face,
      node.u0,
      node.v0,
      node.size,
      PATCH_RESOLUTION,
      this.planetRadius,
      this.heightfield,
    );
    const mesh = new Mesh(`patch_f${node.face.id}_d${node.depth}_${node.u0.toFixed(4)}_${node.v0.toFixed(4)}`, this.scene);
    vertexData.applyToMesh(mesh, true);
    mesh.material = this.material;
    mesh.setEnabled(false);
    node.mesh = mesh;
    node.center = center;
    node.boundingRadius = boundingRadius;
  }

  private visit(node: QuadNode, cameraPosition: Vector3): void {
    if (!node.mesh || !node.center) return;

    const distance = Vector3.Distance(cameraPosition, node.center);

    if (node.children) {
      const allReady = node.children.every((c) => c.mesh !== null);
      if (allReady) {
        node.mesh.setEnabled(false);
        for (const child of node.children) {
          child.mesh!.setEnabled(true);
          this.visit(child, cameraPosition);
        }
        if (distance > node.boundingRadius * MERGE_FACTOR) {
          this.disposeChildren(node);
        }
      } else {
        node.mesh.setEnabled(true);
        for (const child of node.children) {
          child.mesh?.setEnabled(false);
        }
      }
    } else {
      node.mesh.setEnabled(true);
      if (distance < node.boundingRadius * SPLIT_FACTOR && node.depth < MAX_DEPTH) {
        node.children = node.createChildren();
        for (const child of node.children) {
          this.generationQueue.push(child);
        }
      }
    }
  }

  private disposeChildren(node: QuadNode): void {
    if (!node.children) return;
    for (const child of node.children) {
      child.disposed = true;
      this.disposeChildren(child);
      child.mesh?.dispose();
      child.mesh = null;
    }
    node.children = null;
  }
}
