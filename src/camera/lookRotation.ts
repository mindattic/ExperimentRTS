import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";

const tmpForward = new Vector3();
const tmpRight = new Vector3();
const tmpUp = new Vector3();
const tmpMatrix = new Matrix();

/**
 * Builds the object-space rotation quaternion for a camera (or any node) whose local +Z axis
 * should point along `forward` (in whatever space - world or a parent's local space - the
 * caller is working in), given a rough `upHint` that doesn't need to already be perpendicular
 * to forward (re-orthonormalized here via cross products, same idea as a standard lookAt).
 *
 * Exists instead of Babylon's own Quaternion.FromLookDirectionLHToRef because that function
 * builds a *view* matrix (world-to-camera), and its relationship to the object-space rotation
 * this codebase needs is NOT a simple conjugate in general - verified empirically: conjugating
 * its result reproduces the intended forward for some inputs but not others (e.g. passing
 * forward=(0,0,1), up=(0,1,0) gives back (0,0,-1) either way, conjugated or not). It was also
 * observed to return a non-unit ("skewed") quaternion whenever forward/up aren't reasonably
 * close to perpendicular - which RtsGroundCamera's steep downward pitch triggers on every
 * frame, not as a rare edge case. Building the rotation matrix directly from an explicit
 * right/up/forward basis sidesteps both problems entirely.
 */
export function computeLookRotationToRef(forward: Vector3, upHint: Vector3, outQuat: Quaternion): void {
  tmpForward.copyFrom(forward).normalize();
  Vector3.CrossToRef(upHint, tmpForward, tmpRight);
  if (tmpRight.lengthSquared() < 1e-9) {
    // upHint is (anti)parallel to forward - fall back to world-Right, which can't be.
    Vector3.CrossToRef(Vector3.Right(), tmpForward, tmpRight);
  }
  tmpRight.normalize();
  Vector3.CrossToRef(tmpForward, tmpRight, tmpUp);
  tmpUp.normalize();

  Matrix.FromValuesToRef(
    tmpRight.x, tmpRight.y, tmpRight.z, 0,
    tmpUp.x, tmpUp.y, tmpUp.z, 0,
    tmpForward.x, tmpForward.y, tmpForward.z, 0,
    0, 0, 0, 1,
    tmpMatrix,
  );
  Quaternion.FromRotationMatrixToRef(tmpMatrix, outQuat);
}
