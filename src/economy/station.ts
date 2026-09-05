import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "../solarSystem/celestialBody";
import { CelestialOrbit } from "../solarSystem/celestialOrbit";
import { spinPeriodSeconds } from "../solarSystem/scale";
import type { Dockable } from "./dockable";
import type { StationDef } from "./economyDefs";
import { FACTION_PALETTES } from "./factions";
import type { ExaminableInfo } from "../ui/examineUI";

const tmpParentPos = new Vector3();

const materialCache = new Map<string, StandardMaterial>();

/** Stations are a torus, not a box - CreateBox's per-face faceUV atlas trick (hullTexture.ts)
 * doesn't apply to a continuous ring surface, so this is a simple faction-colored material
 * instead (cached per faction, same sharing idea as createHullMaterial). */
function createStationMaterial(scene: Scene, def: StationDef): StandardMaterial {
  const cached = materialCache.get(def.faction);
  if (cached) return cached;
  const palette = FACTION_PALETTES[def.faction];
  const material = new StandardMaterial(`stationMaterial_${def.faction}`, scene);
  material.diffuseColor = palette.hull;
  material.emissiveColor = palette.accent.scale(0.15);
  material.specularColor = Color3.Black();
  materialCache.set(def.faction, material);
  return material;
}

/** Cosmetic spin period for the ring itself (a slow rotating-wheel look, like a Stanford
 * torus/2001-style station) - independent of its geosynchronous orbit period. */
const STATION_SPIN_SECONDS = 90;

/**
 * A ring-shaped station in geosynchronous orbit around a planet - its orbit period is derived
 * from the PARENT body's own (already-compressed) spin period, never hand-picked, so it
 * genuinely stays over the same point on the surface regardless of that body's spin rate.
 * Architecturally identical to how the Moon orbits Earth: a CelestialOrbit with eccentricity 0
 * (a perfect circle), its orbitNode reparented onto the planet's own orbitNode after
 * construction - this gets orbit-line drawing, the cached-sample per-frame update, and
 * predictLocalPositionAt (for ship rendezvous, added in a later phase) for free, rather than
 * duplicating any of that in a bespoke "simple circular orbit" class.
 *
 * Ships routing through a station "pass through the ring" as a visual/flight-path detail only -
 * not a mandatory chokepoint. The torus is rotated 90 degrees off CreateTorus's default (hole
 * along local Y) so the hole instead faces horizontally - a ring leading to and from the planet,
 * not lying flat like a table. No orbit line: unlike a moon or planet, a geosynchronous station
 * doesn't have a meaningfully different position to trace - it's always over the same point on
 * the surface, so a drawn ellipse would just be visual clutter with nothing distinct to show.
 */
export class Station implements Dockable {
  readonly id: string;
  readonly def: StationDef;
  readonly orbit: CelestialOrbit;
  readonly parentBody: CelestialBody;
  readonly mesh: Mesh;

  constructor(scene: Scene, def: StationDef, parentBody: CelestialBody) {
    this.id = def.id;
    this.def = def;
    this.parentBody = parentBody;

    this.orbit = new CelestialOrbit(scene, {
      name: def.id,
      semiMajorAxis: parentBody.radius * def.orbitRadiusInParentRadii,
      eccentricity: 0,
      orbitPeriodSeconds: spinPeriodSeconds(parentBody.def),
      orbitAxis: Vector3.Up(),
      spinPeriodSeconds: STATION_SPIN_SECONDS,
      spinAxis: Vector3.Up(),
      startAngle: Math.random() * Math.PI * 2,
    });
    // Same reparenting trick already proven for the Moon in solarSystem.ts: once orbitNode's
    // parent is the planet's own orbitNode (not the scene root), ordinary scene-graph
    // composition carries this station's small local ellipse along with wherever the planet
    // currently is, for free.
    this.orbit.orbitNode.parent = parentBody.orbit.orbitNode;

    const outerRadius = Math.max(20, parentBody.radius * 0.05);
    this.mesh = MeshBuilder.CreateTorus(`${def.id}Mesh`, { diameter: outerRadius * 2, thickness: outerRadius * 0.28, tessellation: 24 }, scene);
    this.mesh.material = createStationMaterial(scene, def);
    this.mesh.parent = this.orbit.spinNode;
    // CreateTorus's default orientation lies the ring flat (hole along local Y) - rotated 90
    // degrees around Z so the hole instead faces horizontally, reading as a ring leading to and
    // from the planet rather than a flat table sitting in orbit.
    this.mesh.rotation.z = Math.PI / 2;
  }

  /** Composes the parent planet's future position with this station's own future position in
   * the planet's orbit frame - valid because orbitNode only ever translates, never rotates, so
   * this is a plain vector add, not a matrix transform. */
  predictWorldPositionAt(secondsFromNow: number, out: Vector3): Vector3 {
    this.parentBody.orbit.predictLocalPositionAt(secondsFromNow, tmpParentPos);
    this.orbit.predictLocalPositionAt(secondsFromNow, out);
    out.addInPlace(tmpParentPos);
    return out;
  }

  toExamineInfo(): ExaminableInfo {
    return {
      worldPosition: this.mesh.getAbsolutePosition(),
      name: this.def.name,
      faction: FACTION_PALETTES[this.def.faction].label,
      kind: "Station",
      crew: this.def.crew,
      cargo: this.def.cargo,
    };
  }
}
