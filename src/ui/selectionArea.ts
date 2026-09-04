import { Color3, type LinesMesh, Matrix, Mesh, MeshBuilder, type Node, Scene, StandardMaterial, Vector3, VertexData } from "@babylonjs/core";
import type { CelestialBody } from "../solarSystem/celestialBody";
import type { SolarSystem } from "../solarSystem/solarSystem";
import type { OrbitTrackballCamera } from "../camera/orbitTrackballCamera";
import { graphicsSettings } from "../settings/graphicsSettings";

const CIRCLE_SEGMENTS = 64;
const DRAG_START_THRESHOLD_PX = 6;
/** Radians of angular radius per pixel of net up/right (or, inverted, down/left) drag movement. */
const RESIZE_SENSITIVITY = 0.0035;
/** Just short of a full hemisphere-plus - avoids the degenerate wraparound at the antipode. */
const MAX_ANGULAR_RADIUS = Math.PI * 0.98;
/** Drawn slightly above the base radius so the area doesn't z-fight with terrain right at sea
 * level - real elevation bumps can still poke through a tall peak, but that's an acceptable
 * approximation for a UI overlay, not a terrain-conforming decal. */
const HEIGHT_FACTOR = 1.004;

/**
 * Click-and-drag directly on a landable body (orbit view only) to draw a filled circular area
 * on its surface - the eventual "selection area for units" a base's buildings/units would be
 * confined to (no such units exist yet - this is just the visual/interaction affordance).
 * Dragging up or right grows it, down or left shrinks it (see
 * graphicsSettings.invertSelectionAreaResize to flip that) - direction-driven rather than
 * tracking where the pointer lands, so it keeps responding smoothly even once the drag strays
 * off the body entirely. Traced as a true geodesic circle on the sphere (a filled spherical
 * cap, not a flat approximation), parented to the body so it spins/orbits along with it. One
 * area at a time; a fresh drag replaces the previous one, even on a different body. A plain
 * click (no drag past the threshold) does nothing here, so it doesn't fight SelectionUI's own
 * click-to-select-travel-target on the same mesh.
 */
export class SelectionAreaUI {
  private readonly scene: Scene;
  private readonly solarSystem: SolarSystem;
  private readonly orbitCamera: OrbitTrackballCamera;
  private readonly isOrbitMode: () => boolean;
  private readonly material: StandardMaterial;

  private dragging = false;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private lastX = 0;
  private lastY = 0;
  private bodyIndex: number | null = null;
  private readonly anchorLocal = new Vector3();
  private angularRadius = 0;
  private fillMesh: Mesh | null = null;
  private outlineMesh: LinesMesh | null = null;

  constructor(
    scene: Scene,
    solarSystem: SolarSystem,
    orbitCamera: OrbitTrackballCamera,
    canvas: HTMLCanvasElement,
    isOrbitMode: () => boolean,
  ) {
    this.scene = scene;
    this.solarSystem = solarSystem;
    this.orbitCamera = orbitCamera;
    this.isOrbitMode = isOrbitMode;

    this.material = new StandardMaterial("selectionAreaMaterial", scene);
    this.material.emissiveColor = new Color3(0.3, 0.9, 1);
    this.material.diffuseColor = Color3.Black();
    this.material.specularColor = Color3.Black();
    this.material.disableLighting = true;
    this.material.backFaceCulling = false;
    this.material.alpha = 0.3;

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", () => this.onPointerUp());
  }

  private onPointerDown(e: PointerEvent): void {
    this.bodyIndex = null;
    this.dragging = false;
    if (e.button !== 0 || !this.isOrbitMode()) return;
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
    if (!pick?.hit || !pick.pickedMesh || !pick.pickedPoint) return;
    const index = this.findLandableBodyIndexForMesh(pick.pickedMesh.parent);
    if (index === null) return;

    const body = this.solarSystem.bodies[index];
    const invWorld = Matrix.Invert(body.orbit.spinNode.getWorldMatrix());
    const local = Vector3.TransformCoordinates(pick.pickedPoint, invWorld);
    if (local.lengthSquared() < 1e-6) return;
    this.anchorLocal.copyFrom(local).normalize();
    this.bodyIndex = index;
    this.angularRadius = 0;
    // This gesture is a click-drag on a landable body's surface, not a drag on empty space -
    // OrbitTrackballCamera shares this same pointerdown event and has already (unconditionally)
    // started its own drag-to-rotate; cancel that retroactively so the view doesn't rotate
    // out from under the area while it's being drawn.
    this.orbitCamera.cancelDrag();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.bodyIndex === null) return;
    if (!this.dragging) {
      const dx0 = e.clientX - this.pointerDownX;
      const dy0 = e.clientY - this.pointerDownY;
      if (Math.hypot(dx0, dy0) < DRAG_START_THRESHOLD_PX) return;
      this.dragging = true;
    }

    const stepDx = e.clientX - this.lastX;
    const stepDy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    // Up or right grows, down or left shrinks (screen Y increases downward, so "up" is
    // negative dy) - direction of movement, not distance from the anchor, so this keeps
    // working smoothly even once the drag strays off the body's visible disc entirely.
    const sign = graphicsSettings.invertSelectionAreaResize ? -1 : 1;
    const growth = (stepDx - stepDy) * RESIZE_SENSITIVITY * sign;
    this.angularRadius = Math.max(0, Math.min(MAX_ANGULAR_RADIUS, this.angularRadius + growth));

    const body = this.solarSystem.bodies[this.bodyIndex];
    this.rebuildArea(body);
  }

  private onPointerUp(): void {
    this.dragging = false;
    this.bodyIndex = null;
  }

  private findLandableBodyIndexForMesh(node: Node | null): number | null {
    let current = node;
    while (current) {
      const index = this.solarSystem.bodies.findIndex((b) => b.orbit.spinNode === current);
      if (index !== -1) return this.solarSystem.bodies[index].landable ? index : null;
      current = current.parent;
    }
    return null;
  }

  private rebuildArea(body: CelestialBody): void {
    this.fillMesh?.dispose();
    this.fillMesh = null;
    this.outlineMesh?.dispose();
    this.outlineMesh = null;
    if (this.angularRadius < 0.001) return;

    let arbitrary = Vector3.Up();
    if (Math.abs(Vector3.Dot(arbitrary, this.anchorLocal)) > 0.95) arbitrary = Vector3.Right();
    const tangent1 = Vector3.Cross(this.anchorLocal, arbitrary).normalize();
    const tangent2 = Vector3.Cross(this.anchorLocal, tangent1).normalize();

    const cosR = Math.cos(this.angularRadius);
    const sinR = Math.sin(this.angularRadius);
    const height = body.radius * HEIGHT_FACTOR;

    const edgeDirs: Vector3[] = [];
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      edgeDirs.push(
        this.anchorLocal
          .scale(cosR)
          .add(tangent1.scale(Math.cos(a) * sinR))
          .add(tangent2.scale(Math.sin(a) * sinR)),
      );
    }

    // Filled spherical cap: a triangle fan from the anchor out to the ring, so the covered
    // area actually reads as a translucent patch of ground rather than just an outline.
    const positions: number[] = [this.anchorLocal.x * height, this.anchorLocal.y * height, this.anchorLocal.z * height];
    const normals: number[] = [this.anchorLocal.x, this.anchorLocal.y, this.anchorLocal.z];
    for (const dir of edgeDirs) {
      positions.push(dir.x * height, dir.y * height, dir.z * height);
      normals.push(dir.x, dir.y, dir.z);
    }
    const indices: number[] = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      indices.push(0, i + 2, i + 1);
    }

    const fill = new Mesh("selectionAreaFill", this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.normals = normals;
    vertexData.indices = indices;
    vertexData.applyToMesh(fill);
    fill.material = this.material;
    fill.isPickable = false;
    fill.parent = body.orbit.spinNode;
    this.fillMesh = fill;

    const outline = MeshBuilder.CreateLines("selectionAreaOutline", { points: edgeDirs.map((d) => d.scale(height)) }, this.scene);
    outline.color = new Color3(0.5, 1, 1);
    outline.isPickable = false;
    outline.parent = body.orbit.spinNode;
    this.outlineMesh = outline;
  }
}
