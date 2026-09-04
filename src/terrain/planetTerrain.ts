import { Color3, Mesh, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { CUBE_FACES } from "./cubeSphere";
import { PlanetHeightfield } from "./heightfield";
import { buildPatchMesh } from "./patchMesh";
import { QuadNode } from "./quadNode";
import { graphicsSettings } from "../settings/graphicsSettings";

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
  private readonly parentNode: TransformNode | null;
  private readonly patchResolution: number;

  constructor(scene: Scene, planetRadius: number, seed: number, parentNode: TransformNode | null = null) {
    this.scene = scene;
    this.planetRadius = planetRadius;
    this.parentNode = parentNode;
    // Captured once at construction (not read live per-patch) so a body's terrain has a
    // consistent resolution throughout its lifetime - the setting takes effect for newly
    // created bodies (next visit or reload), not by retroactively re-meshing existing ones.
    this.patchResolution = graphicsSettings.patchResolution;
    this.heightfield = new PlanetHeightfield(seed);

    this.material = new StandardMaterial("planetTerrainMaterial", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = Color3.Black();
    // The camera's near/far range spans from ground-level (~0.1) out past the star's orbit
    // (~160,000 planet-radii away), a ratio far beyond what a standard depth buffer resolves -
    // without this, the far side of the terrain sphere z-fights and pops through the near
    // side. Logarithmic depth is the standard fix for exactly this planet-scale range.
    this.material.useLogarithmicDepth = true;

    for (const face of CUBE_FACES) {
      const root = new QuadNode(face, -1, -1, 2, 0);
      this.roots.push(root);
      this.generationQueue.push(root);
    }
  }

  /**
   * Call once per frame with the camera's position local to the same parent node the terrain
   * is parented to (not `globalPosition`) - patch centers are stored in that local frame.
   */
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
      this.patchResolution,
      this.planetRadius,
      this.heightfield,
    );
    const mesh = new Mesh(`patch_f${node.face.id}_d${node.depth}_${node.u0.toFixed(4)}_${node.v0.toFixed(4)}`, this.scene);
    vertexData.applyToMesh(mesh, true);
    mesh.material = this.material;
    mesh.parent = this.parentNode;
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
        if (distance > node.boundingRadius * MERGE_FACTOR) {
          // Merging back to the parent patch. Re-enable the parent BEFORE disposing the
          // children (rather than after, alongside them) - otherwise, for the one frame the
          // merge triggers on, the parent is already disabled from a prior frame and the
          // children get disposed before scene.render() ever runs, leaving this patch's
          // footprint with zero enabled meshes: a one-frame gap that reads as a missing
          // square/flicker during camera movement (reproduced headlessly - see git history).
          node.mesh.setEnabled(true);
          this.disposeChildren(node);
        } else {
          node.mesh.setEnabled(false);
          for (const child of node.children) {
            child.mesh!.setEnabled(true);
            this.visit(child, cameraPosition);
          }
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
