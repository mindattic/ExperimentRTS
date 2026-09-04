import { Mesh, MeshBuilder, Quaternion, Scene, TransformNode } from "@babylonjs/core";
import type { Dockable } from "./dockable";
import type { ShipDef } from "./economyDefs";
import { createHullMaterial, hashSeed, HULL_FACE_UV } from "./hullTexture";
import { buildFlightProfile, computeFlightRotations, evaluateFlightProfile, evaluateFlightRotation, solveRendezvous, type FlightProfile } from "./shipTransit";

type ShipPhase = "docked" | "transit";

/** Resolves a route-stop id (a Base's bodyName or a Station's id) to its Dockable. */
export type StopResolver = (id: string) => Dockable;

/**
 * A ship running a fixed back-and-forth route between Bases/Stations (economyDefs.ts's
 * ShipDef.route). Alternates "docked" (dwelling, loading/unloading) and "transit" (a flip-and-
 * burn flight - see shipTransit.ts - toward a rendezvous-predicted point on the destination's
 * future path, not its current position). `root` is a plain, unparented world-space
 * TransformNode driving position + rotationQuaternion; the visible cube mesh is parented to it
 * at the origin so a later billboarded-icon LOD swap (Phase 4) can share the same transform
 * without needing to keep two meshes in sync by hand.
 */
export class Ship {
  readonly def: ShipDef;
  readonly root: TransformNode;
  readonly cubeMesh: Mesh;

  currentSpeed = 0;
  etaSeconds = 0;

  private phase: ShipPhase = "docked";
  private profile: FlightProfile | null = null;
  private elapsed = 0;
  private dwellRemaining: number;
  private routeIndex: number;
  private routeDirection: 1 | -1 = 1;
  private currentDestination: Dockable | null = null;
  private readonly qPrograde = new Quaternion();
  private readonly qRetrograde = new Quaternion();

  constructor(scene: Scene, def: ShipDef, startDock: Dockable) {
    this.def = def;
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
  }

  update(deltaSeconds: number, resolveStop: StopResolver): void {
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
  }

  private arrive(): void {
    // Snaps to the destination's ACTUAL current position, erasing the fixed-point solver's
    // small residual error - cheap, and always exactly correct regardless of iteration count.
    this.currentDestination!.predictWorldPositionAt(0, this.root.position);
    this.phase = "docked";
    this.dwellRemaining = this.def.dwellSeconds;
  }

  private departNext(resolveStop: StopResolver): void {
    this.advanceRouteIndex();
    const destination = resolveStop(this.def.route[this.routeIndex]);
    const result = solveRendezvous(this.root.position, destination, this.def.cruiseSpeed);
    this.profile = buildFlightProfile(this.root.position.clone(), result.arrivalPosition, result.travelSeconds);
    computeFlightRotations(this.profile, this.qPrograde, this.qRetrograde);
    this.elapsed = 0;
    this.phase = "transit";
    this.currentDestination = destination;
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
