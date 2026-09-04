import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";

const DRAG_SENSITIVITY = 0.006; // radians per pixel of drag
const INERTIA_DECAY_PER_SEC = 4.5; // exponential decay rate applied to angular velocity after release
const MIN_SETTLE_VELOCITY = 0.05; // rad/s - below this, inertia is considered stopped
const RELEVEL_RATE = 3.0; // exponential blend rate for auto re-leveling roll once settled
const ZOOM_STEP_FRACTION = 0.12; // fraction of current radius per wheel notch
const RADIUS_LERP_RATE = 4.0; // exponential blend rate for programmatic radius changes (e.g. exit-to-orbit)

const tmpQuat = new Quaternion();
const tmpMatrix = new Matrix();
const tmpRight = new Vector3();
const tmpIdealUp = new Vector3();
const tmpForward = new Vector3();

/**
 * Free trackball orbit camera: drag in any direction to tumble the view around the planet
 * (not constrained to a fixed world "up" axis, unlike a yaw/pitch orbit camera - you can spin
 * past the poles and roll). Releasing the drag carries the last angular velocity as inertia,
 * which decays smoothly; once it settles, the camera's roll auto-relevels (slerps `up` back
 * toward the natural horizon) without changing which point on the planet you're looking at.
 */
export class OrbitTrackballCamera {
  readonly camera: UniversalCamera;
  readonly viewDir = new Vector3(0, 0.35, 1);
  readonly up = new Vector3(0, 1, 0);
  radius: number;
  readonly minRadius: number;
  readonly maxRadius: number;

  private targetRadius: number | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastMoveTime = 0;
  private velYaw = 0;
  private velPitch = 0;
  /** True only while an explicit reorient() is actively blending roll back to level. */
  private reorienting = false;

  private readonly canvas: HTMLCanvasElement;
  private pointerDownHandler = (e: PointerEvent) => this.onPointerDown(e);
  private pointerMoveHandler = (e: PointerEvent) => this.onPointerMove(e);
  private pointerUpHandler = () => this.onPointerUp();
  private wheelHandler = (e: WheelEvent) => this.onWheel(e);

  constructor(scene: Scene, canvas: HTMLCanvasElement, radius: number, minRadius: number, maxRadius: number, farClip: number) {
    this.canvas = canvas;
    this.radius = radius;
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;
    this.viewDir.normalize();

    this.camera = new UniversalCamera("orbitTrackballCamera", Vector3.Zero(), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.1;
    this.camera.maxZ = farClip;
    this.camera.fov = 0.75;
    this.camera.rotationQuaternion = new Quaternion();
  }

  attach(): void {
    this.canvas.addEventListener("pointerdown", this.pointerDownHandler);
    window.addEventListener("pointermove", this.pointerMoveHandler);
    window.addEventListener("pointerup", this.pointerUpHandler);
    this.canvas.addEventListener("wheel", this.wheelHandler, { passive: true });
  }

  detach(): void {
    this.dragging = false;
    this.canvas.removeEventListener("pointerdown", this.pointerDownHandler);
    window.removeEventListener("pointermove", this.pointerMoveHandler);
    window.removeEventListener("pointerup", this.pointerUpHandler);
    this.canvas.removeEventListener("wheel", this.wheelHandler);
  }

  /** Points the camera at `worldPoint` (nearest direction on the sphere), used when handing off from ground mode. */
  setViewDirFromWorldPoint(worldPoint: Vector3): void {
    this.viewDir.copyFrom(worldPoint).normalize();
  }

  /** Smoothly animates the radius toward `target` over the next several frames. */
  flyToRadius(target: number): void {
    this.targetRadius = target;
  }

  get isFlying(): boolean {
    return this.targetRadius !== null;
  }

  /** Cancels any drag/inertia in progress and starts blending roll back to a level horizon at
   * the current view direction (never changes which point on the planet is centered). Roll
   * only ever re-levels via this explicit call - it does not happen automatically on its own
   * when the camera settles. */
  reorient(): void {
    this.dragging = false;
    this.velYaw = 0;
    this.velPitch = 0;
    this.reorienting = true;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.dragging = true;
    this.reorienting = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastMoveTime = performance.now();
    this.velYaw = 0;
    this.velPitch = 0;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const now = performance.now();
    const dtSeconds = Math.max(0.001, (now - this.lastMoveTime) / 1000);
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastMoveTime = now;

    // Sign verified empirically against the rendered view (see the RtsGroundCamera east/west
    // note) - dx's effect on yaw was backwards from what feels natural when dragging.
    const yawAngle = dx * DRAG_SENSITIVITY;
    const pitchAngle = -dy * DRAG_SENSITIVITY;
    this.rotateStep(yawAngle, pitchAngle);
    this.velYaw = yawAngle / dtSeconds;
    this.velPitch = pitchAngle / dtSeconds;
  }

  private onPointerUp(): void {
    this.dragging = false;
  }

  private onWheel(e: WheelEvent): void {
    this.targetRadius = null;
    const factor = 1 + Math.sign(e.deltaY) * ZOOM_STEP_FRACTION;
    this.radius = Math.min(this.maxRadius, Math.max(this.minRadius, this.radius * factor));
  }

  /** Rotates viewDir (and, for the pitch component, up) around the CURRENT local axes - not
   * fixed world axes - so repeated drags can tumble to any orientation instead of getting
   * stuck yawing around a fixed pole. */
  private rotateStep(yawAngle: number, pitchAngle: number): void {
    if (yawAngle !== 0) {
      Quaternion.RotationAxisToRef(this.up, yawAngle, tmpQuat);
      Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
      Vector3.TransformCoordinatesToRef(this.viewDir, tmpMatrix, this.viewDir);
      this.viewDir.normalize();
    }
    if (pitchAngle !== 0) {
      Vector3.CrossToRef(this.up, this.viewDir, tmpRight);
      if (tmpRight.lengthSquared() < 1e-6) return;
      tmpRight.normalize();
      Quaternion.RotationAxisToRef(tmpRight, pitchAngle, tmpQuat);
      Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
      Vector3.TransformCoordinatesToRef(this.viewDir, tmpMatrix, this.viewDir);
      Vector3.TransformCoordinatesToRef(this.up, tmpMatrix, this.up);
      this.viewDir.normalize();
      this.up.normalize();
    }
  }

  update(deltaSeconds: number): void {
    if (!this.dragging) {
      const speed = Math.hypot(this.velYaw, this.velPitch);
      if (speed > MIN_SETTLE_VELOCITY) {
        this.rotateStep(this.velYaw * deltaSeconds, this.velPitch * deltaSeconds);
        const decay = Math.exp(-INERTIA_DECAY_PER_SEC * deltaSeconds);
        this.velYaw *= decay;
        this.velPitch *= decay;
      } else {
        this.velYaw = 0;
        this.velPitch = 0;
      }
    }

    if (this.reorienting && !this.dragging) {
      // Blend `up` toward the natural horizon-aligned up at the current viewDir. Only runs
      // while explicitly requested via reorient() - see that method's doc comment.
      const d = Vector3.Dot(Vector3.Up(), this.viewDir);
      tmpIdealUp.copyFrom(Vector3.Up()).subtractInPlace(this.viewDir.scale(d));
      if (tmpIdealUp.lengthSquared() > 1e-6) {
        tmpIdealUp.normalize();
        const blend = 1 - Math.exp(-RELEVEL_RATE * deltaSeconds);
        Vector3.LerpToRef(this.up, tmpIdealUp, blend, this.up);
        if (Vector3.Dot(this.up, tmpIdealUp) > 0.9999) this.reorienting = false;
      } else {
        this.reorienting = false;
      }
    }

    // Defensive re-orthonormalization against drift from repeated small rotations/lerps.
    const upDotView = Vector3.Dot(this.up, this.viewDir);
    this.up.subtractInPlace(this.viewDir.scale(upDotView));
    this.up.normalize();

    if (this.targetRadius !== null) {
      const blend = 1 - Math.exp(-RADIUS_LERP_RATE * deltaSeconds);
      this.radius += (this.targetRadius - this.radius) * blend;
      if (Math.abs(this.targetRadius - this.radius) < 0.5) {
        this.radius = this.targetRadius;
        this.targetRadius = null;
      }
    }

    this.camera.position.copyFrom(this.viewDir).scaleInPlace(this.radius);
    // Empirically (verified by inspecting the resulting view target), FromLookDirectionLHToRef's
    // "forward" ends up as the camera's local -Z, i.e. the effective look direction comes out
    // negated from what's passed in - so passing viewDir itself (not -viewDir) is what actually
    // points the camera at the origin from its position along +viewDir.
    tmpForward.copyFrom(this.viewDir);
    Quaternion.FromLookDirectionLHToRef(tmpForward, this.up, this.camera.rotationQuaternion!);
  }
}
