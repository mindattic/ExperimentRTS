import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { keybindings } from "../input/keybindings";
import { computeLookRotationToRef } from "./lookRotation";
import { graphicsSettings } from "../settings/graphicsSettings";
import { computeDetourControlPoint, evaluateDetourPath, type PathObstacle } from "./pathAvoidance";
import { applyMouselookDelta, MOUSELOOK_SENSITIVITY, requestPointerLockWithRetry } from "./mouselook";

const DRAG_SENSITIVITY = 0.006; // radians per pixel of drag
const INERTIA_DECAY_PER_SEC = 4.5; // exponential decay rate applied to angular velocity after release
const MIN_SETTLE_VELOCITY = 0.05; // rad/s - below this, inertia is considered stopped
const RELEVEL_RATE = 3.0; // exponential blend rate for auto re-leveling roll once settled
/** Blend rate at graphicsSettings.reorientationStrength = 1 for the CONTINUOUS ambient
 * auto-relevel (separate from the hotkey's own one-shot reorient(), which always uses
 * RELEVEL_RATE regardless of this setting) - high enough that a single frame's blend is
 * visually indistinguishable from an instant snap. */
const MAX_AMBIENT_RELEVEL_RATE = 40.0;
const ZOOM_STEP_FRACTION = 0.12; // fraction of current radius per wheel notch
const RADIUS_LERP_RATE = 4.0; // exponential blend rate for programmatic radius changes (e.g. exit-to-orbit)
const KEY_ROTATE_SPEED = 1.0; // rad/s while a WASD key is held
/** Entry-blend duration bounds for enterFromWorldPose() - same distance-scaled idea as
 * RtsGroundCamera's own ENTRY_BLEND_MIN/MAX_SECONDS/SPEED (see that class's doc comment): free
 * cam can now be committed to orbit from anywhere within collider range of a body, not just a
 * tight "caught by gravity" radius, so a fixed duration would cram arbitrarily large distances
 * into the same short window. Slightly higher floor than RtsGroundCamera's own (0.5 vs 0.35)
 * since entering orbit from free cam is already a bigger, more dramatic transition than the
 * always-short orbit<->ground hop. */
const ENTRY_BLEND_MIN_SECONDS = 0.5;
const ENTRY_BLEND_MAX_SECONDS = 3.0;
const ENTRY_BLEND_SPEED = 3000;
/** How close (in degrees) plane-locked mode's viewDir is allowed to get to `planeAxis` (either
 * pole) - see the pole-clamp block in rotateStep for why this can't be 0. Small enough to be
 * visually imperceptible as a "dead zone" while keeping the pitch-axis cross product safely
 * away from degenerating to zero. */
const POLE_CLAMP_DEGREES = 2;
const MAX_POLE_COS = Math.cos((POLE_CLAMP_DEGREES * Math.PI) / 180);
/** How long releasing right-mouse look-around takes to slerp back to the normal
 * looking-at-the-focused-body orientation. */
const LOOK_RETURN_SECONDS = 0.4;

const tmpQuat = new Quaternion();
const tmpMatrix = new Matrix();
const tmpRight = new Vector3();
const tmpIdealUp = new Vector3();
const tmpForward = new Vector3();
const tmpTargetPos = new Vector3();
const tmpTargetRot = new Quaternion();
const tmpPerp = new Vector3();
const tmpScaledViewDir = new Vector3();

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Component of world-up perpendicular to `viewDir` (the "ideal" horizon-level up at that
 * viewDir), written into `out` - shared by reorient()'s unlocked blend-to-level and the
 * continuous ambient auto-relevel, both of which recompute this every frame while active. */
function computeIdealUpToRef(viewDir: Vector3, out: Vector3): void {
  const d = Vector3.Dot(Vector3.UpReadOnly, viewDir);
  viewDir.scaleToRef(d, tmpScaledViewDir);
  out.copyFrom(Vector3.UpReadOnly).subtractInPlace(tmpScaledViewDir);
}

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
  minRadius: number;
  maxRadius: number;

  private targetRadius: number | null = null;
  /** Set for one frame when the player zooms out past maxRadius while already there - signals
   * the caller to release control back to free cam, mirroring RtsGroundCamera's own
   * requestExitToOrbit at the opposite end of the "swim through the system" continuum. */
  requestExitToFreeCam = false;
  private blendStartPos: Vector3 | null = null;
  private blendStartRot: Quaternion | null = null;
  private blendElapsed = 0;
  /** Lazily computed on the blend's first update() frame, same pattern as RtsGroundCamera's own -
   * see there for why (the actual target position isn't known until then). */
  private blendDurationSeconds: number | null = null;
  /** Obstacles to detour around during the entry blend (see enterFromWorldPose) - typically
   * every other body in the system except whichever one this orbit is entering/leaving. */
  private blendObstacles: readonly PathObstacle[] = [];
  /** Lazily computed alongside blendDurationSeconds - a plain midpoint (degenerating to a
   * straight line) if the direct path doesn't pass through any obstacle. */
  private blendControlPoint: Vector3 | null = null;
  /** When set, added to the local viewDir*radius offset each frame instead of relying on
   * camera.parent to carry a moving anchor - for orbiting something that translates but has no
   * rotating "surface frame" worth inheriting the way a planet's spinNode has (a ship, or an
   * asteroid tracked via AsteroidBelt.getRockWorldPosition). The caller is responsible for
   * setting camera.parent to null itself when using this (same as it already sets camera.parent
   * to a body's spinNode for the planet case - this class never touches parent on its own). */
  private trackPosition: (() => Vector3) | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastMoveTime = 0;
  private velYaw = 0;
  private velPitch = 0;
  /** True only while an explicit reorient() is actively blending roll back to level. */
  private reorienting = false;
  /** True while locked to the solar plane - see setPlaneLocked(). */
  private planeLocked = false;
  /** Reference "up" used for the whole system when plane-locked - world Y approximates the
   * solar plane's normal closely enough (every body's real orbitAxis is only lightly
   * jittered around it - see solarSystem.ts). */
  private readonly planeAxis = Vector3.Up();

  /** True while the right mouse button is held - "looking around from the orbit position"
   * (see onMouseMove) instead of the normal always-facing-the-body view. Position keeps coming
   * from viewDir/radius as usual (unaffected - held fixed, since input that would normally
   * change viewDir is suppressed while this is true - see update()'s own top-level gate);
   * only the camera's rotation is overridden, from lookAroundRot instead of the computed
   * look-at-center orientation. */
  private freeLooking = false;
  private readonly lookAroundRot = new Quaternion();
  /** Set the instant right-mouse is released, holding wherever lookAroundRot was at that
   * moment - update() slerps camera.rotationQuaternion from here back to the normal
   * look-at-center orientation over LOOK_RETURN_SECONDS, then clears this. */
  private returnBlendStartRot: Quaternion | null = null;
  private returnBlendElapsed = 0;

  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private pointerDownHandler = (e: PointerEvent) => this.onPointerDown(e);
  private pointerMoveHandler = (e: PointerEvent) => this.onPointerMove(e);
  private pointerUpHandler = (e: PointerEvent) => this.onPointerUp(e);
  private wheelHandler = (e: WheelEvent) => this.onWheel(e);
  private keydownHandler = (e: KeyboardEvent) => this.keys.add(e.code);
  private keyupHandler = (e: KeyboardEvent) => this.keys.delete(e.code);
  private mouseMoveHandler = (e: MouseEvent) => this.onMouseMove(e);
  private contextMenuHandler = (e: MouseEvent) => e.preventDefault();
  private pointerLockChangeHandler = () => this.onPointerLockChange();

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
    this.requestExitToFreeCam = false;
    this.canvas.addEventListener("pointerdown", this.pointerDownHandler);
    window.addEventListener("pointermove", this.pointerMoveHandler);
    window.addEventListener("pointerup", this.pointerUpHandler);
    this.canvas.addEventListener("wheel", this.wheelHandler, { passive: true });
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
    window.addEventListener("mousemove", this.mouseMoveHandler);
    this.canvas.addEventListener("contextmenu", this.contextMenuHandler);
    document.addEventListener("pointerlockchange", this.pointerLockChangeHandler);
  }

  detach(): void {
    this.dragging = false;
    this.freeLooking = false;
    this.returnBlendStartRot = null;
    this.keys.clear();
    this.canvas.removeEventListener("pointerdown", this.pointerDownHandler);
    window.removeEventListener("pointermove", this.pointerMoveHandler);
    window.removeEventListener("pointerup", this.pointerUpHandler);
    this.canvas.removeEventListener("wheel", this.wheelHandler);
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    window.removeEventListener("mousemove", this.mouseMoveHandler);
    this.canvas.removeEventListener("contextmenu", this.contextMenuHandler);
    document.removeEventListener("pointerlockchange", this.pointerLockChangeHandler);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** The browser force-exits Pointer Lock on its own in some cases (e.g. the user pressing
   * Escape) regardless of anything this class does - without this, freeLooking could get stuck
   * true after the OS already released the lock out from under it. */
  private onPointerLockChange(): void {
    if (document.pointerLockElement !== this.canvas && this.freeLooking) this.stopFreeLook();
  }

  /** Ends look-around (whether from mouse-up or a forced Pointer Lock exit) - captures wherever
   * lookAroundRot currently is as the start of the slerp-back-to-normal blend in update(). */
  private stopFreeLook(): void {
    this.freeLooking = false;
    this.returnBlendStartRot = this.lookAroundRot.clone();
    this.returnBlendElapsed = 0;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Points the camera at `worldPoint` (nearest direction on the sphere), used when handing off from ground mode. */
  setViewDirFromWorldPoint(worldPoint: Vector3): void {
    this.viewDir.copyFrom(worldPoint).normalize();
  }

  /** Like setViewDirFromWorldPoint, but also recomputes a fresh, orthogonal `up` at the new
   * direction instead of leaving the old one in place. Use this (not setViewDirFromWorldPoint
   * alone) whenever viewDir jumps to a direction unrelated to wherever the camera was just
   * looking - e.g. handing back control after Free Cam left the camera facing anywhere for an
   * arbitrary amount of time. A stale `up` can end up nearly parallel to the new viewDir, and
   * update()'s defensive re-orthonormalization then normalizes a near-zero-length vector,
   * corrupting rotationQuaternion (and, downstream, whatever entry blend snapshots it next -
   * e.g. RtsGroundCamera's orbit->ground handoff). */
  resetView(worldPoint: Vector3): void {
    this.viewDir.copyFrom(worldPoint).normalize();
    const d = Vector3.Dot(Vector3.Up(), this.viewDir);
    this.up.copyFrom(Vector3.Up()).subtractInPlace(this.viewDir.scale(d));
    if (this.up.lengthSquared() < 1e-6) {
      // viewDir itself is (anti)parallel to world-Y - world-Right can't be, so fall back to it.
      this.up.copyFrom(Vector3.Right());
    } else {
      this.up.normalize();
    }
  }

  /** Smoothly animates the radius toward `target` over the next several frames. */
  flyToRadius(target: number): void {
    this.targetRadius = target;
  }

  /** Snaps radius to `value` immediately, cancelling any in-flight flyToRadius() - without
   * this, a still-converging flyToRadius from moments earlier (e.g. exitToOrbitMode's flight
   * back up from ground level rarely finishes within a second) silently drags the camera back
   * toward its old target on the very next frame, undoing the snap. */
  setRadius(value: number): void {
    this.targetRadius = null;
    this.radius = value;
  }

  /** Blends position/rotation in from `fromPosition`/`fromRotation` (over a distance-scaled
   * duration - see update()) instead of snapping straight to the pose computed from
   * viewDir/up/radius - used when committing to orbit around a selected target from free cam,
   * so the handoff reads as a continuous flight rather than a jump-cut. Same pattern as
   * RtsGroundCamera's own attach(fromWorldPosition, fromRotation) entry blend. Call update(0)
   * right after to seed camera.position/rotationQuaternion at the blend's t=0 start (exactly
   * `fromPosition`/`fromRotation`) instead of leaving them at whatever stale pose the camera had
   * before.
   * @param obstacles Other bodies to detour around if the straight-line path would pass through
   * one - see pathAvoidance.ts. Pass every body except whichever this orbit is entering/leaving. */
  enterFromWorldPose(fromPosition: Vector3, fromRotation: Quaternion, obstacles: readonly PathObstacle[] = []): void {
    this.blendStartPos = fromPosition.clone();
    this.blendStartRot = fromRotation.clone();
    this.blendElapsed = 0;
    this.blendDurationSeconds = null;
    this.blendObstacles = obstacles;
    this.blendControlPoint = null;
  }

  /** Starts (or stops, if null) tracking a moving world position each frame instead of the
   * normal "parented to a body's rotating spinNode" framing - see trackPosition's own doc
   * comment. Caller must set camera.parent = null itself. */
  trackWorldPosition(getPosition: (() => Vector3) | null): void {
    this.trackPosition = getPosition;
  }

  /** Updates the zoom clamp range - used when focus switches to a body of a different size. */
  setRadiusLimits(minRadius: number, maxRadius: number): void {
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;
  }

  get isFlying(): boolean {
    return this.targetRadius !== null;
  }

  /** Cancels any drag/inertia in progress without also re-leveling roll (contrast reorient()) -
   * needed wherever a fresh orbit session starts without going through enterFromWorldPose's own
   * blend (which already resets these itself) - completeTransit (main.ts) sets the camera up
   * directly instead of blending, so without this, leftover velocity from whatever this
   * long-lived camera instance was doing the last time it was actually orbiting something (drag
   * inertia doesn't decay while free cam/a transit has it detached) immediately started rotating
   * the view away the moment the new session's update() resumed - "I just double click venus, it
   * zoomed in plane locked and then just slid out of camera". */
  resetInertia(): void {
    this.dragging = false;
    this.velYaw = 0;
    this.velPitch = 0;
  }

  /** Cancels any drag/inertia in progress and starts blending back to a level view: in the free
   * (unlocked) trackball mode, that means rolling `up` back to the horizon without changing
   * which point on the planet is centered - see the unlocked branch in update(). In plane-
   * locked mode, `up` is already forced level every single frame regardless (see the
   * unconditional block at the end of update()), so there's nothing for THIS method to do
   * there via roll alone; instead it blends PITCH back toward the equator (viewDir
   * perpendicular to planeAxis), preserving the current yaw/azimuth - undoing a climb toward
   * either pole is this mode's equivalent of "return to a comfortable view" ("reorient should
   * work on orbit mode" - plane-locked is the default there, so unlocked-only releveling meant
   * the hotkey was silently a no-op for most orbit-mode sessions). */
  reorient(): void {
    this.dragging = false;
    this.velYaw = 0;
    this.velPitch = 0;
    this.reorienting = true;
  }

  /** Toggles a constrained mode where the camera can only yaw/pitch around a fixed
   * solar-plane-aligned axis (like a traditional orbit camera) instead of freely tumbling -
   * for when the free trackball's roll gets disorienting. */
  setPlaneLocked(locked: boolean): void {
    this.planeLocked = locked;
  }

  get isPlaneLocked(): boolean {
    return this.planeLocked;
  }

  /** Cancels an in-progress drag retroactively - used by SelectionAreaUI, which shares the
   * same pointerdown/pointermove events: it can't know until its own pick resolves (a frame or
   * so of pointer movement later) whether this gesture is actually a click-drag on a landable
   * body's surface (draw a selection circle) rather than a drag on empty space (orbit the
   * camera), by which point this class has already started rotating. */
  cancelDrag(): void {
    this.dragging = false;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 2) {
      this.freeLooking = true;
      this.returnBlendStartRot = null; // a fresh look-around always wins over an in-progress return blend
      this.lookAroundRot.copyFrom(this.camera.rotationQuaternion!);
      if (document.pointerLockElement !== this.canvas) requestPointerLockWithRetry(this.canvas, () => this.freeLooking);
      return;
    }
    if (e.button !== 0) return;
    this.dragging = true;
    this.reorienting = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastMoveTime = performance.now();
    this.velYaw = 0;
    this.velPitch = 0;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.freeLooking || document.pointerLockElement !== this.canvas) return; // ignore stray moves before lock engages / after it's lost (e.g. Escape)
    applyMouselookDelta(this.lookAroundRot, e.movementX, e.movementY, MOUSELOOK_SENSITIVITY);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.freeLooking || !this.dragging) return;
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

  private onPointerUp(e: PointerEvent): void {
    if (e.button === 2) {
      if (this.freeLooking) this.stopFreeLook();
      return;
    }
    this.dragging = false;
  }

  private onWheel(e: WheelEvent): void {
    // Bases the step on the in-flight target (not the current, still-catching-up radius) so
    // scrolling several notches in quick succession keeps compounding toward a farther target
    // each time, rather than restarting from wherever the lerp has reached so far - the zoom
    // itself always flows via flyToRadius's smoothing, never jumps straight to the new radius.
    const base = this.targetRadius ?? this.radius;
    const factor = 1 + Math.sign(e.deltaY) * ZOOM_STEP_FRACTION;
    const raw = base * factor;
    if (raw > this.maxRadius && base >= this.maxRadius) {
      // Already at the zoom-out limit and still scrolling out further - hand off to free cam
      // (mirrors RtsGroundCamera's own requestExitToOrbit at the opposite end of the continuum).
      this.requestExitToFreeCam = true;
      return;
    }
    this.flyToRadius(Math.min(this.maxRadius, Math.max(this.minRadius, raw)));
  }

  /** Rotates viewDir (and, for the pitch component, up) around the CURRENT local axes - not
   * fixed world axes - so repeated drags can tumble to any orientation instead of getting
   * stuck yawing around a fixed pole. When plane-locked, both yaw and pitch instead rotate
   * around the fixed `planeAxis` (a traditional constrained orbit camera) and `up` is left
   * alone here - update() forces it back to level every frame while locked. */
  private rotateStep(yawAngle: number, pitchAngle: number): void {
    const yawAxis = this.planeLocked ? this.planeAxis : this.up;
    if (yawAngle !== 0) {
      Quaternion.RotationAxisToRef(yawAxis, yawAngle, tmpQuat);
      Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
      Vector3.TransformCoordinatesToRef(this.viewDir, tmpMatrix, this.viewDir);
      this.viewDir.normalize();
    }
    if (pitchAngle !== 0) {
      const pitchAxisRef = this.planeLocked ? this.planeAxis : this.up;
      Vector3.CrossToRef(pitchAxisRef, this.viewDir, tmpRight);
      if (tmpRight.lengthSquared() < 1e-6) return;
      tmpRight.normalize();
      Quaternion.RotationAxisToRef(tmpRight, pitchAngle, tmpQuat);
      Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
      Vector3.TransformCoordinatesToRef(this.viewDir, tmpMatrix, this.viewDir);
      if (!this.planeLocked) {
        Vector3.TransformCoordinatesToRef(this.up, tmpMatrix, this.up);
        this.up.normalize();
      }
      this.viewDir.normalize();
    }

    if (this.planeLocked) {
      // Pull viewDir back onto the MAX_POLE_COS boundary circle if this step pushed it past
      // (or exactly onto) either pole - without this, the pitch-axis cross product above
      // degenerates to zero right at the pole and permanently freezes all further pitch input
      // (yaw alone can't escape either, since yawing around planeAxis while viewDir IS
      // planeAxis is a no-op) - "orbit mode gets locked at the poles, it doesn't get full
      // rotation". Reprojects along the current meridian (azimuth) rather than just clamping,
      // so it reads as hitting a firm limit, not a stuck/dead camera.
      const cosFromPole = Vector3.Dot(this.viewDir, this.planeAxis);
      if (Math.abs(cosFromPole) > MAX_POLE_COS) {
        tmpPerp.copyFrom(this.viewDir).subtractInPlace(this.planeAxis.scale(cosFromPole));
        if (tmpPerp.lengthSquared() < 1e-9) {
          // No stable azimuth to preserve (viewDir landed exactly on the pole in one step, e.g.
          // a huge single-frame drag) - any perpendicular direction is as good as any other.
          tmpPerp.copyFrom(Vector3.RightReadOnly);
          tmpPerp.subtractInPlace(this.planeAxis.scale(Vector3.Dot(tmpPerp, this.planeAxis)));
          if (tmpPerp.lengthSquared() < 1e-9) tmpPerp.copyFrom(Vector3.LeftHandedForwardReadOnly);
        }
        tmpPerp.normalize();
        const sign = cosFromPole >= 0 ? 1 : -1;
        const sinClamped = Math.sqrt(Math.max(0, 1 - MAX_POLE_COS * MAX_POLE_COS));
        tmpPerp.scaleInPlace(sinClamped); // safe: tmpPerp isn't read again after this line
        this.viewDir.copyFrom(this.planeAxis).scaleInPlace(sign * MAX_POLE_COS).addInPlace(tmpPerp);
        this.viewDir.normalize();
      }
    }
  }

  update(deltaSeconds: number): void {
    // Everything below that would normally change viewDir/up (WASD, drag inertia, reorient,
    // ambient auto-relevel, plane-lock's forced-up) is suppressed while right-mouse look-around
    // is active - "looking around from the orbit position" means viewDir/radius (and so the
    // camera's POSITION) stay exactly where they were the moment right-mouse went down; only
    // rotation changes, driven by lookAroundRot instead (see onMouseMove) - restored at the very
    // end of this method once look-around ends (see the position/rotation assignment below).
    if (!this.freeLooking) {
      let keyYaw = 0;
      let keyPitch = 0;
      let keyRoll = 0;
      // Reversed from the keybinding's own literal name ("left should be right, up should be
      // down") - orbitYawRight/orbitPitchUp etc. still name the physical WASD key bound to each
      // action (see keybindings.ts), just inverted here so the resulting rotation direction
      // matches what actually feels correct, rather than what the label alone would suggest.
      if (this.keys.has(keybindings.get("orbitYawRight"))) keyYaw -= 1;
      if (this.keys.has(keybindings.get("orbitYawLeft"))) keyYaw += 1;
      if (this.keys.has(keybindings.get("orbitPitchUp"))) keyPitch -= 1;
      if (this.keys.has(keybindings.get("orbitPitchDown"))) keyPitch += 1;
      if (this.keys.has(keybindings.get("orbitRollRight"))) keyRoll += 1;
      if (this.keys.has(keybindings.get("orbitRollLeft"))) keyRoll -= 1;
      if (keyYaw !== 0 || keyPitch !== 0) {
        this.rotateStep(keyYaw * KEY_ROTATE_SPEED * deltaSeconds, keyPitch * KEY_ROTATE_SPEED * deltaSeconds);
        this.reorienting = false;
      }
      if (keyRoll !== 0) {
        // Tumbles `up` around the current view axis - unlike yaw/pitch (rotateStep), this never
        // touches viewDir itself, so it doesn't change which point on the planet is centered in
        // view, only the camera's own tilt.
        Quaternion.RotationAxisToRef(this.viewDir, keyRoll * KEY_ROTATE_SPEED * deltaSeconds, tmpQuat);
        Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
        Vector3.TransformCoordinatesToRef(this.up, tmpMatrix, this.up);
        this.up.normalize();
        this.reorienting = false;
      }

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
        if (this.planeLocked) {
          // up is already forced level every frame below regardless (see the unconditional
          // planeLocked block) - see reorient()'s own doc comment for why this mode instead
          // blends PITCH back toward the equator (viewDir perpendicular to planeAxis).
          const cosFromPole = Vector3.Dot(this.viewDir, this.planeAxis);
          tmpPerp.copyFrom(this.viewDir).subtractInPlace(this.planeAxis.scale(cosFromPole));
          if (Math.abs(cosFromPole) > 1e-4 && tmpPerp.lengthSquared() > 1e-9) {
            tmpPerp.normalize();
            const blend = 1 - Math.exp(-RELEVEL_RATE * deltaSeconds);
            const nextCos = cosFromPole * (1 - blend);
            const nextSin = Math.sqrt(Math.max(0, 1 - nextCos * nextCos));
            this.viewDir.copyFrom(this.planeAxis).scaleInPlace(nextCos).addInPlace(tmpPerp.scale(nextSin));
            this.viewDir.normalize();
            if (Math.abs(nextCos) < 1e-4) this.reorienting = false;
          } else {
            this.reorienting = false;
          }
        } else {
          // Blend `up` toward the natural horizon-aligned up at the current viewDir - never
          // changes which point on the planet is centered (see reorient()'s own doc comment).
          computeIdealUpToRef(this.viewDir, tmpIdealUp);
          if (tmpIdealUp.lengthSquared() > 1e-6) {
            tmpIdealUp.normalize();
            const blend = 1 - Math.exp(-RELEVEL_RATE * deltaSeconds);
            Vector3.LerpToRef(this.up, tmpIdealUp, blend, this.up);
            if (Vector3.Dot(this.up, tmpIdealUp) > 0.9999) this.reorienting = false;
          } else {
            this.reorienting = false;
          }
        }
      }

      // Continuous ambient auto-relevel, independent of (and stacks harmlessly with) the hotkey's
      // own one-shot reorient() above - see graphicsSettings.reorientationStrength's own comment.
      // Skipped while dragging (fighting manual input would feel bad) or plane-locked (that mode
      // already forces `up` to a fixed formula every frame just below, making this redundant).
      if (!this.dragging && !this.planeLocked && graphicsSettings.reorientationStrength > 0) {
        computeIdealUpToRef(this.viewDir, tmpIdealUp);
        if (tmpIdealUp.lengthSquared() > 1e-6) {
          tmpIdealUp.normalize();
          if (graphicsSettings.reorientationStrength >= 1) {
            this.up.copyFrom(tmpIdealUp);
          } else {
            const rate = graphicsSettings.reorientationStrength * MAX_AMBIENT_RELEVEL_RATE;
            const blend = 1 - Math.exp(-rate * deltaSeconds);
            Vector3.LerpToRef(this.up, tmpIdealUp, blend, this.up);
          }
        }
      }

      if (this.planeLocked) {
        // Force `up` to the plane-perpendicular component of the fixed planeAxis every frame,
        // rather than letting it free-tumble like the unlocked mode does - this is what makes
        // plane-locked feel like a traditional constrained yaw/pitch orbit camera.
        const d = Vector3.Dot(this.planeAxis, this.viewDir);
        this.viewDir.scaleToRef(d, tmpScaledViewDir);
        this.up.copyFrom(this.planeAxis).subtractInPlace(tmpScaledViewDir);
        if (this.up.lengthSquared() < 1e-6) this.up.copyFrom(Vector3.RightReadOnly);
        this.up.normalize();
      }

      // Defensive re-orthonormalization against drift from repeated small rotations/lerps.
      const upDotView = Vector3.Dot(this.up, this.viewDir);
      this.up.subtractInPlace(this.viewDir.scale(upDotView));
      this.up.normalize();

    }

    if (this.targetRadius !== null) {
      const blend = 1 - Math.exp(-RADIUS_LERP_RATE * deltaSeconds);
      this.radius += (this.targetRadius - this.radius) * blend;
      if (Math.abs(this.targetRadius - this.radius) < 0.5) {
        this.radius = this.targetRadius;
        this.targetRadius = null;
      }
    }

    tmpTargetPos.copyFrom(this.viewDir).scaleInPlace(this.radius);
    if (this.trackPosition) tmpTargetPos.addInPlace(this.trackPosition());
    // The camera looks toward the planet center, i.e. the opposite of viewDir (which points
    // from center to camera). See lookRotation.ts for why this goes through
    // computeLookRotationToRef rather than Babylon's own FromLookDirectionLHToRef.
    tmpForward.copyFrom(this.viewDir).scaleInPlace(-1);
    computeLookRotationToRef(tmpForward, this.up, tmpTargetRot);

    if (this.blendStartPos && this.blendStartRot) {
      if (this.blendDurationSeconds === null) {
        const distance = Vector3.Distance(this.blendStartPos, tmpTargetPos);
        this.blendDurationSeconds = Math.min(ENTRY_BLEND_MAX_SECONDS, Math.max(ENTRY_BLEND_MIN_SECONDS, distance / ENTRY_BLEND_SPEED));
        this.blendControlPoint = computeDetourControlPoint(this.blendStartPos, tmpTargetPos, this.blendObstacles);
      }
      this.blendElapsed += deltaSeconds;
      const t = easeOutCubic(Math.min(1, this.blendElapsed / this.blendDurationSeconds));
      evaluateDetourPath(this.blendStartPos, this.blendControlPoint!, tmpTargetPos, t, this.camera.position);
      Quaternion.SlerpToRef(this.blendStartRot, tmpTargetRot, t, this.camera.rotationQuaternion!);
      if (t >= 1) {
        this.blendStartPos = null;
        this.blendStartRot = null;
        this.blendDurationSeconds = null;
        this.blendControlPoint = null;
      }
    } else {
      this.camera.position.copyFrom(tmpTargetPos);
      if (this.freeLooking) {
        this.camera.rotationQuaternion!.copyFrom(this.lookAroundRot);
      } else if (this.returnBlendStartRot) {
        this.returnBlendElapsed += deltaSeconds;
        const t = easeOutCubic(Math.min(1, this.returnBlendElapsed / LOOK_RETURN_SECONDS));
        Quaternion.SlerpToRef(this.returnBlendStartRot, tmpTargetRot, t, this.camera.rotationQuaternion!);
        if (t >= 1) this.returnBlendStartRot = null;
      } else {
        this.camera.rotationQuaternion!.copyFrom(tmpTargetRot);
      }
    }
  }
}
