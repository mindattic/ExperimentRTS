import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "../solarSystem/celestialBody";
import type { Dockable } from "./dockable";
import type { BaseDef } from "./economyDefs";
import { FACTION_PALETTES } from "./factions";
import { createHullMaterial, hashSeed, HULL_FACE_UV } from "./hullTexture";
import { mulberry32 } from "../terrain/prng";
import type { ExaminableInfo } from "../ui/examineUI";

/**
 * A fixed textured-cuboid placeholder sitting on a landable body's surface - not an orbit at
 * all (unlike Station), so it's parented directly to the body's `spinNode` at a fixed local
 * offset, the same "anchor a fixed point on the rotating surface" pattern SelectionAreaUI
 * already uses for its drag-circle anchor.
 */
export class Base implements Dockable {
  readonly id: string;
  readonly def: BaseDef;
  readonly parentBody: CelestialBody;
  readonly mesh: Mesh;
  /** Fixed unit direction in the parent's non-rotating ORBIT frame (not the spinning surface
   * frame the mesh itself is parented to) - used only for ship arrival targeting later
   * (EconomyManager/Ship), so ships arrive at a stable "high orbit near the Base" point instead
   * of needing to predict the body's future spin phase too. Deliberately a different direction
   * from the mesh's own surface placement. */
  readonly approachDirectionInOrbitFrame: Vector3;

  constructor(scene: Scene, def: BaseDef, parentBody: CelestialBody) {
    this.id = def.bodyName;
    this.def = def;
    this.parentBody = parentBody;

    const rand = mulberry32(hashSeed(def.bodyName));
    const surfaceDir = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    this.approachDirectionInOrbitFrame = new Vector3(rand() - 0.5, 1, rand() - 0.5).normalize();

    const size = Math.max(8, parentBody.radius * 0.03);
    this.mesh = MeshBuilder.CreateBox(`${def.bodyName}BaseMesh`, { size, faceUV: HULL_FACE_UV }, scene);
    this.mesh.material = createHullMaterial(scene, def.faction, hashSeed(def.bodyName));
    this.mesh.parent = parentBody.orbit.spinNode;
    // Sits just above the base radius - same "avoid z-fighting with terrain" idea as
    // SelectionAreaUI's HEIGHT_FACTOR, though a real elevation bump could still poke through.
    this.mesh.position.copyFrom(surfaceDir.scale(parentBody.radius * 1.01));
  }

  /** Ships arrive at a stable "high orbit near the Base" point (the planet's future position
   * plus the fixed, non-rotating approach offset) rather than the Base's literal instantaneous
   * spin-rotated surface position - see approachDirectionInOrbitFrame's own doc comment. */
  predictWorldPositionAt(secondsFromNow: number, out: Vector3): Vector3 {
    this.parentBody.orbit.predictLocalPositionAt(secondsFromNow, out);
    out.addInPlace(this.approachDirectionInOrbitFrame.scale(this.parentBody.radius * 1.5));
    return out;
  }

  toExamineInfo(): ExaminableInfo {
    return {
      worldPosition: this.mesh.getAbsolutePosition(),
      name: this.def.name,
      faction: FACTION_PALETTES[this.def.faction].label,
      kind: "Base",
      crew: this.def.crew,
      cargo: this.def.cargo,
    };
  }
}
