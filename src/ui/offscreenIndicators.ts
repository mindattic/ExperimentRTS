import { Matrix, Vector3, type AbstractEngine, type Scene } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";

/** Kept off the very edge of the viewport so the arrow's own size doesn't get clipped. */
const EDGE_MARGIN_PX = 28;

const tmpIdentity = Matrix.Identity(); // world matrix for Project() - bodies' positions are already in world space
const tmpToBody = new Vector3();

/**
 * Space-fighter-game-style off-screen indicators: an arrow pinned to whichever screen edge is
 * closest to the direction of every planet/moon currently NOT in view (off to the side, or
 * behind the camera), rotated to point the way you'd need to turn to find it - "arrows on the
 * sides of the screen showing where to point to find the other planets and moons". Independent
 * of BodyIconsUI (which only ever shows bodies farther than 1 AU, in-frame, too small to see as
 * a real mesh) - this covers every body at every distance, exactly when it's NOT already visibly
 * on screen some other way.
 *
 * The on/off-screen check reuses the same Vector3.Project() + in-front-of-camera test the
 * selection reticle and BodyIconsUI already rely on. Positioning the arrow itself, though, works
 * in the camera's own local right/up basis instead of a real screen projection: the angle a
 * target sits at around the camera's forward axis (from local right/up components alone,
 * ignoring depth) is exactly the angle you'd need to turn toward it, whether it's off to the
 * side or directly behind you - a real perspective projection would flip to the wrong side of
 * the screen for anything behind the camera, which this sidesteps entirely.
 */
export class OffscreenIndicatorUI {
  private readonly solarSystem: SolarSystem;
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly arrows: HTMLElement[] = [];

  constructor(solarSystem: SolarSystem, scene: Scene, engine: AbstractEngine) {
    this.solarSystem = solarSystem;
    this.scene = scene;
    this.engine = engine;

    const layerEl = document.getElementById("offscreenIndicatorLayer")!;
    for (const body of solarSystem.bodies) {
      const el = document.createElement("div");
      el.className = "offscreen-indicator";
      el.hidden = true;
      const glyph = document.createElement("span");
      glyph.className = "offscreen-indicator-glyph";
      const label = document.createElement("span");
      label.className = "offscreen-indicator-label";
      label.textContent = body.def.name;
      el.appendChild(glyph);
      el.appendChild(label);
      layerEl.appendChild(el);
      this.arrows.push(el);
    }
  }

  /** Call once per frame. */
  update(): void {
    const camera = this.scene.activeCamera;
    if (!camera) return;

    const camPos = camera.globalPosition;
    const forward = camera.getDirection(Vector3.Forward());
    const right = camera.getDirection(Vector3.Right());
    const up = camera.getDirection(Vector3.Up());
    const viewport = camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();
    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    const halfWidth = width / 2 - EDGE_MARGIN_PX;
    const halfHeight = height / 2 - EDGE_MARGIN_PX;

    for (let i = 0; i < this.solarSystem.bodies.length; i++) {
      const el = this.arrows[i];
      const worldPos = this.solarSystem.bodies[i].orbit.spinNode.getAbsolutePosition();
      worldPos.subtractToRef(camPos, tmpToBody);

      const inFront = Vector3.Dot(tmpToBody, forward) > 0;
      if (inFront) {
        const screenPos = Vector3.Project(worldPos, tmpIdentity, transform, viewport);
        if (screenPos.x >= 0 && screenPos.x <= viewport.width && screenPos.y >= 0 && screenPos.y <= viewport.height) {
          // On screen and in front - the real mesh (or BodyIconsUI's own far-away marker)
          // already shows it, no indicator needed.
          el.hidden = true;
          continue;
        }
      }

      // Direction to turn toward, in screen terms (right/down) - the local right/up components
      // of tmpToBody alone (ignoring depth/forward entirely) give exactly this, whether the body
      // is off to the side or behind the camera - see the class doc comment for why. Down
      // because DOM Y increases downward while camera "up" is the opposite sense.
      let dx = Vector3.Dot(tmpToBody, right);
      let dy = -Vector3.Dot(tmpToBody, up);
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = -1; // dead-on behind with no lateral bias at all - default to "up"

      // Ray-from-center-to-rectangle-edge intersection: scale (dx, dy) so whichever axis hits
      // its half-extent first lands exactly on that edge.
      const scale = Math.min(Math.abs(dx) > 1e-6 ? halfWidth / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? halfHeight / Math.abs(dy) : Infinity);
      const edgeX = dx * scale;
      const edgeY = dy * scale;
      const angleDeg = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = up, clockwise - matches the glyph's default pointing-up orientation

      el.hidden = false;
      el.style.transform = `translate(${width / 2 + edgeX}px, ${height / 2 + edgeY}px) translate(-50%, -50%)`;
      (el.firstElementChild as HTMLElement).style.transform = `rotate(${angleDeg}deg)`;
    }
  }
}
