import { AbstractEngine, Matrix, Scene, Vector3 } from "@babylonjs/core";

export interface ExaminableInfo {
  worldPosition: Vector3;
  name: string;
  faction: string;
  kind: "Base" | "Station" | "Ship";
  crew: number;
  cargo: string;
  /** Ships only, while in transit. */
  speedUnitsPerSec?: number;
  /** Ships only, while in transit. */
  etaSeconds?: number;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

/**
 * Holding Alt reveals a floating info placard over every visible Base/Station/Ship at once -
 * a Diablo/Baldur's-Gate-style ground-item-label overlay, but for entities in 3D space. Modeled
 * directly on SelectionUI's Vector3.Project + behind-camera-tolerance pattern (screen.z < -0.01
 * || screen.z > 1.01, needed at this scene's huge scale - see that file's own comment),
 * generalized from one reticle to a POOLED set of placard <div>s (grown as needed, hidden not
 * destroyed when unused) so dozens can appear/disappear per frame without DOM thrashing.
 */
export class ExamineUI {
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly getEntities: () => ExaminableInfo[];
  private altHeld = false;
  private readonly containerEl: HTMLElement;
  private readonly pool: HTMLElement[] = [];

  constructor(scene: Scene, engine: AbstractEngine, getEntities: () => ExaminableInfo[]) {
    this.scene = scene;
    this.engine = engine;
    this.getEntities = getEntities;
    this.containerEl = document.getElementById("examineLayer")!;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Alt") this.altHeld = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt") this.altHeld = false;
    });
    // Alt-tabbing away while holding Alt shouldn't leave this stuck open with no way to release it.
    window.addEventListener("blur", () => {
      this.altHeld = false;
    });
  }

  update(): void {
    if (!this.altHeld) {
      for (const el of this.pool) el.hidden = true;
      return;
    }

    const camera = this.scene.activeCamera;
    if (!camera) return;
    const viewport = camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();

    let used = 0;
    for (const entity of this.getEntities()) {
      const screen = Vector3.Project(entity.worldPosition, Matrix.Identity(), transform, viewport);
      // Same float-precision tolerance as SelectionUI - at this scene's scale, Project()'s z
      // routinely comes out a hair past 1 even for legitimately visible, in-front targets.
      if (screen.z < -0.01 || screen.z > 1.01) continue;
      if (screen.x < -60 || screen.x > viewport.width + 60) continue;
      if (screen.y < -60 || screen.y > viewport.height + 60) continue;

      const el = this.acquire(used++);
      el.hidden = false;
      el.style.transform = `translate(${screen.x}px, ${screen.y}px)`;
      el.innerHTML = this.renderPlacard(entity);
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].hidden = true;
  }

  private acquire(index: number): HTMLElement {
    if (index >= this.pool.length) {
      const el = document.createElement("div");
      el.className = "examine-placard";
      this.containerEl.appendChild(el);
      this.pool.push(el);
    }
    return this.pool[index];
  }

  private renderPlacard(entity: ExaminableInfo): string {
    const stats = [entity.faction, `Crew ${entity.crew}`, entity.cargo];
    if (entity.speedUnitsPerSec !== undefined) stats.push(`Speed ${entity.speedUnitsPerSec.toFixed(0)}`);
    if (entity.etaSeconds !== undefined) stats.push(`ETA ${formatDuration(entity.etaSeconds)}`);
    return `<div class="examine-name">${entity.name}</div><div class="examine-stats">${stats.join(" · ")}</div>`;
  }
}
