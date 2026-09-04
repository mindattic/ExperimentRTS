import { AbstractEngine, Matrix, type Node, Scene, Vector3 } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";

const CLICK_MOVE_THRESHOLD_PX = 6;
const MIN_RETICLE_SIZE = 24;
const MAX_RETICLE_SIZE = 180;

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

  private readonly solarSystem: SolarSystem;
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly focusListEl: HTMLElement;
  private readonly focusListItemsEl: HTMLOListElement;
  private readonly reticleEl: HTMLElement;
  private readonly reticleLabelEl: HTMLElement;
  private listOpen = false;
  private pointerDownX = 0;
  private pointerDownY = 0;

  constructor(solarSystem: SolarSystem, scene: Scene, engine: AbstractEngine, canvas: HTMLCanvasElement) {
    this.solarSystem = solarSystem;
    this.scene = scene;
    this.engine = engine;
    this.focusListEl = document.getElementById("focusList")!;
    this.focusListItemsEl = document.getElementById("focusListItems") as HTMLOListElement;
    this.reticleEl = document.getElementById("reticle")!;
    this.reticleLabelEl = document.getElementById("reticleLabel")!;

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
    const dx = e.clientX - this.pointerDownX;
    const dy = e.clientY - this.pointerDownY;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD_PX) return; // was a drag, not a click

    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
    if (!pick?.hit || !pick.pickedMesh) return;
    const index = this.findBodyIndexForMesh(pick.pickedMesh.parent);
    if (index !== null) this.setTarget(index);
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
  }

  /** Call once per frame to keep the reticle tracking the current target. */
  update(): void {
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
    const size = Math.min(MAX_RETICLE_SIZE, Math.max(MIN_RETICLE_SIZE, apparentRadius * 2.4));

    this.reticleEl.hidden = false;
    this.reticleEl.style.transform = `translate(${screenCenter.x - size / 2}px, ${screenCenter.y - size / 2}px)`;
    this.reticleEl.style.width = `${size}px`;
    this.reticleEl.style.height = `${size}px`;
    this.reticleLabelEl.textContent = body.def.name;
  }
}
