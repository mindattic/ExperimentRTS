import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import type { PlanetHeightfield } from "../terrain/heightfield";

const PAN_SPEED = 220; // units/sec at planet-surface scale
const MIN_EYE_HEIGHT = 30;
const MAX_EYE_HEIGHT = 160;
const ZOOM_SPEED = 90; // eye-height units per wheel notch
const PITCH_DEG = 55;
/** How long the entry blend from the orbit camera's last position runs. */
const ENTRY_BLEND_SECONDS = 0.35;

const tmpMatrix = new Matrix();
const tmpQuat = new Quaternion();
const tmpEast = new Vector3();
const tmpNorth = new Vector3();
const tmpMove = new Vector3();
const tmpTargetPos = new Vector3();
const tmpLookDir = new Vector3();
const tmpForward = new Vector3();
const tmpTargetRot = new Quaternion();

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Fixed RTS-style ground camera: anchored to a point on the planet's surface, panned with
 * the arrow keys by rotating that anchor around the sphere (never re-projected onto a flat
 * plane, so it can walk seamlessly across cube-face seams and all the way around the
 * planet). Mouse wheel zooms; zooming out past the max eye height signals the caller to
 * hand control back to the orbit camera.
 */
export class RtsGroundCamera {
  readonly camera: UniversalCamera;
  readonly anchor = new Vector3(0, 1, 0);
  eyeHeight = 70;

  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private readonly heightfield: PlanetHeightfield;
  private wheelHandler = (e: WheelEvent) => this.onWheel(e);
  private keydownHandler = (e: KeyboardEvent) => this.keys.add(e.code);
  private keyupHandler = (e: KeyboardEvent) => this.keys.delete(e.code);
  /** Set to true for one frame when the player zooms out past the max eye height. */
  requestExitToOrbit = false;

  private blendStartPos: Vector3 | null = null;
  private blendStartRot: Quaternion | null = null;
  private blendElapsed = 0;

  constructor(scene: Scene, canvas: HTMLCanvasElement, heightfield: PlanetHeightfield) {
    this.canvas = canvas;
    this.heightfield = heightfield;
    this.camera = new UniversalCamera("rtsGroundCamera", Vector3.Zero(), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.1;
    this.camera.maxZ = 100000;
    this.camera.fov = 0.75;
    this.camera.rotationQuaternion = new Quaternion();
  }

  /**
   * @param fromWorldPosition If given (together with fromRotation), the camera position and
   * orientation blend in from these over ENTRY_BLEND_SECONDS instead of snapping straight to
   * the computed ground pose - used to soften the orbit -> ground mode handoff into a real
   * camera movement rather than a cut. Also resets eyeHeight to its max so the handoff reads
   * as a continuation of the zoom that triggered it, not a jump to a close-up view.
   */
  attach(fromWorldPosition?: Vector3, fromRotation?: Quaternion): void {
    this.requestExitToOrbit = false;
    this.eyeHeight = MAX_EYE_HEIGHT;
    if (fromWorldPosition && fromRotation) {
      this.blendStartPos = fromWorldPosition.clone();
      this.blendStartRot = fromRotation.clone();
      this.blendElapsed = 0;
    } else {
      this.blendStartPos = null;
      this.blendStartRot = null;
    }
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
    this.canvas.addEventListener("wheel", this.wheelHandler, { passive: true });
  }

  detach(): void {
    this.keys.clear();
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    this.canvas.removeEventListener("wheel", this.wheelHandler);
  }

  /** Anchors the camera to the nearest point on the sphere to `worldPoint`. */
  setAnchorFromWorldPoint(worldPoint: Vector3): void {
    this.anchor.copyFrom(worldPoint).normalize();
  }

  private onWheel(e: WheelEvent): void {
    const next = this.eyeHeight + Math.sign(e.deltaY) * ZOOM_SPEED;
    if (next > MAX_EYE_HEIGHT && this.eyeHeight >= MAX_EYE_HEIGHT) {
      this.requestExitToOrbit = true;
      return;
    }
    this.eyeHeight = Math.min(MAX_EYE_HEIGHT, Math.max(MIN_EYE_HEIGHT, next));
  }

  private localBasis(east: Vector3, north: Vector3): void {
    // Cross order here is chosen so `east` matches the camera's actual screen-right (verified
    // empirically against the rendered view, not derived analytically) - swapping it flips
    // ArrowLeft/ArrowRight and A/D.
    Vector3.CrossToRef(this.anchor, Vector3.Up(), east);
    if (east.lengthSquared() < 1e-6) {
      Vector3.CrossToRef(this.anchor, Vector3.Forward(), east);
    }
    east.normalize();
    Vector3.CrossToRef(this.anchor, east, north);
    north.normalize();
  }

  update(deltaSeconds: number, planetRadius: number): void {
    this.localBasis(tmpEast, tmpNorth);

    tmpMove.setAll(0);
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) tmpMove.addInPlace(tmpNorth);
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) tmpMove.subtractInPlace(tmpNorth);
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) tmpMove.addInPlace(tmpEast);
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) tmpMove.subtractInPlace(tmpEast);

    if (tmpMove.lengthSquared() > 0) {
      tmpMove.normalize();
      const distance = PAN_SPEED * deltaSeconds;
      const axis = Vector3.Cross(this.anchor, tmpMove).normalize();
      const angle = distance / planetRadius;
      Quaternion.RotationAxisToRef(axis, angle, tmpQuat);
      Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
      Vector3.TransformCoordinatesToRef(this.anchor, tmpMatrix, this.anchor);
      this.anchor.normalize();
      this.localBasis(tmpEast, tmpNorth);
    }

    const elevation = this.heightfield.elevationAt(this.anchor);
    const groundPos = this.anchor.scale(planetRadius + elevation);
    const distanceBack = this.eyeHeight * 0.9;
    const heightUp = this.eyeHeight * Math.sin((PITCH_DEG * Math.PI) / 180);
    const pullback = this.eyeHeight * Math.cos((PITCH_DEG * Math.PI) / 180) + distanceBack;

    tmpTargetPos.copyFrom(groundPos).addInPlace(this.anchor.scale(heightUp)).subtractInPlace(tmpNorth.scale(pullback));

    // Orientation via rotationQuaternion (not setTarget) using `anchor` as up: setTarget's
    // default upVector is world-Y, which is wrong everywhere except near the north pole - in
    // the southern hemisphere it renders the view upside down (terrain appears "in the sky").
    // `anchor` is always the correct local up at the ground point, in any hemisphere.
    tmpLookDir.copyFrom(groundPos).subtractInPlace(tmpTargetPos).normalize();
    tmpForward.copyFrom(tmpLookDir).scaleInPlace(-1); // see OrbitTrackballCamera for the empirically-verified sign convention
    Quaternion.FromLookDirectionLHToRef(tmpForward, this.anchor, tmpTargetRot);

    if (this.blendStartPos && this.blendStartRot) {
      this.blendElapsed += deltaSeconds;
      const t = easeOutCubic(Math.min(1, this.blendElapsed / ENTRY_BLEND_SECONDS));
      Vector3.LerpToRef(this.blendStartPos, tmpTargetPos, t, this.camera.position);
      Quaternion.SlerpToRef(this.blendStartRot, tmpTargetRot, t, this.camera.rotationQuaternion!);
      if (t >= 1) {
        this.blendStartPos = null;
        this.blendStartRot = null;
      }
    } else {
      this.camera.position.copyFrom(tmpTargetPos);
      this.camera.rotationQuaternion!.copyFrom(tmpTargetRot);
    }
  }
}
