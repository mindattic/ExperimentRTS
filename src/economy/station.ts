import { Color3, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "../solarSystem/celestialBody";
import { CelestialOrbit } from "../solarSystem/celestialOrbit";
import { orbitalScale } from "../solarSystem/orbitalScale";
import { spinPeriodSeconds } from "../solarSystem/scale";
import type { Dockable } from "./dockable";
import type { StationDef } from "./economyDefs";
import { FACTION_PALETTES } from "./factions";
import type { ExaminableInfo } from "../ui/examineUI";

const tmpParentPos = new Vector3();
const tmpRadialDir = new Vector3();
const tmpSpinRot = new Quaternion();
const tmpFaceRot = new Quaternion();

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
  // Every planet/terrain material at this scene's huge near/far ratio uses useLogarithmicDepth
  // (see celestialBody.ts/planetTerrain.ts) - without it here too, the station's linear depth
  // values don't compare consistently against a planet's logarithmic ones, so the torus could
  // draw in front of a planet that should be occluding it.
  material.useLogarithmicDepth = true;
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
 * not a mandatory chokepoint. The mesh is parented to orbitNode (not spinNode, unlike every
 * other CelestialOrbit user) and its own update() recomputes rotationQuaternion every frame
 * instead: the torus's hole (local Y, CreateTorus's default) is kept pointed at the planet's
 * center at all times - "the mouth must always be facing the center of the planet" - which a
 * fixed one-time rotation can't do for a body that keeps orbiting (its position relative to the
 * planet still traces the same circle regardless of the orbit being geosynchronous, and
 * spinNode's generic spin mechanism can't track that without a moving spinAxis). The decorative
 * "slow rotating wheel" spin still happens, just around that same radial axis instead - a torus
 * is rotationally symmetric about its own hole axis, so spinning it there never changes which
 * way it faces. No orbit line: unlike a moon or planet, a geosynchronous station doesn't have a
 * meaningfully different position to trace - it's always over the same point on the surface, so
 * a drawn ellipse would just be visual clutter with nothing distinct to show.
 */
export class Station implements Dockable {
  readonly id: string;
  readonly kind = "station";
  readonly def: StationDef;
  readonly orbit: CelestialOrbit;
  readonly parentBody: CelestialBody;
  readonly mesh: Mesh;
  /** This station's orbit distance at gameplay/actual scale, same pattern as
   * CelestialBody.gameplaySemiMajorAxis/actualSemiMajorAxis - blended every frame in update() so
   * the ring keeps sitting "right up against the planet" as the parent's own rendered radius
   * blends toward actualRadius under the Actual/Gameplay toggle, instead of staying frozen at
   * whichever radius happened to be current at construction time. */
  private readonly gameplaySemiMajorAxis: number;
  private readonly actualSemiMajorAxis: number;
  private spinAngle = Math.random() * Math.PI * 2; // random phase so every station's ring doesn't spin in lockstep

  constructor(scene: Scene, def: StationDef, parentBody: CelestialBody) {
    this.id = def.id;
    this.def = def;
    this.parentBody = parentBody;
    this.gameplaySemiMajorAxis = parentBody.radius * def.orbitRadiusInParentRadii;
    this.actualSemiMajorAxis = parentBody.actualRadius * def.orbitRadiusInParentRadii;

    this.orbit = new CelestialOrbit(scene, {
      name: def.id,
      semiMajorAxis: this.gameplaySemiMajorAxis,
      eccentricity: 0,
      orbitPeriodSeconds: spinPeriodSeconds(parentBody.def),
      orbitAxis: Vector3.Up(),
      // spinNode's own spin is unused here (see the class doc comment - the mesh is parented to
      // orbitNode instead, and update() drives its rotation directly), so these are just
      // harmless placeholders to satisfy CelestialOrbitOptions.
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
    // Parented to orbitNode, not spinNode (see the class doc comment) - update() computes its
    // rotationQuaternion directly every frame instead of relying on CelestialOrbit's generic
    // fixed-axis spin.
    this.mesh.parent = this.orbit.orbitNode;
    this.mesh.rotationQuaternion = new Quaternion();
    this.update(0);
  }

  /** Keeps the torus's hole (local Y) pointed at the planet's center every frame - see the class
   * doc comment for why this can't be a fixed one-time rotation - while still applying a slow
   * decorative spin around that same radial axis (harmless: a torus is rotationally symmetric
   * about its own hole axis, so this never changes which way it faces). */
  update(deltaSeconds: number): void {
    this.orbit.setSemiMajorAxis(this.gameplaySemiMajorAxis + (this.actualSemiMajorAxis - this.gameplaySemiMajorAxis) * orbitalScale.blend);
    this.spinAngle += deltaSeconds * ((2 * Math.PI) / STATION_SPIN_SECONDS);
    // orbitNode.position is this station's offset from the planet's own orbitNode origin (its
    // parent - see the constructor) - negating and normalizing it points back at the planet.
    tmpRadialDir.copyFrom(this.orbit.orbitNode.position).normalize().scaleInPlace(-1);
    Quaternion.RotationAxisToRef(Vector3.Up(), this.spinAngle, tmpSpinRot); // spin around local Y first...
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), tmpRadialDir, tmpFaceRot); // ...then reorient Y to face the planet
    tmpFaceRot.multiplyToRef(tmpSpinRot, this.mesh.rotationQuaternion!);
  }

  /** Composes the parent planet's future position with this station's own future position in
   * the planet's orbit frame - valid because orbitNode only ever translates, never rotates, so
   * this is a plain vector add, not a matrix transform. Uses parentBody's own
   * predictWorldPositionAt (not a direct one-level orbit.predictLocalPositionAt read) so a
   * station orbiting a MOON (parentBody itself has a parentBody) still composes the full chain -
   * matching Base.predictWorldPositionAt's own already-recursive pattern - rather than silently
   * dropping the moon's own offset from its planet. No current STATION_DEFS entry orbits a moon,
   * but nothing here should assume that stays true. */
  predictWorldPositionAt(secondsFromNow: number, out: Vector3): Vector3 {
    this.parentBody.predictWorldPositionAt(secondsFromNow, tmpParentPos);
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
