import type { Mesh, Vector3 } from "@babylonjs/core";
import type { CubeFace } from "./cubeSphere";

export class QuadNode {
  mesh: Mesh | null = null;
  center: Vector3 | null = null;
  boundingRadius = 0;
  children: QuadNode[] | null = null;
  disposed = false;

  readonly face: CubeFace;
  readonly u0: number;
  readonly v0: number;
  readonly size: number;
  readonly depth: number;

  constructor(face: CubeFace, u0: number, v0: number, size: number, depth: number) {
    this.face = face;
    this.u0 = u0;
    this.v0 = v0;
    this.size = size;
    this.depth = depth;
  }

  createChildren(): QuadNode[] {
    const half = this.size / 2;
    const d = this.depth + 1;
    return [
      new QuadNode(this.face, this.u0, this.v0, half, d),
      new QuadNode(this.face, this.u0 + half, this.v0, half, d),
      new QuadNode(this.face, this.u0, this.v0 + half, half, d),
      new QuadNode(this.face, this.u0 + half, this.v0 + half, half, d),
    ];
  }
}
