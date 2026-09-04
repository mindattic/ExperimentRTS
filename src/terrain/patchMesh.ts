import { Vector3, VertexData } from "@babylonjs/core";
import { cubeToSphereUnit, type CubeFace } from "./cubeSphere";
import type { PlanetHeightfield } from "./heightfield";

export interface PatchMeshData {
  vertexData: VertexData;
  /** Approx world-space center of the patch, used for LOD distance checks. */
  center: Vector3;
  /** Approx world-space size (center to corner), used for LOD distance checks. */
  boundingRadius: number;
}

const scratch = new Vector3();

const LOW_COLOR: readonly number[] = [0.5, 0.38, 0.25];
const MID_COLOR: readonly number[] = [0.8, 0.65, 0.45];
// Mountain rock, not pale sandstone: a deep, saturated rust/umber so peaks read as higher and
// harder than the surrounding dunes rather than fading out light.
const HIGH_COLOR: readonly number[] = [0.32, 0.17, 0.12];

function colorForElevation(elevation: number, out: number[]) {
  const t = Math.min(1, Math.max(0, (elevation + 15) / 55));
  const [a, b, k] = t < 0.55 ? [LOW_COLOR, MID_COLOR, t / 0.55] : [MID_COLOR, HIGH_COLOR, (t - 0.55) / 0.45];
  out.push(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1);
}

/**
 * Builds a heightfield-displaced grid mesh for one quadtree patch, in face-local UV space
 * `[u0, u0+size] x [v0, v0+size]`. Adds a downward skirt on all 4 borders so neighboring
 * patches at a different LOD (or across a cube-face seam) don't show gaps.
 */
export function buildPatchMesh(
  face: CubeFace,
  u0: number,
  v0: number,
  size: number,
  resolution: number,
  planetRadius: number,
  heightfield: PlanetHeightfield,
): PatchMeshData {
  const res = resolution;
  const step = size / (res - 1);

  // Sample one extra ring of vertices past every edge, used only to derive normals. Two
  // neighboring same-depth patches both sample this same continuous heightfield just past
  // their shared border, so they end up computing identical border normals - without this,
  // each patch's edge normal is a one-sided average (only its own interior triangles) and
  // visibly mismatches its neighbor's, producing a faint shading seam at every patch edge.
  const extRes = res + 2;
  const extPositions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  for (let j = -1; j <= res; j++) {
    const v = v0 + step * j;
    for (let i = -1; i <= res; i++) {
      const u = u0 + step * i;
      cubeToSphereUnit(face, u, v, scratch);
      const elevation = heightfield.elevationAt(scratch);
      const r = planetRadius + elevation;
      extPositions.push(scratch.x * r, scratch.y * r, scratch.z * r);
      if (i >= 0 && i < res && j >= 0 && j < res) {
        uvs.push(i / (res - 1), j / (res - 1));
        colorForElevation(elevation, colors);
      }
    }
  }

  const extIdx = (i: number, j: number) => (j + 1) * extRes + (i + 1);
  const extIndices: number[] = [];
  for (let j = -1; j < res; j++) {
    for (let i = -1; i < res; i++) {
      const a = extIdx(i, j);
      const b = extIdx(i + 1, j);
      const c = extIdx(i + 1, j + 1);
      const d = extIdx(i, j + 1);
      extIndices.push(a, c, b, a, d, c);
    }
  }
  const extNormals: number[] = [];
  VertexData.ComputeNormals(extPositions, extIndices, extNormals);

  const idx = (i: number, j: number) => j * res + i;
  const positions: number[] = new Array(res * res * 3);
  const normals: number[] = new Array(res * res * 3);
  const indices: number[] = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const dst = idx(i, j);
      const src = extIdx(i, j);
      positions[dst * 3] = extPositions[src * 3];
      positions[dst * 3 + 1] = extPositions[src * 3 + 1];
      positions[dst * 3 + 2] = extPositions[src * 3 + 2];
      normals[dst * 3] = extNormals[src * 3];
      normals[dst * 3 + 1] = extNormals[src * 3 + 1];
      normals[dst * 3 + 2] = extNormals[src * 3 + 2];
    }
  }
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i + 1, j + 1);
      const d = idx(i, j + 1);
      indices.push(a, c, b, a, d, c);
    }
  }

  const skirtDepth = Math.max(planetRadius * size * 0.015, 3);
  const addSkirtEdge = (edgeIndex: (k: number) => number, reverseWinding: boolean) => {
    const base = positions.length / 3;
    for (let k = 0; k < res; k++) {
      const srcIdx = edgeIndex(k);
      const px = positions[srcIdx * 3];
      const py = positions[srcIdx * 3 + 1];
      const pz = positions[srcIdx * 3 + 2];
      const len = Math.sqrt(px * px + py * py + pz * pz);
      const scale = (len - skirtDepth) / len;
      positions.push(px * scale, py * scale, pz * scale);
      uvs.push(uvs[srcIdx * 2], uvs[srcIdx * 2 + 1]);
      colors.push(colors[srcIdx * 4], colors[srcIdx * 4 + 1], colors[srcIdx * 4 + 2], colors[srcIdx * 4 + 3]);
      normals.push(normals[srcIdx * 3], normals[srcIdx * 3 + 1], normals[srcIdx * 3 + 2]);
    }
    for (let k = 0; k < res - 1; k++) {
      const top0 = edgeIndex(k);
      const top1 = edgeIndex(k + 1);
      const bot0 = base + k;
      const bot1 = base + k + 1;
      if (reverseWinding) {
        indices.push(top0, bot1, top1, top0, bot0, bot1);
      } else {
        indices.push(top1, bot0, top0, top1, bot1, bot0);
      }
    }
  };

  addSkirtEdge((k) => idx(k, 0), false);
  addSkirtEdge((k) => idx(k, res - 1), true);
  addSkirtEdge((k) => idx(0, k), true);
  addSkirtEdge((k) => idx(res - 1, k), false);

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.uvs = uvs;
  vertexData.colors = colors;

  cubeToSphereUnit(face, u0 + size / 2, v0 + size / 2, scratch);
  const center = scratch.scale(planetRadius);
  cubeToSphereUnit(face, u0, v0, scratch);
  const corner = scratch.scale(planetRadius);
  const boundingRadius = Vector3.Distance(center, corner);

  return { vertexData, center, boundingRadius };
}
