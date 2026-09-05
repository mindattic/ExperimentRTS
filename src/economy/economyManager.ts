import type { Node, Scene, Vector3 } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import { Base } from "./base";
import { Station } from "./station";
import { Ship } from "./ship";
import type { Dockable } from "./dockable";
import { BASE_DEFS, STATION_DEFS, SHIP_DEFS } from "./economyDefs";
import type { ExaminableInfo } from "../ui/examineUI";

function findBody(solarSystem: SolarSystem, name: string) {
  const body = solarSystem.bodies.find((b) => b.def.name === name);
  if (!body) throw new Error(`EconomyManager: no body named "${name}" in solarSystem.bodies`);
  return body;
}

/** Owns every Base/Station/Ship, builds them from the hand-authored roster in economyDefs.ts
 * once SolarSystem's bodies exist, and drives every Ship's per-frame travel update. */
export class EconomyManager {
  private readonly bases: Base[] = [];
  private readonly stations: Station[] = [];
  /** Public (not just private) so SelectionUI/main.ts can look ships up by reference for
   * selection/orbit-tracking purposes - see findShipForMesh below. */
  readonly ships: Ship[];
  private readonly stopsById = new Map<string, Dockable>();

  /** Bound once (not per-frame) so every Ship.update() call can reuse the same function
   * reference instead of allocating a fresh closure each frame. */
  private readonly resolveStop = (id: string): Dockable => {
    const stop = this.stopsById.get(id);
    if (!stop) throw new Error(`EconomyManager: no Base/Station with id "${id}" (check ShipDef.route)`);
    return stop;
  };

  constructor(scene: Scene, solarSystem: SolarSystem) {
    for (const def of BASE_DEFS) {
      const base = new Base(scene, def, findBody(solarSystem, def.bodyName));
      this.stopsById.set(base.id, base);
      this.bases.push(base);
    }
    for (const def of STATION_DEFS) {
      const station = new Station(scene, def, findBody(solarSystem, def.orbitsAround));
      this.stopsById.set(station.id, station);
      this.stations.push(station);
    }

    this.ships = SHIP_DEFS.map((def) => new Ship(scene, def, this.resolveStop(def.route[def.startRouteIndex ?? 0])));
  }

  setShipTrajectoriesVisible(visible: boolean): void {
    for (const ship of this.ships) ship.setTrajectoryVisible(visible);
  }

  /** Walks up from a picked mesh's parent chain looking for a ship's root - same pattern as
   * SelectionUI's own findBodyIndexForMesh, generalized for a different entity kind. */
  findShipForMesh(mesh: Node | null): Ship | null {
    let current = mesh;
    while (current) {
      const ship = this.ships.find((s) => s.root === current);
      if (ship) return ship;
      current = current.parent;
    }
    return null;
  }

  /** @param cameraWorldPosition Used for Ship's cube<->billboard-icon LOD swap - ships are
   * scattered system-wide, unlike SolarSystem.update's focused-body-local convention, so this
   * needs the camera's true world position regardless of which mode/camera is currently active. */
  update(deltaSeconds: number, cameraWorldPosition: Vector3): void {
    for (const ship of this.ships) ship.update(deltaSeconds, cameraWorldPosition, this.resolveStop);
    for (const station of this.stations) station.update(deltaSeconds);
  }

  /** Everything ExamineUI can show a placard for - the UI class never needs to know about
   * Base/Station/Ship directly, only this plain-object shape. */
  getExamineInfo(): ExaminableInfo[] {
    const info: ExaminableInfo[] = [];
    for (const base of this.bases) info.push(base.toExamineInfo());
    for (const station of this.stations) info.push(station.toExamineInfo());
    for (const ship of this.ships) info.push(ship.toExamineInfo());
    return info;
  }
}
