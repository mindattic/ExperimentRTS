import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { keybindings } from "../input/keybindings";

const MOVE_SPEED = 2400; // units/sec - fast enough to cross interplanetary distances in a reasonable time
const RUN_MULTIPLIER = 4; // holding Shift
const LOOK_SENSITIVITY = 0.0025; // radians per pixel of raw mouse movement

const tmpForward = new Vector3();
const tmpRight = new Vector3();
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
    // Requested synchronously from the F-keypress handler that calls attach(), which counts
    // as the user gesture the Pointer Lock API requires.
    this.canvas.requestPointerLock();
    window.addEventListener("mousemove", this.mouseMoveHandler);
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
  }

  detach(): void {
    this.keys.clear();
    window.removeEventListener("mousemove", this.mouseMoveHandler);
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private onMouseMove(e: MouseEvent): void {
    if (document.pointerLockElement !== this.canvas) return; // ignore stray moves before lock engages / after it's lost (e.g. user pressed Escape)
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
    Matrix.FromQuaternionToRef(this.camera.rotationQuaternion!, tmpMatrix);
    Vector3.TransformNormalToRef(Vector3.Forward(), tmpMatrix, tmpForward);
    Vector3.TransformNormalToRef(Vector3.Right(), tmpMatrix, tmpRight);

    tmpMove.setAll(0);
    if (this.keys.has(keybindings.get("groundForward"))) tmpMove.addInPlace(tmpForward);
    if (this.keys.has(keybindings.get("groundBackward"))) tmpMove.subtractInPlace(tmpForward);
    if (this.keys.has(keybindings.get("groundRight"))) tmpMove.addInPlace(tmpRight);
    if (this.keys.has(keybindings.get("groundLeft"))) tmpMove.subtractInPlace(tmpRight);

    if (tmpMove.lengthSquared() > 0) {
      const speed = MOVE_SPEED * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? RUN_MULTIPLIER : 1);
      tmpMove.normalize().scaleInPlace(speed * deltaSeconds);
      this.camera.position.addInPlace(tmpMove);
    }
  }
}
