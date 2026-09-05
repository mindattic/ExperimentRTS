import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { keybindings } from "../input/keybindings";
import { computeLookRotationToRef } from "./lookRotation";

const MOVE_SPEED = 2400; // units/sec - fast enough to cross interplanetary distances in a reasonable time
const RUN_MULTIPLIER = 4; // holding Shift
const LOOK_SENSITIVITY = 0.0025; // radians per pixel of raw mouse movement
/** Exponential blend rate for reorient() - same idea as OrbitTrackballCamera's RELEVEL_RATE. */
const REORIENT_RATE = 4.0;

const tmpForward = new Vector3();
const tmpRight = new Vector3();
const tmpUp = new Vector3();
const tmpMove = new Vector3();
const tmpQuat = new Quaternion();
const tmpMatrix = new Matrix();

/**
 * Unconstrained first-person "swim through space" camera: always in world space (never
 * parented to a body), free movement (WASD, strafing on A/D) relative to its own current
 * facing, true FPS-style mouselook via the Pointer Lock API - no button needs to be held,
 * moving the mouse looks around continuously once active. Toggled on/off independently of
 * orbit/ground mode - see main.ts's freeCam handling for how it hands off to/from whichever
 * mode was active.
 */
export class FreeFlyCamera {
  readonly camera: UniversalCamera;

  private cursorModeActive = false;
  private reorienting = false;
  private readonly reorientTargetRot = new Quaternion();
  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private mouseMoveHandler = (e: MouseEvent) => this.onMouseMove(e);
  private keydownHandler = (e: KeyboardEvent) => this.keys.add(e.code);
  private keyupHandler = (e: KeyboardEvent) => this.keys.delete(e.code);

  constructor(scene: Scene, canvas: HTMLCanvasElement, farClip: number) {
    this.canvas = canvas;
    this.camera = new UniversalCamera("freeFlyCamera", Vector3.Zero(), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.1;
    this.camera.maxZ = farClip;
    this.camera.fov = 0.75;
    this.camera.rotationQuaternion = new Quaternion();
  }

  /** Starts flying from the given world position/orientation (no snap from wherever the previous camera was looking). */
  setPose(position: Vector3, rotationQuaternion: Quaternion): void {
    this.camera.parent = null;
    this.camera.position.copyFrom(position);
    this.camera.rotationQuaternion!.copyFrom(rotationQuaternion);
  }

  attach(): void {
    this.cursorModeActive = false;
    this.requestPointerLockWithRetry();
    window.addEventListener("mousemove", this.mouseMoveHandler);
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
  }

  /** Requesting Pointer Lock from the F-keypress handler that normally calls attach() counts as
   * the user gesture the API requires, and just works. But attach() can also fire from purely
   * wheel-driven input (scrolling out past orbit's max zoom auto-releases to free cam) - wheel
   * events aren't a qualifying "transient activation" gesture for Pointer Lock in browsers, so
   * that request silently rejects and mouselook would otherwise never engage. Falls back to
   * retrying on the next genuine click on the canvas, which does qualify. */
  private requestPointerLockWithRetry(): void {
    const result = this.canvas.requestPointerLock() as unknown;
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {
        const retryOnce = () => {
          this.canvas.removeEventListener("pointerdown", retryOnce);
          if (!this.cursorModeActive && document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock();
        };
        this.canvas.addEventListener("pointerdown", retryOnce);
      });
    }
  }

  detach(): void {
    this.keys.clear();
    window.removeEventListener("mousemove", this.mouseMoveHandler);
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** MMO-style "Alt to free the cursor": pauses mouselook and releases Pointer Lock so the OS
   * cursor reappears and can click on-screen UI, without leaving free cam or stopping WASD
   * movement. onMouseMove already no-ops whenever document.pointerLockElement isn't this canvas
   * (see below), so exiting/re-requesting Pointer Lock alone is enough to pause/resume look -
   * no separate flag needs checking there. */
  setCursorMode(active: boolean): void {
    if (active === this.cursorModeActive) return;
    this.cursorModeActive = active;
    if (active) {
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } else if (document.pointerLockElement !== this.canvas) {
      this.requestPointerLockWithRetry();
    }
  }

  get isCursorModeActive(): boolean {
    return this.cursorModeActive;
  }

  /** Levels pitch/roll back to a flat horizon while keeping the current heading (yaw) - unlike
   * OrbitTrackballCamera's reorient(), which re-levels a free-tumbling roll, FreeFlyCamera's
   * yaw-around-world-up/pitch-around-local-right mouselook can never accumulate roll on its
   * own, so this only ever has pitch to correct. Blends smoothly (same idea as every other
   * camera's programmatic moves in this codebase) rather than snapping. */
  reorient(): void {
    Matrix.FromQuaternionToRef(this.camera.rotationQuaternion!, tmpMatrix);
    Vector3.TransformNormalToRef(Vector3.Forward(), tmpMatrix, tmpForward);
    tmpForward.y = 0;
    if (tmpForward.lengthSquared() < 1e-6) return; // looking almost straight up/down - no well-defined heading to level to
    tmpForward.normalize();
    computeLookRotationToRef(tmpForward, Vector3.Up(), this.reorientTargetRot);
    this.reorienting = true;
  }

  private onMouseMove(e: MouseEvent): void {
    if (document.pointerLockElement !== this.canvas) return; // ignore stray moves before lock engages / after it's lost (e.g. user pressed Escape)
    this.reorienting = false; // manual look input always takes over from a programmatic reorient
    const yaw = e.movementX * LOOK_SENSITIVITY;
    const pitch = e.movementY * LOOK_SENSITIVITY;

    // Yaw around world up, pitch around the camera's own current right - standard FPS
    // mouselook, composed directly onto rotationQuaternion (this is the camera's actual
    // object-space orientation already, not a view matrix, so no inversion is needed here -
    // contrast with RtsGroundCamera/OrbitTrackballCamera's FromLookDirectionLHToRef usage).
    Quaternion.RotationAxisToRef(Vector3.Up(), yaw, tmpQuat);
    this.camera.rotationQuaternion!.multiplyInPlace(tmpQuat);
    Matrix.FromQuaternionToRef(this.camera.rotationQuaternion!, tmpMatrix);
    Vector3.TransformNormalToRef(Vector3.Right(), tmpMatrix, tmpRight);
    Quaternion.RotationAxisToRef(tmpRight, pitch, tmpQuat);
    tmpQuat.multiplyToRef(this.camera.rotationQuaternion!, this.camera.rotationQuaternion!);
  }

  update(deltaSeconds: number): void {
    if (this.reorienting) {
      const blend = 1 - Math.exp(-REORIENT_RATE * deltaSeconds);
      Quaternion.SlerpToRef(this.camera.rotationQuaternion!, this.reorientTargetRot, blend, this.camera.rotationQuaternion!);
      const dot =
        this.camera.rotationQuaternion!.x * this.reorientTargetRot.x +
        this.camera.rotationQuaternion!.y * this.reorientTargetRot.y +
        this.camera.rotationQuaternion!.z * this.reorientTargetRot.z +
        this.camera.rotationQuaternion!.w * this.reorientTargetRot.w;
      if (Math.abs(dot) > 0.9999) this.reorienting = false;
    }

    Matrix.FromQuaternionToRef(this.camera.rotationQuaternion!, tmpMatrix);
    Vector3.TransformNormalToRef(Vector3.Forward(), tmpMatrix, tmpForward);
    Vector3.TransformNormalToRef(Vector3.Right(), tmpMatrix, tmpRight);
    Vector3.TransformNormalToRef(Vector3.Up(), tmpMatrix, tmpUp);

    tmpMove.setAll(0);
    if (this.keys.has(keybindings.get("groundForward"))) tmpMove.addInPlace(tmpForward);
    if (this.keys.has(keybindings.get("groundBackward"))) tmpMove.subtractInPlace(tmpForward);
    if (this.keys.has(keybindings.get("groundRight"))) tmpMove.addInPlace(tmpRight);
    if (this.keys.has(keybindings.get("groundLeft"))) tmpMove.subtractInPlace(tmpRight);
    // Local (camera-relative) up, not world up: mouselook tilts this vector along with the
    // camera's own orientation, so holding moveUp while aiming at a nearby body arcs around it
    // rather than climbing away on a fixed world-vertical line ("if I look at a planet and keep
    // pressing up I will eventually rotate around the planet").
    if (this.keys.has(keybindings.get("moveUp"))) tmpMove.addInPlace(tmpUp);
    if (this.keys.has(keybindings.get("moveDown"))) tmpMove.subtractInPlace(tmpUp);

    if (tmpMove.lengthSquared() > 0) {
      const speed = MOVE_SPEED * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? RUN_MULTIPLIER : 1);
      tmpMove.normalize().scaleInPlace(speed * deltaSeconds);
      this.camera.position.addInPlace(tmpMove);
    }
  }
}
