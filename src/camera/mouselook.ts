import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";

/** Radians per pixel of raw (Pointer Lock) mouse movement - shared so OrbitTrackballCamera's
 * right-mouse look-around and FreeFlyCamera's own mouselook feel identical. */
export const MOUSELOOK_SENSITIVITY = 0.0025;

const tmpQuat = new Quaternion();
const tmpMatrix = new Matrix();
const tmpRight = new Vector3();

/** Composes a raw mousemove delta onto `target` in place (yaw around world up, then pitch around
 * the camera's own current right) - identical math OrbitTrackballCamera (onto lookAroundRot) and
 * FreeFlyCamera (onto camera.rotationQuaternion) both need for their Pointer Lock mouselook. This
 * is the camera's actual object-space orientation already, not a view matrix, so no inversion is
 * needed here. */
export function applyMouselookDelta(target: Quaternion, movementX: number, movementY: number, sensitivity: number): void {
  const yaw = movementX * sensitivity;
  const pitch = movementY * sensitivity;
  Quaternion.RotationAxisToRef(Vector3.UpReadOnly, yaw, tmpQuat);
  target.multiplyInPlace(tmpQuat);
  Matrix.FromQuaternionToRef(target, tmpMatrix);
  Vector3.TransformNormalToRef(Vector3.RightReadOnly, tmpMatrix, tmpRight);
  Quaternion.RotationAxisToRef(tmpRight, pitch, tmpQuat);
  tmpQuat.multiplyToRef(target, target);
}

/** Requesting Pointer Lock directly from the right-mouse-button pointerdown handler counts as the
 * user gesture the API requires, and just works. Falls back to retrying on the next pointerdown
 * if that specific request happens to reject (e.g. a rapid up/down flick racing a still-pending
 * previous request) - identical pattern OrbitTrackballCamera and FreeFlyCamera both need, just
 * with a different `stillWantsLock` predicate for each. */
export function requestPointerLockWithRetry(canvas: HTMLCanvasElement, stillWantsLock: () => boolean): void {
  const result = canvas.requestPointerLock() as unknown;
  if (result && typeof (result as Promise<void>).catch === "function") {
    (result as Promise<void>).catch(() => {
      const retryOnce = () => {
        canvas.removeEventListener("pointerdown", retryOnce);
        if (stillWantsLock() && document.pointerLockElement !== canvas) canvas.requestPointerLock();
      };
      canvas.addEventListener("pointerdown", retryOnce);
    });
  }
}
