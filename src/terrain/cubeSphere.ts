import { Vector3 } from "@babylonjs/core";

export interface CubeFace {
  readonly id: number;
  readonly normal: Vector3;
  readonly uAxis: Vector3;
  readonly vAxis: Vector3;
}

/** The 6 faces of the cube the sphere is built from. u/v axes span [-1, 1] across each face. */
export const CUBE_FACES: readonly CubeFace[] = [
  { id: 0, normal: new Vector3(1, 0, 0), uAxis: new Vector3(0, 0, -1), vAxis: new Vector3(0, 1, 0) }, // +X
  { id: 1, normal: new Vector3(-1, 0, 0), uAxis: new Vector3(0, 0, 1), vAxis: new Vector3(0, 1, 0) }, // -X
  { id: 2, normal: new Vector3(0, 1, 0), uAxis: new Vector3(1, 0, 0), vAxis: new Vector3(0, 0, -1) }, // +Y
  { id: 3, normal: new Vector3(0, -1, 0), uAxis: new Vector3(1, 0, 0), vAxis: new Vector3(0, 0, 1) }, // -Y
  { id: 4, normal: new Vector3(0, 0, 1), uAxis: new Vector3(1, 0, 0), vAxis: new Vector3(0, 1, 0) }, // +Z
  { id: 5, normal: new Vector3(0, 0, -1), uAxis: new Vector3(-1, 0, 0), vAxis: new Vector3(0, 1, 0) }, // -Z
];

/**
 * Maps a (face, u, v) coordinate (u, v in [-1, 1]) to a point on the cube, then warps it onto
 * the unit sphere using the standard low-distortion cube->sphere formula (near-equal-area vs a
 * naive normalize).
 */
export function cubeToSphereUnit(face: CubeFace, u: number, v: number, out: Vector3): Vector3 {
  const x = face.normal.x + face.uAxis.x * u + face.vAxis.x * v;
  const y = face.normal.y + face.uAxis.y * u + face.vAxis.y * v;
  const z = face.normal.z + face.uAxis.z * u + face.vAxis.z * v;

  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  const rx = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
  const ry = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
  const rz = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));

  out.set(rx, ry, rz);
  out.normalize();
  return out;
}
