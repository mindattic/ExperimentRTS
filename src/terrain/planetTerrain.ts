import { Color3, Mesh, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { CUBE_FACES } from "./cubeSphere";
import { PlanetHeightfield } from "./heightfield";
import { buildPatchMesh } from "./patchMesh";
import { QuadNode } from "./quadNode";
import { graphicsSettings } from "../settings/graphicsSettings";
import { AU_IN_SCENE_UNITS } from "../solarSystem/scale";

const MAX_DEPTH = 9;
/** Raised from 2.0 ("planets need to be full resolution at 5000 or less away") - patches now
 * split noticeably sooner relative to their own size, reaching meaningfully finer detail at
 * typical orbit-viewing distances instead of only within a few dozen units of the surface.
 * Empirically measured (not purely derived): a single global multiplier here can't make MAX_DEPTH
 * (9) itself reachable at an absolute distance like 5000 without exploding patch count/GPU cost
 * (verified live: SPLIT_FACTOR=12 dropped FPS from ~50 to ~11 at 1000 units above Earth's
 * surface) - this value is the highest that stayed comfortably playable (~30fps) in that same
 * test. Reaching genuinely full resolution at 5000 for a body this size would need a different,
 * non-geometric LOD curve (e.g. true screen-space error), not just a bigger constant here. */
const SPLIT_FACTOR = 4.0;
const MERGE_FACTOR = 5.2; // same 1.3x hysteresis ratio over SPLIT_FACTOR as before (2.6/2.0)
const MAX_PATCHES_PER_FRAME = 3;
/** Depth cap used only when graphicsSettings.forceMaxTerrainDetail is on ("what does full detail
 * look like from far away") - deliberately much lower than MAX_DEPTH. Forcing the REAL max depth
 * everywhere is computationally infeasible: 6 faces * 4^9 leaves each is ~1.57 million patches.
 * At depth 6, 6*4^6 = ~24,576 patches is still a genuinely heavy preview, but is at least
 * plausible to actually render. */
const FORCE_DETAIL_MAX_DEPTH = 6;

/** Distance-from-camera-to-body-center (scene units) -> max allowed quadtree depth, computed
 * once at module load rather than re-derived every frame - "planets should be full resolution
 * until they are greater than 1 AU away from player camera; then the level of detail drops off
 * with increased distance ... precalculate those LOD changes so that it doesn't dynamically do
 * it every time it needs to drop LOD". Within 1 AU, this never constrains anything (maxDepthFor
 * returns MAX_DEPTH, the existing per-patch relative SPLIT_FACTOR/MERGE_FACTOR logic is already
 * the effective limit); beyond it, this caps the WHOLE planet's depth regardless of how close an
 * individual patch's own distance heuristic might otherwise allow, tapering off geometrically
 * (each breakpoint doubles the distance and halves the depth) so distant, no-longer-orbited
 * bodies don't keep paying for terrain detail nobody's close enough to see. Beyond the last
 * breakpoint, capped at 0 (a single coarse patch per cube face). */
const LOD_DISTANCE_BREAKPOINTS: ReadonlyArray<{ readonly distance: number; readonly maxDepth: number }> = [
  { distance: AU_IN_SCENE_UNITS * 1, maxDepth: MAX_DEPTH },
  { distance: AU_IN_SCENE_UNITS * 2, maxDepth: 6 },
  { distance: AU_IN_SCENE_UNITS * 4, maxDepth: 4 },
  { distance: AU_IN_SCENE_UNITS * 8, maxDepth: 2 },
  { distance: AU_IN_SCENE_UNITS * 16, maxDepth: 1 },
];

function maxDepthForDistance(distanceToCameraFromCenter: number): number {
  for (const breakpoint of LOD_DISTANCE_BREAKPOINTS) {
    if (distanceToCameraFromCenter <= breakpoint.distance) return breakpoint.maxDepth;
  }
  return 0;
}

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
    // cameraPosition is already local to this body's own parent node (spinNode), i.e. the
    // body's center is the local-frame origin - its length() IS the camera's distance to the
    // body's center, no extra computation needed. Depends only on this, not any individual
    // patch, so it's the same for every patch this frame - computed once here, not per-visit().
    const globalMaxDepth = maxDepthForDistance(cameraPosition.length());
    for (const root of this.roots) {
      this.visit(root, cameraPosition, globalMaxDepth);
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

  private visit(node: QuadNode, cameraPosition: Vector3, globalMaxDepth: number): void {
    if (!node.mesh || !node.center) return;

    const distance = Vector3.Distance(cameraPosition, node.center);

    const forceMaxDetail = graphicsSettings.forceMaxTerrainDetail;

    if (node.children) {
      const allReady = node.children.every((c) => c.mesh !== null);
      // Depth-capped children (their own depth already at globalMaxDepth) never get to split
      // further regardless of distance, but existing deeper children from before the camera
      // moved farther away still need to merge back up - forcing a merge here (independent of
      // the usual MERGE_FACTOR distance check) is what actually enforces the 1 AU falloff,
      // rather than just preventing new splits past it.
      const overDepthCap = node.children[0].depth > globalMaxDepth;
      if (allReady) {
        if (!forceMaxDetail && (overDepthCap || distance > node.boundingRadius * MERGE_FACTOR)) {
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
            this.visit(child, cameraPosition, globalMaxDepth);
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
      const maxDepth = forceMaxDetail ? FORCE_DETAIL_MAX_DEPTH : Math.min(MAX_DEPTH, globalMaxDepth);
      const shouldSplit = forceMaxDetail || distance < node.boundingRadius * SPLIT_FACTOR;
      if (shouldSplit && node.depth < maxDepth) {
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
