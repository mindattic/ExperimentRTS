import { AbstractEngine, Matrix, type Node, type PickingInfo, Scene, Vector3 } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import type { FreeFlyCamera } from "../camera/freeFlyCamera";
import type { EconomyManager } from "../economy/economyManager";

const FREE_CAM_PICK_DISTANCE = 1_000_000; // comfortably past the outermost body's orbit

const CLICK_MOVE_THRESHOLD_PX = 6;
const MIN_RETICLE_SIZE = 24;
const MAX_RETICLE_SIZE = 180;

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
  private readonly getFocusLabel: () => string | null;
  private readonly isCursorModeActive: () => boolean;
  private readonly getEconomyManager: () => EconomyManager;
  private listOpen = false;
  private pointerDownX = 0;
  private pointerDownY = 0;

  constructor(
    solarSystem: SolarSystem,
    scene: Scene,
    engine: AbstractEngine,
    canvas: HTMLCanvasElement,
    freeFlyCamera: FreeFlyCamera,
    isFreeCamActive: () => boolean,
    getFocusLabel: () => string | null,
    isCursorModeActive: () => boolean,
    getEconomyManager: () => EconomyManager,
  ) {
    this.solarSystem = solarSystem;
    this.scene = scene;
    this.engine = engine;
    this.freeFlyCamera = freeFlyCamera;
    this.isFreeCamActive = isFreeCamActive;
    this.getFocusLabel = getFocusLabel;
    this.isCursorModeActive = isCursorModeActive;
    this.getEconomyManager = getEconomyManager;
    this.focusListEl = document.getElementById("focusList")!;
    this.focusListItemsEl = document.getElementById("focusListItems") as HTMLOListElement;
    this.reticleEl = document.getElementById("reticle")!;
    this.reticleLabelEl = document.getElementById("reticleLabel")!;
    this.orbitFocusLabelEl = document.getElementById("orbitFocusLabel")!;

    this.populateList();
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
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
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
  }

  private onPointerUp(e: PointerEvent): void {
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

    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
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
      this.orbitFocusLabelEl.textContent = focusLabel;
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

    const viewport = camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();
    const screenCenter = Vector3.Project(center, Matrix.Identity(), transform, viewport);
    // Small tolerance: at this scene's scale, Project()'s z routinely comes out a hair past 1
    // (e.g. 1.0000115) from float precision even for targets nowhere near the far plane - a
    // strict > 1 check was hiding the reticle for legitimately-visible, in-front targets.
    if (screenCenter.z < -0.01 || screenCenter.z > 1.01) {
      // Behind the camera.
      this.reticleEl.hidden = true;
      return;
    }

    const edgePoint = center.add(Vector3.Up().scale(body.radius));
    const screenEdge = Vector3.Project(edgePoint, Matrix.Identity(), transform, viewport);
    const apparentRadius = Math.abs(screenCenter.y - screenEdge.y);
    // Corners sit outside the planet's silhouette, not overlapping it: box half-size is
    // ~1.7x the apparent radius, giving clear margin between the bracket and the body itself.
    const size = Math.min(MAX_RETICLE_SIZE, Math.max(MIN_RETICLE_SIZE, apparentRadius * 3.4));

    this.reticleEl.hidden = false;
    this.reticleEl.style.transform = `translate(${screenCenter.x - size / 2}px, ${screenCenter.y - size / 2}px)`;
    this.reticleEl.style.width = `${size}px`;
    this.reticleEl.style.height = `${size}px`;
    this.reticleLabelEl.textContent = body.def.name;
  }
}
