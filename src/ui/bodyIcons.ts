import { Matrix, Vector3, type AbstractEngine, type Scene } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import { AU_IN_SCENE_UNITS } from "../solarSystem/scale";

const tmpIdentity = Matrix.Identity(); // world matrix for Project() - bodies' positions are already in world space

/**
 * Small clickable billboard icon + name label for every body currently on screen - "put labels
 * on all planets all the time". The dot marker itself only shows once a body is farther than 1
 * AU from the camera, though - "I still havent seen any billboard sprites to show you planets and
 * objects more than 1 AU away ... so I can see Venus, Mars, Earth all as icons when I'm way out
 * by Jupiter" - a real 3D body is already visually negligible at that range (its actual angular
 * size on screen is sub-pixel at typical body radii vs multi-AU viewing distances), so the dot
 * stands in for it; up close the real mesh is already right there, so only the label persists.
 *
 * Reuses the same screen-space DOM-overlay technique as the selection reticle/hover label
 * (project world position -> screen, position a plain HTML element there) rather than a Babylon
 * GUI layer, for consistency with the rest of this UI.
 */
export class BodyIconsUI {
  private readonly solarSystem: SolarSystem;
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly isInputLocked: () => boolean;
  private readonly icons: HTMLElement[] = [];

  constructor(solarSystem: SolarSystem, scene: Scene, engine: AbstractEngine, isInputLocked: () => boolean, onSelect: (bodyIndex: number) => void) {
    this.solarSystem = solarSystem;
    this.scene = scene;
    this.engine = engine;
    this.isInputLocked = isInputLocked;

    const layerEl = document.getElementById("bodyIconsLayer")!;
    for (let i = 0; i < solarSystem.bodies.length; i++) {
      const body = solarSystem.bodies[i];
      const el = document.createElement("button");
      el.type = "button";
      el.className = "body-icon";
      el.hidden = true;

      const dot = document.createElement("span");
      dot.className = "body-icon-dot";
      const label = document.createElement("span");
      label.className = "body-icon-label";
      label.textContent = body.def.name;
      el.appendChild(dot);
      el.appendChild(label);

      el.addEventListener("click", () => {
        if (this.isInputLocked()) return;
        onSelect(i);
      });

      layerEl.appendChild(el);
      this.icons.push(el);
    }
  }

  /** Call once per frame. */
  update(): void {
    const camera = this.scene.activeCamera;
    if (!camera) return;

    const camPos = camera.globalPosition;
    const forward = camera.getDirection(Vector3.Forward());
    const viewport = camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();

    for (let i = 0; i < this.solarSystem.bodies.length; i++) {
      const el = this.icons[i];
      const worldPos = this.solarSystem.bodies[i].orbit.spinNode.getAbsolutePosition();

      // Same robust "in front of the camera" check as the selection reticle - projected clip
      // space z alone isn't reliable for this (see SelectionUI's own comment).
      const toBody = worldPos.subtract(camPos);
      if (Vector3.Dot(toBody, forward) <= 0) {
        el.hidden = true;
        continue;
      }

      const screenPos = Vector3.Project(worldPos, tmpIdentity, transform, viewport);
      if (screenPos.x < 0 || screenPos.x > viewport.width || screenPos.y < 0 || screenPos.y > viewport.height) {
        el.hidden = true;
        continue;
      }

      el.hidden = false;
      // Only the dot stands in for the real body once it's too far away to see - up close the
      // actual mesh is already visible, so showing the dot too would just be a redundant marker
      // floating in front of it.
      const distance = Vector3.Distance(camPos, worldPos);
      el.classList.toggle("body-icon-close", distance <= AU_IN_SCENE_UNITS);
      el.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px) translate(-50%, -50%)`;
    }
  }
}
