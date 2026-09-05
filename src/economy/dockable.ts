import type { Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "../solarSystem/celestialBody";

/** Anything a Ship can travel to/from and predict the future position of - Base and Station
 * both implement this. Kept intentionally minimal so shipTransit.ts's rendezvous solver never
 * needs to know which concrete kind of stop it's dealing with. */
export interface Dockable {
  readonly id: string;
  /** The planet this dockable ultimately orbits (directly for Base/Station today) - used by
   * shipTransit.ts's effectiveCruiseSpeed to keep travel time invariant across the actual/
   * gameplay orbital-scale toggle (see orbitalScale.gameplayPositionOf). */
  readonly parentBody: CelestialBody;
  /** World-space position this dockable will occupy `secondsFromNow` from now. Writes into
   * `out` and returns it, so callers can reuse a scratch Vector3 across repeated calls (the
   * rendezvous solver in shipTransit.ts calls this several times per solve). */
  predictWorldPositionAt(secondsFromNow: number, out: Vector3): Vector3;
}
