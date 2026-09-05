import { AbstractEngine, Matrix, type Node, type PickingInfo, Scene, Vector3 } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import type { CelestialBody } from "../solarSystem/celestialBody";
import type { FreeFlyCamera } from "../camera/freeFlyCamera";
import type { EconomyManager } from "../economy/economyManager";

const AU_IN_KM = 149_597_870.7;
/** Real (not compressed) Earth radius, km - used to convert a moon's
 * moonOrbitRadiusInParentRadiiActual (parent radii) into real km. */
const EARTH_RADIUS_KM = 6371;

function formatKm(km: number): string {
  return km >= 1_000_000 ? `${(km / 1_000_000).toFixed(2)}M km` : `${Math.round(km).toLocaleString()} km`;
}

/** "How far away it is" for the selection/focus labels - real distance from the Sun (in AU,
 * plus km too when under 1 AU where an AU figure alone is an awkward fraction) for a
 * star-orbiting body, or real distance from its parent body (km) for a moon - always the TRUE
 * real-world figure (BodyDef.auDistance / moonOrbitRadiusInParentRadiiActual), independent of
 * the current Actual/Gameplay orbital-scale blend (see orbitalScale.ts) or which camera is
 * looking at it, since "how far is Mars from the Sun" is a fixed astronomical fact, not a
 * live camera-to-target reading. */
function formatBodyDistance(body: CelestialBody, allBodies: readonly CelestialBody[]): string | null {
  if (body.def.orbitsAround) {
    const parent = allBodies.find((b) => b.def.name === body.def.orbitsAround);
    if (!parent || !body.def.moonOrbitRadiusInParentRadiiActual) return null;
    const parentRadiusKm = parent.def.realDiameterRatio * EARTH_RADIUS_KM;
    return `${formatKm(body.def.moonOrbitRadiusInParentRadiiActual * parentRadiusKm)} from ${parent.def.name}`;
  }
  if (!body.def.auDistance) return null; // 0 for non-star-orbiting defs (shouldn't reach here, but defensive)
  const au = body.def.auDistance;
  const auText = `${au.toFixed(2)} AU`;
  return au < 1 ? `${auText} (${formatKm(au * AU_IN_KM)}) from the Sun` : `${auText} from the Sun`;
}

const FREE_CAM_PICK_DISTANCE = 1_000_000; // comfortably past the outermost body's orbit

const CLICK_MOVE_THRESHOLD_PX = 6;
const MIN_RETICLE_SIZE = 24;

const tmpInvMatrix = new Matrix();
const tmpLocalPoint = new Vector3();
const tmpEntityPos = new Vector3();

/** A selected ship or asteroid - deliberately decoupled from Ship/AsteroidBelt's own shapes
 * (just "a name" and "a way to get its current world position each frame"), same spirit as the
 * economy layer's own Dockable interface, so this class doesn't need to know their internals. */
export type SelectedEntity = {
  kind: "ship" | "asteroid";
  name: string;
  getWorldPosition: () => Vector3;
};

function digitFromCode(code: string): number | null {
  const match = /^Digit(\d)$/.exec(code);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Target selection: a numbered "Focus" menu (press 1 to open, then a body's number to target
 * it - `1 -> 4` targets whatever is 4th in the list), click-to-select on a body's mesh, and a
 * screen-space corner-bracket reticle tracking the current target every frame. Selecting a
 * target does not travel there - that's Tab (a later phase); this only tracks intent.
 */
export class SelectionUI {
  targetIndex: number | null = null;
  /** The specific surface point (if any) a click/reticle-pick landed on, in the hit body's own
   * local (spinNode-relative) unit direction - so it stays valid as the body spins/orbits, same
   * pattern as Base's surfaceDir/SelectionAreaUI's anchorLocal. Populated alongside targetIndex
   * whenever a pick actually hits body geometry (not just its bounding region); consumed by
   * main.ts's "Alt+Space: jump straight to RTS view at this exact spot" flow. */
  selectedSurfacePoint: { bodyIndex: number; localDir: Vector3 } | null = null;
  /** A selected ship/asteroid - mutually exclusive with targetIndex (selecting one clears the
   * other, so exactly one thing is ever selected at a time). */
  selectedEntity: SelectedEntity | null = null;

  private readonly solarSystem: SolarSystem;
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly freeFlyCamera: FreeFlyCamera;
  private readonly isFreeCamActive: () => boolean;
  private readonly focusListEl: HTMLElement;
  private readonly focusListItemsEl: HTMLOListElement;
  private readonly reticleEl: HTMLElement;
  private readonly reticleLabelEl: HTMLElement;
  private readonly orbitFocusLabelEl: HTMLElement;
  private readonly hoverLabelEl: HTMLElement;
  private readonly getFocusLabel: () => string | null;
  /** Null while orbiting a ship/asteroid (orbitEntity mode) rather than a planet/moon - distance-
   * from-the-Sun/parent (see formatBodyDistance) only makes sense for the latter. */
  private readonly getFocusedBody: () => CelestialBody | null;
  private readonly isCursorModeActive: () => boolean;
  private readonly getEconomyManager: () => EconomyManager;
  private readonly isInputLocked: () => boolean;
  private readonly canvas: HTMLCanvasElement;
  private listOpen = false;
  private pointerDownX = 0;
  private pointerDownY = 0;
  /** Tracked ourselves via a real pointermove listener, rather than trusting Babylon's own
   * scene.pointerX/pointerY - see the constructor's own comment on why. */
  private lastClientX = 0;
  private lastClientY = 0;
  private hasPointerPosition = false;

  constructor(
    solarSystem: SolarSystem,
    scene: Scene,
    engine: AbstractEngine,
    canvas: HTMLCanvasElement,
    freeFlyCamera: FreeFlyCamera,
    isFreeCamActive: () => boolean,
    getFocusLabel: () => string | null,
    getFocusedBody: () => CelestialBody | null,
    isCursorModeActive: () => boolean,
    getEconomyManager: () => EconomyManager,
    isInputLocked: () => boolean,
  ) {
    this.solarSystem = solarSystem;
    this.scene = scene;
    this.engine = engine;
    this.freeFlyCamera = freeFlyCamera;
    this.isFreeCamActive = isFreeCamActive;
    this.getFocusLabel = getFocusLabel;
    this.getFocusedBody = getFocusedBody;
    this.isCursorModeActive = isCursorModeActive;
    this.getEconomyManager = getEconomyManager;
    this.isInputLocked = isInputLocked;
    this.canvas = canvas;
    this.focusListEl = document.getElementById("focusList")!;
    this.focusListItemsEl = document.getElementById("focusListItems") as HTMLOListElement;
    this.reticleEl = document.getElementById("reticle")!;
    this.reticleLabelEl = document.getElementById("reticleLabel")!;
    this.orbitFocusLabelEl = document.getElementById("orbitFocusLabel")!;
    this.hoverLabelEl = document.getElementById("hoverLabel")!;

    this.populateList();
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    // scene.pointerX/pointerY is only as fresh as Babylon's own last-observed pointermove, which
    // can be stale (or never yet set) - e.g. a click that lands before the mouse has moved at
    // all since page load picked at the wrong position entirely ("selection doesn't even work
    // anymore ... or it does work but I have to move first?"). Tracking real clientX/Y ourselves
    // and converting to canvas-local coordinates on demand (clientToCanvasXY) is reliable from
    // the very first event, and also fixes the hover label flickering on/off every frame at a
    // stationary cursor (same staleness, sampled inconsistently frame to frame).
    window.addEventListener("pointermove", (e) => {
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
      this.hasPointerPosition = true;
    });
  }

  private clientToCanvasXY(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private populateList(): void {
    this.focusListItemsEl.innerHTML = "";
    for (const body of this.solarSystem.bodies) {
      const li = document.createElement("li");
      li.textContent = body.def.name;
      this.focusListItemsEl.appendChild(li);
    }
  }

  private openList(): void {
    this.listOpen = true;
    this.focusListEl.hidden = false;
    for (let i = 0; i < this.focusListItemsEl.children.length; i++) {
      this.focusListItemsEl.children[i].classList.toggle("is-focused", i === this.solarSystem.focusedIndex);
    }
  }

  private closeList(): void {
    this.listOpen = false;
    this.focusListEl.hidden = true;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.isInputLocked()) return; // an automated camera flight is in progress - see main.ts's transiting
    if (!this.listOpen) {
      if (e.code === "Digit1" && !e.repeat) this.openList();
      return;
    }
    if (e.code === "Escape") {
      this.closeList();
      return;
    }
    const digit = digitFromCode(e.code);
    if (digit !== null && digit >= 1 && digit <= this.solarSystem.bodies.length) {
      this.setTarget(digit - 1);
      this.closeList();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.isInputLocked()) return; // see onKeyDown's own comment
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.isInputLocked()) return; // see onKeyDown's own comment
    if (e.button !== 0) return; // right-click drives ground-camera free-look, not selection

    if (this.isFreeCamActive() && !this.isCursorModeActive()) {
      // Pointer Lock hides the cursor and freezes clientX/clientY at wherever the lock engaged,
      // so a screen-coordinate pick is meaningless here - raycast via the reticle instead. Once
      // cursor mode frees a real, moving cursor, though, a normal screen-coordinate pick below
      // works exactly like it does in orbit mode - the cursor might not be at screen-center.
      this.selectWithReticle();
      return;
    }

    const dx = e.clientX - this.pointerDownX;
    const dy = e.clientY - this.pointerDownY;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD_PX) return; // was a drag, not a click

    const { x, y } = this.clientToCanvasXY(e.clientX, e.clientY);
    const pick = this.scene.pick(x, y);
    this.applyPickResult(pick);
  }

  /** Raycasts straight down the free-cam crosshair (camera forward) and selects whatever body
   * it hits - same idea as an FPS reticle. Used both by left-click and the selectTarget
   * keybinding (Space by default) while free cam is active. */
  selectWithReticle(): void {
    const ray = this.freeFlyCamera.camera.getForwardRay(FREE_CAM_PICK_DISTANCE);
    const pick = this.scene.pickWithRay(ray);
    this.applyPickResult(pick);
  }

  /** Picks whatever's currently under the crosshair/cursor - same picking rule as a single
   * click (reticle raycast while mouselook is engaged, since Pointer Lock freezes clientX/Y;
   * a normal screen-position pick otherwise) - and returns its body index if it's a planet/moon,
   * or null for a miss, a ship/asteroid, or anything else. Doesn't mutate selection state itself;
   * used by main.ts's double-click-to-zoom flow to confirm the second click actually landed on
   * a body before committing to fly there. */
  pickBodyIndexUnderCursor(): number | null {
    let pick: PickingInfo | null;
    if (this.isFreeCamActive() && !this.isCursorModeActive()) {
      pick = this.scene.pickWithRay(this.freeFlyCamera.camera.getForwardRay(FREE_CAM_PICK_DISTANCE));
    } else if (this.hasPointerPosition) {
      const { x, y } = this.clientToCanvasXY(this.lastClientX, this.lastClientY);
      pick = this.scene.pick(x, y);
    } else {
      return null;
    }
    if (!pick?.hit || !pick.pickedMesh) return null;
    return this.findBodyIndexForMesh(pick.pickedMesh.parent);
  }

  /** Shared by both pick paths above. Checks asteroid/ship first (neither is a CelestialBody,
   * so findBodyIndexForMesh would never find them), then falls back to the original body pick:
   * sets targetIndex, and, whenever the pick actually hit body geometry (not just empty space or
   * the region outside the mesh), also records the specific surface point as a body-local unit
   * direction (converted via the body's spinNode inverse world matrix) so it stays valid as the
   * body spins/orbits after the fact. */
  private applyPickResult(pick: PickingInfo | null): void {
    if (!pick?.hit || !pick.pickedMesh) return;

    if (pick.pickedMesh === this.solarSystem.belt.rockMesh && pick.thinInstanceIndex !== undefined && pick.thinInstanceIndex >= 0) {
      const rockIndex = pick.thinInstanceIndex;
      this.setSelectedEntity({
        kind: "asteroid",
        name: `Asteroid #${rockIndex}`,
        getWorldPosition: () => {
          this.solarSystem.belt.getRockWorldPosition(rockIndex, tmpEntityPos);
          return tmpEntityPos;
        },
      });
      return;
    }

    const ship = this.getEconomyManager().findShipForMesh(pick.pickedMesh);
    if (ship) {
      this.setSelectedEntity({ kind: "ship", name: ship.def.name, getWorldPosition: () => ship.root.position });
      return;
    }

    const index = this.findBodyIndexForMesh(pick.pickedMesh.parent);
    if (index === null) return;
    this.setTarget(index);
    if (pick.pickedPoint) {
      const body = this.solarSystem.bodies[index];
      body.orbit.spinNode.getWorldMatrix().invertToRef(tmpInvMatrix);
      Vector3.TransformCoordinatesToRef(pick.pickedPoint, tmpInvMatrix, tmpLocalPoint);
      this.selectedSurfacePoint = { bodyIndex: index, localDir: tmpLocalPoint.normalize().clone() };
    }
  }

  /** Resolves a human-readable name for whatever a pick hit (asteroid/ship/body), or null for a
   * miss or an unrecognized mesh - the read-only counterpart to applyPickResult's own resolution
   * (which also mutates selection state and records a surface point), used by the hover label. */
  private resolveNameForPick(pick: PickingInfo | null): string | null {
    if (!pick?.hit || !pick.pickedMesh) return null;
    if (pick.pickedMesh === this.solarSystem.belt.rockMesh && pick.thinInstanceIndex !== undefined && pick.thinInstanceIndex >= 0) {
      return `Asteroid #${pick.thinInstanceIndex}`;
    }
    const ship = this.getEconomyManager().findShipForMesh(pick.pickedMesh);
    if (ship) return ship.def.name;
    const index = this.findBodyIndexForMesh(pick.pickedMesh.parent);
    return index !== null ? this.solarSystem.bodies[index].def.name : null;
  }

  /** Call once per frame to show whatever's currently under the mouse cursor's name in a small
   * tooltip that follows it. Only meaningful with a real, visible cursor - Pointer Lock
   * mouselook freezes clientX/Y and there's no cursor to "hover" with in that state (the
   * crosshair reticle already names its locked target via the reticle label instead), and while
   * an automated camera flight has all input locked there's nothing meaningful to hover either. */
  updateHoverLabel(): void {
    if ((this.isFreeCamActive() && !this.isCursorModeActive()) || this.isInputLocked() || !this.hasPointerPosition) {
      this.hoverLabelEl.hidden = true;
      return;
    }
    const { x, y } = this.clientToCanvasXY(this.lastClientX, this.lastClientY);
    const name = this.resolveNameForPick(this.scene.pick(x, y));
    if (name === null) {
      this.hoverLabelEl.hidden = true;
      return;
    }
    this.hoverLabelEl.hidden = false;
    this.hoverLabelEl.textContent = name;
    this.hoverLabelEl.style.left = `${this.lastClientX}px`;
    this.hoverLabelEl.style.top = `${this.lastClientY}px`;
  }

  private findBodyIndexForMesh(node: Node | null): number | null {
    let current = node;
    while (current) {
      const index = this.solarSystem.bodies.findIndex((b) => b.orbit.spinNode === current);
      if (index !== -1) return index;
      current = current.parent;
    }
    return null;
  }

  setTarget(index: number): void {
    this.targetIndex = index;
    // Cleared unconditionally here, then re-populated immediately after by applyPickResult when
    // this selection actually came from a pick - otherwise a stale spot from a previous body
    // (e.g. picked before switching targets via the digit-key focus list, which never calls
    // applyPickResult at all) would linger and get used by main.ts's Alt+Space jump-to-spot flow
    // as if it still applied to whatever's newly selected now.
    this.selectedSurfacePoint = null;
    this.selectedEntity = null;
  }

  /** Selects a ship/asteroid, clearing any body selection - see selectedEntity's own comment on
   * why exactly one thing is ever selected at a time. */
  setSelectedEntity(entity: SelectedEntity): void {
    this.selectedEntity = entity;
    this.targetIndex = null;
    this.selectedSurfacePoint = null;
  }

  /** Clears the selection entirely - used when backing out of orbit mode via ESC ("deselect and
   * return to free cam"). */
  clearSelection(): void {
    this.targetIndex = null;
    this.selectedSurfacePoint = null;
    this.selectedEntity = null;
  }

  /** Call once per frame to keep the reticle tracking the current target. */
  update(): void {
    const focusLabel = this.getFocusLabel();
    if (focusLabel !== null) {
      // The corner-bracket reticle is for picking a travel target from afar (free cam) - once
      // you're actually in orbit around something, it's redundant/distracting. Swap it for a
      // plain always-on top-center label naming whatever you're currently orbiting instead.
      this.reticleEl.hidden = true;
      this.orbitFocusLabelEl.hidden = false;
      const focusedBody = this.getFocusedBody();
      const distance = focusedBody && formatBodyDistance(focusedBody, this.solarSystem.bodies);
      this.orbitFocusLabelEl.textContent = distance ? `${focusLabel} · ${distance}` : focusLabel;
      return;
    }
    this.orbitFocusLabelEl.hidden = true;

    if (this.targetIndex === null) {
      this.reticleEl.hidden = true;
      return;
    }
    const body = this.solarSystem.bodies[this.targetIndex];
    const center = body.orbit.spinNode.getAbsolutePosition();
    const camera = this.scene.activeCamera;
    if (!camera) return;

    // Project()'s clip-space z isn't a reliable "is this behind the camera" signal on its own -
    // a point behind the eye can still land inside [0,1] after the perspective divide (observed
    // live: rotating 180 degrees away from a selected body left its reticle rendered wherever it
    // happened to project to, not hidden). A dot product against the camera's actual forward
    // direction is the robust check - only ever positive for something genuinely in front.
    const toTarget = center.subtract(camera.globalPosition);
    if (Vector3.Dot(toTarget, camera.getDirection(Vector3.Forward())) <= 0) {
      this.reticleEl.hidden = true;
      return;
    }

    const viewport = camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();
    const screenCenter = Vector3.Project(center, Matrix.Identity(), transform, viewport);

    // Camera-right (not world-up) for the edge offset: world-up degenerates to nearly zero
    // apparent size when looking straight up/down at the target (it's then almost parallel to
    // the view direction), where right never can be - and measuring the full 2D screen-space
    // distance (not just the Y difference) keeps this correct under any camera roll too.
    const edgePoint = center.add(camera.getDirection(Vector3.Right()).scale(body.radius));
    const screenEdge = Vector3.Project(edgePoint, Matrix.Identity(), transform, viewport);
    const apparentRadius = Math.hypot(screenEdge.x - screenCenter.x, screenEdge.y - screenCenter.y);
    // Corners sit just outside the planet's silhouette, not overlapping it: box half-size is
    // ~1.2x the apparent radius - a snug frame, not floating far outside it ("selection boxes
    // are too big" at the old 1.7x). No upper clamp - "the corners should frame the planet
    // perfectly regardless of distance"; only a small floor so it doesn't collapse to a literal
    // 0px box once genuinely too far to matter.
    const size = Math.max(MIN_RETICLE_SIZE, apparentRadius * 2.4);

    this.reticleEl.hidden = false;
    this.reticleEl.style.transform = `translate(${screenCenter.x - size / 2}px, ${screenCenter.y - size / 2}px)`;
    this.reticleEl.style.width = `${size}px`;
    this.reticleEl.style.height = `${size}px`;
    const targetDistance = formatBodyDistance(body, this.solarSystem.bodies);
    this.reticleLabelEl.textContent = targetDistance ? `${body.def.name} · ${targetDistance}` : body.def.name;
  }
}
