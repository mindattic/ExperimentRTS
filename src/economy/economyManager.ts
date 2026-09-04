import type { Scene } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import { Base } from "./base";
import { Station } from "./station";
import { BASE_DEFS, STATION_DEFS } from "./economyDefs";

function findBody(solarSystem: SolarSystem, name: string) {
  const body = solarSystem.bodies.find((b) => b.def.name === name);
  if (!body) throw new Error(`EconomyManager: no body named "${name}" in solarSystem.bodies`);
  return body;
}

/** Owns every Base/Station/Ship, builds them from the hand-authored roster in economyDefs.ts
 * once SolarSystem's bodies exist. Phase 2: bases + stations - Ship follows in a later phase
 * (which is when stored arrays will actually be read, e.g. by getExamineInfo() and the
 * per-frame update() loop - not added yet to keep each phase's diff honest about what's used). */
export class EconomyManager {
  constructor(scene: Scene, solarSystem: SolarSystem) {
    for (const def of BASE_DEFS) new Base(scene, def, findBody(solarSystem, def.bodyName));
    for (const def of STATION_DEFS) new Station(scene, def, findBody(solarSystem, def.orbitsAround));
  }
}
