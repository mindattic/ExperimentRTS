import { Mesh, MeshBuilder, Quaternion, Scene, TransformNode, Vector3, type LinesMesh } from "@babylonjs/core";
import type { Dockable } from "./dockable";
import type { ShipDef } from "./economyDefs";
import { FACTION_PALETTES } from "./factions";
import { createHullMaterial, createShipIconMaterial, hashSeed, HULL_FACE_UV } from "./hullTexture";
import {
  buildFlightProfile,
  computeFlightRotations,
  effectiveCruiseSpeed,
  evaluateFlightProfile,
  evaluateFlightRotation,
  solveRendezvous,
  type FlightProfile,
} from "./shipTransit";
import { EARTH_RADIUS } from "../solarSystem/scale";
import type { ExaminableInfo } from "../ui/examineUI";
import { graphicsSettings } from "../settings/graphicsSettings";

type ShipPhase = "docked" | "transit";

/** Beyond this distance from the camera, a ship's real cube swaps to a small billboarded icon
 * (Homeworld-style) - two states toggled via setEnabled(), the same two-state LOD swap
 * PlanetTerrain.visit() already uses for its own mesh/child swap, just without a quadtree. */
const SHIP_BILLBOARD_DISTANCE = EARTH_RADIUS * 8;
const ICON_SIZE = 40;
/** Ship trajectories are dashed (not solid, like planet/station orbit lines) to read as a
 * moving asset's planned path rather than a fixed orbit - Babylon's built-in CreateDashedLines
 * handles the segment-count bookkeeping internally, no custom shader needed. */
const TRAJECTORY_DASH_SIZE = 200;
const TRAJECTORY_GAP_SIZE = 150;

/** Resolves a route-stop id (a Base's bodyName or a Station's id) to its Dockable. */
export type StopResolver = (id: string) => Dockable;

/**
 * A ship running a fixed back-and-forth route between Bases/Stations (economyDefs.ts's
 * ShipDef.route). Alternates "docked" (dwelling, loading/unloading) and "transit" (a flip-and-
 * burn flight - see shipTransit.ts - toward a rendezvous-predicted point on the destination's
 * future path, not its current position). `root` is a plain, unparented world-space
 * TransformNode driving position + rotationQuaternion; both the cube mesh and its billboarded-
 * icon LOD swap (see updateLod) are parented to it at the origin, so they always share the
 * same transform without needing to keep two meshes in sync by hand.
 */
export class Ship {
  readonly def: ShipDef;
  readonly root: TransformNode;
  readonly cubeMesh: Mesh;
  readonly iconMesh: Mesh;

  currentSpeed = 0;
  etaSeconds = 0;

  private readonly scene: Scene;
  private phase: ShipPhase = "docked";
  private profile: FlightProfile | null = null;
  private elapsed = 0;
  private dwellRemaining: number;
  private routeIndex: number;
  private routeDirection: 1 | -1 = 1;
  private currentDestination: Dockable | null = null;
  private trajectoryLine: LinesMesh | null = null;
  /** Desired visibility for the NEXT trajectory line created (departNext) - see
   * setTrajectoryVisible(). Defaults to graphicsSettings.showShipTrajectories's value at
   * construction; EconomyManager keeps every ship's flag in sync as the setting changes live. */
  private trajectoryVisible: boolean;
  private readonly qPrograde = new Quaternion();
  private readonly qRetrograde = new Quaternion();

  constructor(scene: Scene, def: ShipDef, startDock: Dockable) {
    this.scene = scene;
    this.def = def;
    this.trajectoryVisible = graphicsSettings.showShipTrajectories;
    this.routeIndex = def.startRouteIndex ?? 0;
    // Randomized so a whole roster doesn't all depart in the same frame.
    this.dwellRemaining = def.dwellSeconds * (0.3 + Math.random() * 0.7);

    this.root = new TransformNode(`${def.id}Root`, scene);
    this.root.rotationQuaternion = new Quaternion();
    startDock.predictWorldPositionAt(0, this.root.position);

    const size = Math.max(6, def.cruiseSpeed * 0.03);
    this.cubeMesh = MeshBuilder.CreateBox(`${def.id}Mesh`, { size, faceUV: HULL_FACE_UV }, scene);
    this.cubeMesh.material = createHullMaterial(scene, def.faction, hashSeed(def.id));
    this.cubeMesh.parent = this.root;

    this.iconMesh = MeshBuilder.CreatePlane(`${def.id}Icon`, { size: ICON_SIZE }, scene);
    this.iconMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.iconMesh.isPickable = false;
    this.iconMesh.material = createShipIconMaterial(scene, def.faction);
    this.iconMesh.parent = this.root;
    this.iconMesh.setEnabled(false);
  }

  update(deltaSeconds: number, cameraWorldPosition: Vector3, resolveStop: StopResolver): void {
    if (this.phase === "transit") {
      this.elapsed = Math.min(this.elapsed + deltaSeconds, this.profile!.totalSeconds);
      this.currentSpeed = evaluateFlightProfile(this.profile!, this.elapsed, this.root.position);
      evaluateFlightRotation(this.profile!, this.elapsed, this.qPrograde, this.qRetrograde, this.root.rotationQuaternion!);
      this.etaSeconds = this.profile!.totalSeconds - this.elapsed;
      if (this.elapsed >= this.profile!.totalSeconds) this.arrive();
    } else {
      this.currentSpeed = 0;
      this.etaSeconds = 0;
      this.dwellRemaining -= deltaSeconds;
      if (this.dwellRemaining <= 0) this.departNext(resolveStop);
    }
    this.updateLod(cameraWorldPosition);
  }

  toExamineInfo(): ExaminableInfo {
    const info: ExaminableInfo = {
      worldPosition: this.root.position,
      name: this.def.name,
      faction: FACTION_PALETTES[this.def.faction].label,
      kind: "Ship",
      crew: this.def.crew,
      cargo: this.def.cargo,
    };
    if (this.phase === "transit") {
      info.speedUnitsPerSec = this.currentSpeed;
      info.etaSeconds = this.etaSeconds;
    }
    return info;
  }

  private updateLod(cameraWorldPosition: Vector3): void {
    const distance = Vector3.Distance(cameraWorldPosition, this.root.getAbsolutePosition());
    const showCube = distance < SHIP_BILLBOARD_DISTANCE;
    this.cubeMesh.setEnabled(showCube);
    this.iconMesh.setEnabled(!showCube);
  }

  private arrive(): void {
    // Snaps to the destination's ACTUAL current position, erasing the fixed-point solver's
    // small residual error - cheap, and always exactly correct regardless of iteration count.
    this.currentDestination!.predictWorldPositionAt(0, this.root.position);
    this.phase = "docked";
    this.dwellRemaining = this.def.dwellSeconds;
    this.trajectoryLine?.dispose();
    this.trajectoryLine = null;
  }

  private departNext(resolveStop: StopResolver): void {
    // Captured before advanceRouteIndex overwrites routeIndex - this is where the ship is
    // departing FROM, needed (alongside destination) to keep travel time invariant across the
    // actual/gameplay orbital-scale toggle - see effectiveCruiseSpeed's own comment.
    const origin = resolveStop(this.def.route[this.routeIndex]);
    this.advanceRouteIndex();
    const destination = resolveStop(this.def.route[this.routeIndex]);
    const cruiseSpeed = effectiveCruiseSpeed(this.def.cruiseSpeed, origin, destination, this.root.position);
    const result = solveRendezvous(this.root.position, destination, cruiseSpeed);
    this.profile = buildFlightProfile(this.root.position.clone(), result.arrivalPosition, result.travelSeconds);
    computeFlightRotations(this.profile, this.qPrograde, this.qRetrograde);
    this.elapsed = 0;
    this.phase = "transit";
    this.currentDestination = destination;

    this.trajectoryLine?.dispose();
    this.trajectoryLine = MeshBuilder.CreateDashedLines(
      `${this.def.id}Trajectory`,
      { points: [this.profile.from, this.profile.to], dashSize: TRAJECTORY_DASH_SIZE, gapSize: TRAJECTORY_GAP_SIZE },
      this.scene,
    );
    this.trajectoryLine.color = FACTION_PALETTES[this.def.faction].accent;
    this.trajectoryLine.alpha = 0.5;
    this.trajectoryLine.isPickable = false;
    this.trajectoryLine.setEnabled(this.trajectoryVisible);
  }

  /** Applies immediately to the current trajectory line (if any) and is remembered for the next
   * one departNext() creates - see EconomyManager.setShipTrajectoriesVisible. */
  setTrajectoryVisible(visible: boolean): void {
    this.trajectoryVisible = visible;
    this.trajectoryLine?.setEnabled(visible);
  }

  /** Bounces at either end of the route rather than looping back to the start - the simplest
   * "reverse the route" interpretation of a fixed back-and-forth supply run. */
  private advanceRouteIndex(): void {
    const next = this.routeIndex + this.routeDirection;
    if (next < 0 || next >= this.def.route.length) {
      this.routeDirection = (this.routeDirection * -1) as 1 | -1;
    }
    this.routeIndex += this.routeDirection;
  }
}
