import { Matrix, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import type { PlanetHeightfield } from "../terrain/heightfield";
import { keybindings } from "../input/keybindings";
import { computeLookRotationToRef } from "./lookRotation";

const PAN_SPEED = 220; // units/sec at planet-surface scale
const MIN_EYE_HEIGHT = 30;
// Also the starting altitude on every fresh entry into ground mode (see attach()) - doubled
// per "RTS view needs to start at twice the altitude". The existing ENTRY_BLEND_SECONDS
// lerp/slerp from the orbit camera's last pose already carries this through smoothly; it
// isn't a separate thing to build, just a consequence of raising this constant.
const MAX_EYE_HEIGHT = 320;
const ZOOM_SPEED = 90; // eye-height units per wheel notch
/** Exponential blend rate for zoom - same idea as OrbitTrackballCamera's RADIUS_LERP_RATE, just
 * a bit snappier since ground mode's eye-height range is much smaller/finer-grained. */
const EYE_HEIGHT_LERP_RATE = 6.0;
const PITCH_DEG = 55;
const HEADING_ROTATE_SPEED = 1.2; // rad/s while a rotate key is held
/** How long the entry blend from the orbit camera's last position runs. */
const ENTRY_BLEND_SECONDS = 0.35;
/** Ground-plane units of pan per pixel of drag, per unit of eyeHeight (so drag feels
 * proportionally "grabbier" when zoomed further out, like dragging a map). */
const DRAG_PAN_SENSITIVITY = 0.012;
/** Radians per pixel of right-drag for free-look. */
const LOOK_SENSITIVITY = 0.0055;
/** How far up/down free-look can tilt away from the base framing pitch, radians (~80 degrees) -
 * generous enough to spot a target on another planet or moon high in the sky, short of a full
 * flip past the pole. */
const MAX_LOOK_PITCH = 1.4;
/** Exponential decay rate applied to free-look angular velocity after releasing the drag - same
 * idea as OrbitTrackballCamera's inertia, so free-look eases to a stop instead of snapping,
 * matching the "organic" feel of every other camera motion in the app. Higher than the orbit
 * camera's own decay (4.5) - free-look is for aiming at a specific target, so it settles
 * quickly rather than sailing well past wherever the drag let go. */
const LOOK_INERTIA_DECAY_PER_SEC = 10.0;
const MIN_LOOK_SETTLE_VELOCITY = 0.05;
const MAX_LOOK_ANGULAR_VELOCITY = 12.0; // rad/sec

const tmpMatrix = new Matrix();
const tmpQuat = new Quaternion();
const tmpEast = new Vector3();
const tmpNorth = new Vector3();
const tmpMove = new Vector3();
const tmpTargetPos = new Vector3();
const tmpLookDir = new Vector3();
const tmpTargetRot = new Quaternion();
const tmpPanAxis = new Vector3();
const tmpHeadingQuat = new Quaternion();
const tmpHeadingMatrix = new Matrix();
const tmpRotatedEast = new Vector3();
const tmpRotatedNorth = new Vector3();
const tmpHoverPoint = new Vector3();
const tmpHoverDir = new Vector3();
const tmpLookOffsetQuat = new Quaternion();
/** Minimum clearance kept above the higher of (anchor elevation, hover-point elevation), so the camera never scrapes nearby terrain even when it's steeper than right under the anchor. */
const MIN_CLEARANCE = 35;

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Fixed RTS-style ground camera: anchored to a point on the planet's surface, panned with
 * the arrow keys by rotating that anchor around the sphere (never re-projected onto a flat
 * plane, so it can walk seamlessly across cube-face seams and all the way around the
 * planet). Mouse wheel zooms; zooming out past the max eye height signals the caller to
 * hand control back to the orbit camera. Right-drag free-looks in place (independent of the
 * fixed framing pitch/panning direction) so the player can tilt up to spot and target a
 * distant body - e.g. selecting a rocket launcher, then looking up to pick a target on
 * another planet or moon - without moving off the anchor point.
 */
export class RtsGroundCamera {
  readonly camera: UniversalCamera;
  readonly anchor = new Vector3(0, 1, 0);
  eyeHeight = 70;
  /** In-flight zoom destination - see onWheel/update. Mirrors OrbitTrackballCamera's
   * targetRadius so scroll zoom flows smoothly here too instead of jumping straight to the new
   * eye height. */
  private targetEyeHeight: number | null = null;
  /** Yaw offset applied on top of the anchor's natural north-facing tangent frame, rotated
   * with the groundRotateLeft/Right keys (Q/E by default) - rotates both the view and the
   * pan directions together. */
  private heading = 0;
  /** Base (heading-free) tangent-frame basis at the anchor - parallel-transported frame to
   * frame as the anchor moves (see transportBasis()), NOT recomputed fresh from a fixed
   * global "up" reference every frame. A sphere has no continuous, singularity-free tangent
   * frame derivable from a single global pole (hairy ball theorem) - cross(Vector3.Up(),
   * anchor) degenerates to zero right at that pole and flips direction near it, which is
   * exactly what made panning break down there. Parallel transport has no such singularity
   * anywhere on the sphere, at the cost of accumulating a small twist after a full loop around
   * a pole - acceptable here since nothing in this procedural terrain cares about true north. */
  private east = new Vector3(1, 0, 0);
  private north = new Vector3(0, 0, 1);
  /** Free-look yaw/pitch, right-drag - layered on top of the fixed framing look direction
   * without affecting it, so WASD/arrow panning always stays relative to the same ground
   * frame regardless of which way the player is currently looking. */
  private lookYaw = 0;
  private lookPitch = 0;
  private velLookYaw = 0;
  private velLookPitch = 0;

  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private heightfield: PlanetHeightfield;
  private wheelHandler = (e: WheelEvent) => this.onWheel(e);
  private keydownHandler = (e: KeyboardEvent) => this.keys.add(e.code);
  private keyupHandler = (e: KeyboardEvent) => this.keys.delete(e.code);
  private pointerDownHandler = (e: PointerEvent) => this.onPointerDown(e);
  private pointerMoveHandler = (e: PointerEvent) => this.onPointerMove(e);
  private pointerUpHandler = (e: PointerEvent) => this.onPointerUp(e);
  private contextMenuHandler = (e: MouseEvent) => e.preventDefault();
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private pendingPanEast = 0;
  private pendingPanNorth = 0;
  /** True while right-drag free-look is active. */
  private looking = false;
  private lastLookX = 0;
  private lastLookY = 0;
  private lastLookMoveTime = 0;
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
    this.targetEyeHeight = null;
    // Free-look doesn't carry over between ground-mode sessions - re-entering always starts
    // from the neutral base framing, not wherever a previous visit happened to leave it tilted.
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.velLookYaw = 0;
    this.velLookPitch = 0;
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
    this.canvas.addEventListener("pointerdown", this.pointerDownHandler);
    window.addEventListener("pointermove", this.pointerMoveHandler);
    window.addEventListener("pointerup", this.pointerUpHandler);
    this.canvas.addEventListener("contextmenu", this.contextMenuHandler);
  }

  detach(): void {
    this.keys.clear();
    this.dragging = false;
    this.looking = false;
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    this.canvas.removeEventListener("wheel", this.wheelHandler);
    this.canvas.removeEventListener("pointerdown", this.pointerDownHandler);
    window.removeEventListener("pointermove", this.pointerMoveHandler);
    window.removeEventListener("pointerup", this.pointerUpHandler);
    this.canvas.removeEventListener("contextmenu", this.contextMenuHandler);
  }

  /** Anchors the camera to the nearest point on the sphere to `worldPoint`, and (re)establishes
   * a fresh tangent-frame basis there - safe to derive from a fixed global reference here since
   * it's a one-off jump to an unrelated point (e.g. the orbit-mode handoff), not the continuous
   * panning that the fixed-reference approach breaks down for (see the `east`/`north` doc). */
  setAnchorFromWorldPoint(worldPoint: Vector3): void {
    this.anchor.copyFrom(worldPoint).normalize();
    Vector3.CrossToRef(Vector3.Up(), this.anchor, this.east);
    if (this.east.lengthSquared() < 1e-6) {
      Vector3.CrossToRef(Vector3.Forward(), this.anchor, this.east);
    }
    this.east.normalize();
    Vector3.CrossToRef(this.anchor, this.east, this.north);
    this.north.normalize();
  }

  /** Switches which body's heightfield ground mode samples - used when focus changes to a different landable body. */
  setHeightfield(heightfield: PlanetHeightfield): void {
    this.heightfield = heightfield;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 0) {
      this.dragging = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
    } else if (e.button === 2) {
      this.looking = true;
      this.velLookYaw = 0;
      this.velLookPitch = 0;
      this.lastLookX = e.clientX;
      this.lastLookY = e.clientY;
      this.lastLookMoveTime = performance.now();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragging) {
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      // Drag-the-map convention: dragging left pans the view the way ArrowRight does (as if
      // grabbing the ground and pulling it under the cursor), scaled by eyeHeight so it stays
      // proportionally grabby whether zoomed in close or pulled back.
      const scale = DRAG_PAN_SENSITIVITY * this.eyeHeight;
      this.pendingPanEast += -dx * scale;
      this.pendingPanNorth += dy * scale;
    }

    if (this.looking) {
      const now = performance.now();
      const dtSeconds = Math.max(0.001, (now - this.lastLookMoveTime) / 1000);
      const dx = e.clientX - this.lastLookX;
      const dy = e.clientY - this.lastLookY;
      this.lastLookX = e.clientX;
      this.lastLookY = e.clientY;
      this.lastLookMoveTime = now;
      const yawDelta = dx * LOOK_SENSITIVITY;
      const pitchDelta = dy * LOOK_SENSITIVITY;
      this.lookYaw += yawDelta;
      this.lookPitch = Math.min(MAX_LOOK_PITCH, Math.max(-MAX_LOOK_PITCH, this.lookPitch + pitchDelta));
      // Clamped so a burst of pointermove events with a near-zero gap between them (can happen
      // with high-polling-rate mice, or a very fast flick) can't produce a runaway instantaneous
      // velocity that then takes the inertia decay well past where the drag itself let go.
      this.velLookYaw = Math.min(MAX_LOOK_ANGULAR_VELOCITY, Math.max(-MAX_LOOK_ANGULAR_VELOCITY, yawDelta / dtSeconds));
      this.velLookPitch = Math.min(MAX_LOOK_ANGULAR_VELOCITY, Math.max(-MAX_LOOK_ANGULAR_VELOCITY, pitchDelta / dtSeconds));
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button === 0) this.dragging = false;
    else if (e.button === 2) this.looking = false;
  }

  private onWheel(e: WheelEvent): void {
    // Same "compound onto the in-flight target, not the still-catching-up current value"
    // approach as OrbitTrackballCamera.onWheel.
    const base = this.targetEyeHeight ?? this.eyeHeight;
    const next = base + Math.sign(e.deltaY) * ZOOM_SPEED;
    if (next > MAX_EYE_HEIGHT && base >= MAX_EYE_HEIGHT) {
      this.requestExitToOrbit = true;
      return;
    }
    this.targetEyeHeight = Math.min(MAX_EYE_HEIGHT, Math.max(MIN_EYE_HEIGHT, next));
  }

  /** Copies out the current working east/north (the persistent, parallel-transported base
   * frame with the player's heading offset applied on top) - call fresh each time either is
   * needed, since `heading` can change independently of the base frame. */
  private applyHeading(east: Vector3, north: Vector3): void {
    east.copyFrom(this.east);
    north.copyFrom(this.north);
    if (this.heading !== 0) {
      Quaternion.RotationAxisToRef(this.anchor, this.heading, tmpHeadingQuat);
      Matrix.FromQuaternionToRef(tmpHeadingQuat, tmpHeadingMatrix);
      Vector3.TransformCoordinatesToRef(east, tmpHeadingMatrix, tmpRotatedEast);
      Vector3.TransformCoordinatesToRef(north, tmpHeadingMatrix, tmpRotatedNorth);
      east.copyFrom(tmpRotatedEast);
      north.copyFrom(tmpRotatedNorth);
    }
  }

  /** Carries the persistent base frame along by the same rotation that just moved the anchor
   * (parallel transport), then re-orthonormalizes against the anchor's new position to correct
   * numerical drift - this is what replaces recomputing east/north from a fixed global "up"
   * reference every frame, and is the part with no pole singularity. */
  private transportBasis(rotationMatrix: Matrix): void {
    Vector3.TransformCoordinatesToRef(this.east, rotationMatrix, this.east);
    const eastDotAnchor = Vector3.Dot(this.east, this.anchor);
    this.east.subtractInPlace(this.anchor.scale(eastDotAnchor));
    this.east.normalize();
    Vector3.CrossToRef(this.anchor, this.east, this.north);
    this.north.normalize();
  }

  update(deltaSeconds: number, planetRadius: number): void {
    if (this.targetEyeHeight !== null) {
      const blend = 1 - Math.exp(-EYE_HEIGHT_LERP_RATE * deltaSeconds);
      this.eyeHeight += (this.targetEyeHeight - this.eyeHeight) * blend;
      if (Math.abs(this.targetEyeHeight - this.eyeHeight) < 0.25) {
        this.eyeHeight = this.targetEyeHeight;
        this.targetEyeHeight = null;
      }
    }

    if (this.keys.has(keybindings.get("groundRotateRight"))) this.heading += HEADING_ROTATE_SPEED * deltaSeconds;
    if (this.keys.has(keybindings.get("groundRotateLeft"))) this.heading -= HEADING_ROTATE_SPEED * deltaSeconds;

    if (!this.looking) {
      // Ease free-look to a stop after release, same idea as OrbitTrackballCamera's drag
      // inertia, so it doesn't feel like it snaps still the instant the mouse button lifts.
      const speed = Math.hypot(this.velLookYaw, this.velLookPitch);
      if (speed > MIN_LOOK_SETTLE_VELOCITY) {
        this.lookYaw += this.velLookYaw * deltaSeconds;
        this.lookPitch = Math.min(MAX_LOOK_PITCH, Math.max(-MAX_LOOK_PITCH, this.lookPitch + this.velLookPitch * deltaSeconds));
        const decay = Math.exp(-LOOK_INERTIA_DECAY_PER_SEC * deltaSeconds);
        this.velLookYaw *= decay;
        this.velLookPitch *= decay;
      } else {
        this.velLookYaw = 0;
        this.velLookPitch = 0;
      }
    }

    this.applyHeading(tmpEast, tmpNorth);

    tmpMove.setAll(0);
    if (this.keys.has("ArrowUp") || this.keys.has(keybindings.get("groundForward"))) tmpMove.addInPlace(tmpNorth);
    if (this.keys.has("ArrowDown") || this.keys.has(keybindings.get("groundBackward"))) tmpMove.subtractInPlace(tmpNorth);
    if (this.keys.has("ArrowRight") || this.keys.has(keybindings.get("groundRight"))) tmpMove.addInPlace(tmpEast);
    if (this.keys.has("ArrowLeft") || this.keys.has(keybindings.get("groundLeft"))) tmpMove.subtractInPlace(tmpEast);

    if (tmpMove.lengthSquared() > 0) {
      tmpMove.normalize();
      const distance = PAN_SPEED * deltaSeconds;
      Vector3.CrossToRef(this.anchor, tmpMove, tmpPanAxis);
      tmpPanAxis.normalize();
      const angle = distance / planetRadius;
      Quaternion.RotationAxisToRef(tmpPanAxis, angle, tmpQuat);
      Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
      Vector3.TransformCoordinatesToRef(this.anchor, tmpMatrix, this.anchor);
      this.anchor.normalize();
      this.transportBasis(tmpMatrix);
      this.applyHeading(tmpEast, tmpNorth);
    }

    if (this.pendingPanEast !== 0 || this.pendingPanNorth !== 0) {
      tmpMove.copyFrom(tmpEast).scaleInPlace(this.pendingPanEast).addInPlace(tmpNorth.scale(this.pendingPanNorth));
      const dragDistance = tmpMove.length();
      if (dragDistance > 1e-6) {
        tmpMove.normalize();
        Vector3.CrossToRef(this.anchor, tmpMove, tmpPanAxis);
        tmpPanAxis.normalize();
        const angle = dragDistance / planetRadius;
        Quaternion.RotationAxisToRef(tmpPanAxis, angle, tmpQuat);
        Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
        Vector3.TransformCoordinatesToRef(this.anchor, tmpMatrix, this.anchor);
        this.anchor.normalize();
        this.transportBasis(tmpMatrix);
        this.applyHeading(tmpEast, tmpNorth);
      }
      this.pendingPanEast = 0;
      this.pendingPanNorth = 0;
    }

    const elevation = this.heightfield.elevationAt(this.anchor);
    const groundPos = this.anchor.scale(planetRadius + elevation);
    const distanceBack = this.eyeHeight * 0.9;
    const pullback = this.eyeHeight * Math.cos((PITCH_DEG * Math.PI) / 180) + distanceBack;

    // Sample elevation at roughly where the camera actually hovers (anchor rotated "south" by
    // the pullback distance), not just under the anchor - nearby terrain can be steeper than
    // right under the look-at point, and using only the anchor's elevation let the camera dip
    // into slopes it was flying past rather than looking down at. Same rotate-by-angle pattern
    // as panning above, moving in the -north (south) direction to match the pullback offset.
    tmpHoverDir.copyFrom(tmpNorth).scaleInPlace(-1);
    Vector3.CrossToRef(this.anchor, tmpHoverDir, tmpPanAxis);
    tmpPanAxis.normalize();
    const hoverAngle = pullback / planetRadius;
    Quaternion.RotationAxisToRef(tmpPanAxis, hoverAngle, tmpQuat);
    Matrix.FromQuaternionToRef(tmpQuat, tmpMatrix);
    Vector3.TransformCoordinatesToRef(this.anchor, tmpMatrix, tmpHoverPoint);
    tmpHoverPoint.normalize();
    const hoverElevation = this.heightfield.elevationAt(tmpHoverPoint);

    const heightUp = Math.max(this.eyeHeight * Math.sin((PITCH_DEG * Math.PI) / 180), hoverElevation - elevation + MIN_CLEARANCE);

    tmpTargetPos.copyFrom(groundPos).addInPlace(this.anchor.scale(heightUp)).subtractInPlace(tmpNorth.scale(pullback));

    // Orientation via rotationQuaternion (not setTarget) using `anchor` as the up hint:
    // setTarget's default upVector is world-Y, which is wrong everywhere except near the north
    // pole - in the southern hemisphere it renders the view upside down (terrain appears "in
    // the sky"). `anchor` is always the correct local up at the ground point, in any
    // hemisphere. See lookRotation.ts for why this goes through computeLookRotationToRef
    // rather than Babylon's own FromLookDirectionLHToRef (which mishandles exactly this case -
    // anchor sits ~90+PITCH_DEG degrees from the look direction by design, since a camera
    // pitched steeply downward looks closer to straight down than to level).
    tmpLookDir.copyFrom(groundPos).subtractInPlace(tmpTargetPos).normalize();
    computeLookRotationToRef(tmpLookDir, this.anchor, tmpTargetRot);

    // Free-look layers on top as a local-space rotation (right-drag) - it never changes
    // tmpTargetPos/tmpLookDir above, so WASD/arrow panning always stays relative to the fixed
    // framing regardless of which way the player is currently looking, like a turret swivel.
    if (this.lookYaw !== 0 || this.lookPitch !== 0) {
      Quaternion.RotationYawPitchRollToRef(this.lookYaw, this.lookPitch, 0, tmpLookOffsetQuat);
      tmpTargetRot.multiplyToRef(tmpLookOffsetQuat, tmpTargetRot);
    }

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
