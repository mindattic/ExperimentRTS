import { Quaternion, Vector3 } from "@babylonjs/core";
import { computeLookRotationToRef } from "../camera/lookRotation";
import { orbitalScale } from "../solarSystem/orbitalScale";
import type { Dockable } from "./dockable";

export interface RendezvousResult {
  arrivalPosition: Vector3;
  travelSeconds: number;
}

const tmpPredicted = new Vector3();
const tmpFromGameplay = new Vector3();
const tmpToGameplay = new Vector3();

/** Distance between `from`/`to`'s gameplay-equivalent positions (see
 * orbitalScale.gameplayPositionOf) rather than their real, live (possibly Actual-scale-blended)
 * ones - a Base/Station's own local offset from its parent planet is independent of the toggle
 * (Bases sit at a fixed surface point; Stations are explicitly out of scope - see
 * orbitalScale.ts), so only the parent planet's own position needs rescaling. */
function gameplayEquivalentDistance(from: Dockable, fromPosition: Vector3, to: Dockable, toPosition: Vector3): number {
  orbitalScale.gameplayPositionOf(from.parentBody, tmpFromGameplay);
  tmpFromGameplay.addInPlace(fromPosition).subtractInPlace(from.parentBody.orbit.orbitNode.position);
  orbitalScale.gameplayPositionOf(to.parentBody, tmpToGameplay);
  tmpToGameplay.addInPlace(toPosition).subtractInPlace(to.parentBody.orbit.orbitNode.position);
  return Vector3.Distance(tmpFromGameplay, tmpToGameplay);
}

/**
 * Solves for how long a ship flying with peak speed `cruiseSpeed` (the flip-and-burn flight
 * profile below - peak speed occurs at the flip point, not a constant cruise) takes to
 * intercept a moving `destination`, and where that interception point actually is - `origin` is
 * only used to keep travel time invariant across the Actual/Gameplay orbital-scale toggle (see
 * gameplayEquivalentDistance), never to change the destination flown to.
 *
 * Circular dependency: travel time depends on distance to the *predicted future* point, which
 * itself depends on travel time. Solved by fixed-point iteration (an initial "destination
 * doesn't move" seed, then a few refinement passes) - an accepted non-physical approximation,
 * valid because every orbit in this game is near-circular/low-eccentricity (scale.ts caps
 * eccentricity at 0.02 system-wide) and ship cruise speeds are tuned so travelSeconds stays
 * well under the destination's own orbital period, so each pass's correction shrinks fast.
 *
 * Travel time itself is computed from the GAMEPLAY-equivalent distance to the same converged
 * intercept point, not the real (possibly Actual-scale) one - "the time it takes to get from
 * Mars to Jupiter is the same in both Actual and gameplay mode" - so the ship still physically
 * flies to and arrives at the true, real intercept point (arrivalPosition), only its DURATION is
 * rescaled. An earlier version of this rescaled `cruiseSpeed` by a separately-snapshotted
 * distance ratio instead of folding it into this same iteration - only an approximation for a
 * fast-moving destination over a long flight, since that snapshot and this solve's own converged
 * intercept point aren't generally the same point. Iterating on the gameplay-equivalent distance
 * directly, at the SAME point this loop already converges to, is exact instead.
 * @param leadSeconds How far in the future `departurePosition` already is (0 if solving right at
 * departure, or however long a dwell period remains if pre-planned ahead of time - see
 * Ship.planNextLeg) - shifts the whole prediction window so `destination`'s position is always
 * evaluated at (leadSeconds + travelSeconds) from now, not travelSeconds from now.
 */
export function solveRendezvous(
  origin: Dockable,
  departurePosition: Vector3,
  destination: Dockable,
  cruiseSpeed: number,
  leadSeconds = 0,
  iterations = 3,
): RendezvousResult {
  destination.predictWorldPositionAt(leadSeconds, tmpPredicted);
  let travelSeconds = (2 * gameplayEquivalentDistance(origin, departurePosition, destination, tmpPredicted)) / cruiseSpeed;

  for (let i = 0; i < iterations; i++) {
    destination.predictWorldPositionAt(leadSeconds + travelSeconds, tmpPredicted);
    travelSeconds = (2 * gameplayEquivalentDistance(origin, departurePosition, destination, tmpPredicted)) / cruiseSpeed;
  }

  return { arrivalPosition: tmpPredicted.clone(), travelSeconds };
}

export interface FlightProfile {
  readonly from: Vector3;
  readonly to: Vector3;
  /** Unit vector from -> to, constant for the whole straight-line leg. */
  readonly direction: Vector3;
  readonly totalDistance: number;
  readonly totalSeconds: number;
  /** Constant-magnitude proper acceleration (4*distance/totalSeconds^2) - the sign conceptually
   * flips at the midpoint (accelerating away from `from`, then decelerating toward `to`), but
   * since the path is a straight line, evaluateFlightProfile handles that via the piecewise
   * distance formula below rather than actually negating this value. */
  readonly accel: number;
}

/**
 * Builds a "flip and burn" flight profile: constant proper acceleration for the first half of
 * the journey, then constant deceleration for the second half, arriving at ~zero closing speed.
 * Given total distance D and total time T: half the distance is covered during acceleration
 * (D/2 = 0.5*a*(T/2)^2 -> a = 4D/T^2), and peak speed at the midpoint is v_peak = a*(T/2) =
 * 2D/T - which is exactly why solveRendezvous's travelSeconds formula (2*distance/cruiseSpeed)
 * isn't arbitrary: setting v_peak = cruiseSpeed gives T = 2D/cruiseSpeed directly, so the ship
 * stat *is* the peak of this curve, with no separate reconciliation needed.
 */
export function buildFlightProfile(from: Vector3, to: Vector3, totalSeconds: number): FlightProfile {
  const delta = to.subtract(from);
  const totalDistance = delta.length();
  const direction = totalDistance > 1e-6 ? delta.scale(1 / totalDistance) : Vector3.Forward();
  const accel = totalDistance > 1e-6 ? (4 * totalDistance) / (totalSeconds * totalSeconds) : 0;
  return { from: from.clone(), to: to.clone(), direction, totalDistance, totalSeconds, accel };
}

/**
 * Evaluates position + instantaneous speed at elapsed time `t` (0..totalSeconds), writing the
 * world position into `outPosition`. Returns the scalar speed (for the "current speed" placard
 * stat) - ramps 0 -> peak -> 0, never negative (a straight-line intercept never reverses
 * direction of travel, only decelerates).
 */
export function evaluateFlightProfile(profile: FlightProfile, t: number, outPosition: Vector3): number {
  const { totalSeconds: T, totalDistance: D, accel } = profile;
  const half = T / 2;
  let distanceCovered: number;
  let speed: number;
  if (t <= half) {
    distanceCovered = 0.5 * accel * t * t;
    speed = accel * t;
  } else {
    const tau = t - half;
    const peakSpeed = accel * half;
    distanceCovered = D / 2 + peakSpeed * tau - 0.5 * accel * tau * tau;
    speed = Math.max(0, peakSpeed - accel * tau);
  }
  Vector3.LerpToRef(profile.from, profile.to, D > 1e-6 ? distanceCovered / D : 1, outPosition);
  return speed;
}

/** Radians/seconds fraction (whichever wins) of the journey centered on the T/2 flip point over
 * which rotation blends from prograde to retrograde - a visible pitch-over, not an instant pop. */
const FLIP_HALF_WINDOW_FRACTION = 0.02;
const MIN_FLIP_HALF_WINDOW_SECONDS = 0.4;

/**
 * Since the flight path is a straight line, the velocity *direction* never actually changes -
 * only its magnitude ramps up then down - so a literal "nose always points along velocity"
 * reading would never rotate the ship at all. The flip-and-burn maneuver is really about which
 * end has thrust facing which way, not the velocity vector: nose-first while accelerating
 * (thrust out the back pushes it forward), then a 180-degree pitch-over partway through so the
 * engine bell now faces *forward* (toward the direction of travel) in order to brake - meaning
 * after the flip, the nose trails and the tail leads. qPrograde/qRetrograde should be computed
 * once at departure (via computeLookRotationToRef, this codebase's established forward/up ->
 * quaternion builder) and passed in here each frame.
 */
export function evaluateFlightRotation(profile: FlightProfile, t: number, qPrograde: Quaternion, qRetrograde: Quaternion, outQuat: Quaternion): void {
  const half = profile.totalSeconds / 2;
  const window = Math.max(MIN_FLIP_HALF_WINDOW_SECONDS, profile.totalSeconds * FLIP_HALF_WINDOW_FRACTION);
  if (t <= half - window) outQuat.copyFrom(qPrograde);
  else if (t >= half + window) outQuat.copyFrom(qRetrograde);
  else Quaternion.SlerpToRef(qPrograde, qRetrograde, (t - (half - window)) / (2 * window), outQuat);
}

/** Computes the prograde/retrograde rotation pair for a flight profile's straight-line
 * direction - call once at departure, then reuse each frame via evaluateFlightRotation. */
export function computeFlightRotations(profile: FlightProfile, qPrograde: Quaternion, qRetrograde: Quaternion): void {
  computeLookRotationToRef(profile.direction, Vector3.Up(), qPrograde);
  const backward = profile.direction.scale(-1);
  computeLookRotationToRef(backward, Vector3.Up(), qRetrograde);
}
