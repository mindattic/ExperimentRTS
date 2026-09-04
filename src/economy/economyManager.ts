import type { Scene } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import { Base } from "./base";
import { Station } from "./station";
import { Ship } from "./ship";
import type { Dockable } from "./dockable";
import { BASE_DEFS, STATION_DEFS, SHIP_DEFS } from "./economyDefs";

function findBody(solarSystem: SolarSystem, name: string) {
  const body = solarSystem.bodies.find((b) => b.def.name === name);
  if (!body) throw new Error(`EconomyManager: no body named "${name}" in solarSystem.bodies`);
  return body;
}

/** Owns every Base/Station/Ship, builds them from the hand-authored roster in economyDefs.ts
 * once SolarSystem's bodies exist, and drives every Ship's per-frame travel update. */
export class EconomyManager {
  private readonly ships: Ship[];
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
    }
    for (const def of STATION_DEFS) {
      const station = new Station(scene, def, findBody(solarSystem, def.orbitsAround));
      this.stopsById.set(station.id, station);
    }

    this.ships = SHIP_DEFS.map((def) => new Ship(scene, def, this.resolveStop(def.route[def.startRouteIndex ?? 0])));
  }

  update(deltaSeconds: number): void {
    for (const ship of this.ships) ship.update(deltaSeconds, this.resolveStop);
  }
}
