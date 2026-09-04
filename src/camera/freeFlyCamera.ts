import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { keybindings } from "../input/keybindings";

const MOVE_SPEED = 2400; // units/sec - fast enough to cross interplanetary distances in a reasonable time
const LOOK_SENSITIVITY = 0.006; // radians per pixel of drag

const tmpForward = new Vector3();
const tmpRight = new Vector3();
const tmpUp = new Vector3();
const tmpMove = new Vector3();
const tmpQuat = new Quaternion();
const tmpMatrix = new Matrix();

/**
 * Unconstrained first-person "swim through space" camera: always in world space (never
 * parented to a body), free 6DOF movement (WASD + up/down) relative to its own current
 * facing, drag-to-look. Toggled on/off independently of orbit/ground mode - see main.ts's
 * freeCam handling for how it hands off to/from whichever mode was active.
 */
export class FreeFlyCamera {
  readonly camera: UniversalCamera;

  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pointerDownHandler = (e: PointerEvent) => this.onPointerDown(e);
  private pointerMoveHandler = (e: PointerEvent) => this.onPointerMove(e);
  private pointerUpHandler = () => {
    this.dragging = false;
  };
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
    this.canvas.addEventListener("pointerdown", this.pointerDownHandler);
    window.addEventListener("pointermove", this.pointerMoveHandler);
    window.addEventListener("pointerup", this.pointerUpHandler);
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
  }

  detach(): void {
    this.dragging = false;
    this.keys.clear();
    this.canvas.removeEventListener("pointerdown", this.pointerDownHandler);
    window.removeEventListener("pointermove", this.pointerMoveHandler);
    window.removeEventListener("pointerup", this.pointerUpHandler);
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    const yaw = dx * LOOK_SENSITIVITY;
    const pitch = -dy * LOOK_SENSITIVITY;

    // Yaw around world up, pitch around the camera's own current right - standard free-fly
    // look, composed onto the existing orientation so it works from any starting attitude.
    Quaternion.RotationAxisToRef(Vector3.Up(), yaw, tmpQuat);
    this.camera.rotationQuaternion!.multiplyInPlace(tmpQuat);
    Vector3.TransformNormalToRef(Vector3.Right(), Matrix.FromQuaternionToRef(this.camera.rotationQuaternion!, tmpMatrix), tmpRight);
    Quaternion.RotationAxisToRef(tmpRight, pitch, tmpQuat);
    tmpQuat.multiplyToRef(this.camera.rotationQuaternion!, this.camera.rotationQuaternion!);
  }

  update(deltaSeconds: number): void {
    Matrix.FromQuaternionToRef(this.camera.rotationQuaternion!, tmpMatrix);
    Vector3.TransformNormalToRef(Vector3.Forward(), tmpMatrix, tmpForward);
    Vector3.TransformNormalToRef(Vector3.Right(), tmpMatrix, tmpRight);
    tmpUp.copyFrom(Vector3.Up());

    tmpMove.setAll(0);
    if (this.keys.has(keybindings.get("groundForward"))) tmpMove.addInPlace(tmpForward);
    if (this.keys.has(keybindings.get("groundBackward"))) tmpMove.subtractInPlace(tmpForward);
    if (this.keys.has(keybindings.get("groundRight"))) tmpMove.addInPlace(tmpRight);
    if (this.keys.has(keybindings.get("groundLeft"))) tmpMove.subtractInPlace(tmpRight);
    if (this.keys.has(keybindings.get("groundRotateRight"))) tmpMove.subtractInPlace(tmpUp);
    if (this.keys.has(keybindings.get("groundRotateLeft"))) tmpMove.addInPlace(tmpUp);

    if (tmpMove.lengthSquared() > 0) {
      tmpMove.normalize().scaleInPlace(MOVE_SPEED * deltaSeconds);
      this.camera.position.addInPlace(tmpMove);
    }
  }
}
