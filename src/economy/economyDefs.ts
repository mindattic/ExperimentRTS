import { BODY_DEFS, bodyRadius, maxSafePersonalSpaceRadius } from "../solarSystem/scale";
import type { FactionId } from "./factions";

export interface BaseDef {
  /** Matches a BODY_DEFS entry's `name` - the planet/moon this base sits on. */
  bodyName: string;
  name: string;
  faction: FactionId;
  crew: number;
  cargo: string;
}

export interface StationDef {
  /** Unique key, used as a route-stop id by ShipDef.route. */
  id: string;
  name: string;
  faction: FactionId;
  crew: number;
  cargo: string;
  /** BODY_DEFS name of the parent body this station orbits. */
  orbitsAround: string;
  /** Orbit distance from the parent's center, in units of the parent's own scene-unit radius -
   * same convention as BodyDef.moonOrbitRadiusInParentRadii. */
  orbitRadiusInParentRadii: number;
  /** No orbitPeriodSeconds field - stations sit in geosynchronous orbit, so their period is
   * derived from the parent body's own spin period at construction time (see station.ts),
   * never hand-picked, so it always actually matches "stays over the same point on the
   * surface" regardless of that body's spin rate. */
}

export interface ShipDef {
  id: string;
  name: string;
  faction: FactionId;
  crew: number;
  cargo: string;
  /** Peak speed reached at the flip point of its accelerate/decelerate journey, scene units/sec
   * - see shipTransit.ts. Not a constant cruise speed. */
  cruiseSpeed: number;
  /** Base bodyNames or Station ids, visited in order then reversed (ping-pong) once the route's
   * far end is reached. */
  route: string[];
  /** Seconds spent docked/loading before departing for the next stop. */
  dwellSeconds: number;
  startRouteIndex?: number;
}

/** One Base per landable body (rocky/dwarf/moon - anything with real solid ground and terrain;
 * gas giants have none). Derived from BODY_DEFS rather than hand-listed so every landable body
 * always gets one automatically, with a small override map for faction variety. */
const BASE_OVERRIDES: Partial<Record<string, Partial<Pick<BaseDef, "name" | "faction" | "crew" | "cargo">>>> = {
  Pluto: { faction: "beltConsortium" },
  Eris: { faction: "beltConsortium" },
};

export const BASE_DEFS: readonly BaseDef[] = BODY_DEFS.filter((def) => def.kind !== "gasGiant").map((def) => ({
  bodyName: def.name,
  name: `${def.name} Base`,
  faction: "solFederation",
  crew: 40,
  cargo: "General supplies",
  ...BASE_OVERRIDES[def.name],
}));

// orbitRadiusInParentRadii is 1.3 for every station (not the previous 4-6) - same fix as the
// Moon's own orbit radius (see scale.ts's BODY_DEFS comment): this scene's interplanetary
// distances are compressed while a planet's own scene-unit radius isn't, so a handful of
// "planet radii" here already reads as a huge distance once compared to nearby orbits/moons
// (earthYard at 6x literally sat farther out than the Moon at the old 9x-of-a-*much*-smaller-
// radii value). 1.3x keeps every station's torus sitting close against its planet, per "space
// dock should be right up against the planet."
export const STATION_DEFS: readonly StationDef[] = [
  { id: "earthYard", name: "Earth Orbital Yard", faction: "solFederation", crew: 220, cargo: "Refined metals", orbitsAround: "Earth", orbitRadiusInParentRadii: 1.3 },
  { id: "marsRelay", name: "Mars High Station", faction: "solFederation", crew: 90, cargo: "Ice, water", orbitsAround: "Mars", orbitRadiusInParentRadii: 1.3 },
  { id: "venusRelay", name: "Venus Relay", faction: "solFederation", crew: 40, cargo: "Sulfur compounds", orbitsAround: "Venus", orbitRadiusInParentRadii: 1.3 },
  { id: "plutoOutpost", name: "Pluto Outpost", faction: "beltConsortium", crew: 30, cargo: "Exotic ices", orbitsAround: "Pluto", orbitRadiusInParentRadii: 1.3 },
];

// Same self-check scale.ts runs for moons, applied here for stations - see
// maxSafePersonalSpaceRadius's own doc comment for why this needs to be an enforced check
// rather than a hand-picked constant trusted to still be safe.
for (const def of STATION_DEFS) {
  const parent = BODY_DEFS.find((d) => d.name === def.orbitsAround)!;
  const radius = bodyRadius(parent) * def.orbitRadiusInParentRadii;
  const safeMax = maxSafePersonalSpaceRadius(parent.name);
  if (radius > safeMax) {
    throw new Error(
      `${def.name}'s orbit radius (${radius.toFixed(0)}) exceeds ${parent.name}'s safe personal-space radius (${safeMax.toFixed(0)}) - it would reach into a neighboring body's territory. Lower orbitRadiusInParentRadii.`,
    );
  }
}

export const SHIP_DEFS: readonly ShipDef[] = [
  { id: "freighter1", name: "MV Perihelion", faction: "solFederation", crew: 8, cargo: "Machine parts (40t)", cruiseSpeed: 900, route: ["Earth", "earthYard"], dwellSeconds: 20 },
  { id: "freighter2", name: "MV Long Reach", faction: "solFederation", crew: 6, cargo: "Refined metals (25t)", cruiseSpeed: 700, route: ["earthYard", "marsRelay"], dwellSeconds: 25 },
  { id: "freighter3", name: "MV Second Wind", faction: "solFederation", crew: 5, cargo: "Water, ice (60t)", cruiseSpeed: 650, route: ["marsRelay", "Mars"], dwellSeconds: 15 },
  { id: "trader1", name: "IS Rustwind", faction: "beltConsortium", crew: 4, cargo: "Ore (80t)", cruiseSpeed: 500, route: ["Pluto", "plutoOutpost"], dwellSeconds: 20 },
  { id: "courier1", name: "MV Quickstep", faction: "solFederation", crew: 3, cargo: "Mail, small parts", cruiseSpeed: 1100, route: ["Venus", "venusRelay", "Earth"], dwellSeconds: 10 },
  { id: "trader2", name: "IS Far Horizon", faction: "beltConsortium", crew: 5, cargo: "Exotic ices (30t)", cruiseSpeed: 550, route: ["plutoOutpost", "Eris"], dwellSeconds: 25 },
];
