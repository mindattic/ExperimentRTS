import { Vector3 } from "@babylonjs/core";

export interface PathObstacle {
  position: Vector3;
  radius: number;
}

const tmpSegment = new Vector3();
const tmpToObstacle = new Vector3();
const tmpClosestPoint = new Vector3();
const tmpAway = new Vector3();

/**
 * Given a straight-line path from `from` to `to`, finds the worst-penetrating obstacle (if any)
 * and returns a "detour" control point for a quadratic Bezier that bends the path around it,
 * pushed outward from the obstacle's center by enough to clear it plus a margin. Returns the
 * plain midpoint (which makes evaluateDetourPath below degenerate to an ordinary straight lerp)
 * when nothing is in the way - used by any camera blend that crosses meaningful distance
 * (interplanetary transit, orbit/ground entry blends) so free cam's own "can't fly through a
 * planet" collider (see main.ts's resolveFreeCamCollisions) has an equivalent for the automated
 * moves too, rather than those lerping straight through an unrelated body that happens to sit
 * between the start and end points.
 */
export function computeDetourControlPoint(from: Vector3, to: Vector3, obstacles: readonly PathObstacle[], clearanceMargin = 1.15): Vector3 {
  const midpoint = from.add(to).scaleInPlace(0.5);

  tmpSegment.copyFrom(to).subtractInPlace(from);
  const segmentLengthSq = tmpSegment.lengthSquared();
  if (segmentLengthSq < 1e-6) return midpoint;

  let worstObstacle: PathObstacle | null = null;
  let worstPenetration = 0;
  const worstClosestPoint = new Vector3();

  for (const obstacle of obstacles) {
    tmpToObstacle.copyFrom(obstacle.position).subtractInPlace(from);
    const t = Math.max(0, Math.min(1, Vector3.Dot(tmpToObstacle, tmpSegment) / segmentLengthSq));
    tmpClosestPoint.copyFrom(from).addInPlace(tmpSegment.scale(t));
    const dist = Vector3.Distance(tmpClosestPoint, obstacle.position);
    const requiredClearance = obstacle.radius * clearanceMargin;
    const penetration = requiredClearance - dist;
    if (penetration > worstPenetration) {
      worstPenetration = penetration;
      worstObstacle = obstacle;
      worstClosestPoint.copyFrom(tmpClosestPoint);
    }
  }

  if (!worstObstacle) return midpoint;

  // Push the closest-approach point away from the obstacle's center (perpendicular-ish to the
  // travel direction, not necessarily exactly perpendicular, but always directly away from the
  // obstacle) by enough to clear it, plus 50% extra so the whole curved path - not just this one
  // point - stays clear. A quadratic Bezier B(t) deviates from the straight line by exactly
  // 2*t*(1-t)*(control - lineMidpoint), which maxes out at HALF of (control - lineMidpoint) at
  // t=0.5 - so to actually achieve `desiredClearance` of real deviation at the curve's own
  // closest approach, the control point itself needs to move away by roughly DOUBLE that (was
  // missing this factor initially - verified numerically that the un-doubled version left the
  // curve still inside the obstacle's radius).
  tmpAway.copyFrom(worstClosestPoint).subtractInPlace(worstObstacle.position);
  const awayLength = tmpAway.length();
  const awayDir = awayLength > 1e-6 ? tmpAway.normalize() : new Vector3(0, 1, 0);
  const requiredClearance = worstObstacle.radius * clearanceMargin;
  const desiredClearance = Math.max(0, requiredClearance - awayLength) + requiredClearance * 0.5;
  const pushDistance = 2 * desiredClearance;
  return worstClosestPoint.add(awayDir.scale(pushDistance));
}

/** Quadratic Bezier through `control` - degenerates to an ordinary straight lerp when `control`
 * is the plain midpoint (the no-obstacle case above). */
export function evaluateDetourPath(from: Vector3, control: Vector3, to: Vector3, t: number, out: Vector3): void {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  out.set(from.x * a + control.x * b + to.x * c, from.y * a + control.y * b + to.y * c, from.z * a + control.z * b + to.z * c);
}
