import { Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "./celestialBody";
import { easeInOutCubic } from "../terrain/mathUtils";

const TRANSITION_DURATION_SECONDS = 5.0;

/**
 * The "Actual scale" <-> "Gameplay scale" orbital-distance toggle (default key: `` ` ``) - see
 * main.ts for the keybinding and SolarSystem.update for where `blend` actually gets applied to
 * every body's CelestialOrbit.setSemiMajorAxis(). `blend` eases smoothly between 0 (gameplay,
 * today's compressed distances) and 1 (actual, true real-world proportions) over a fixed
 * duration rather than snapping instantly ("it needs to expand slerp/lerp not
 * instantaneously") - pressing the key again mid-transition reverses smoothly from wherever
 * `blend` currently is, rather than needing to finish first.
 */
class OrbitalScale {
  private target: 0 | 1 = 0;
  /** Linear (pre-eased) progress toward `target`, 0..1 - advances/reverses at a constant rate
   * regardless of direction, so reversing mid-transition is symmetric. */
  private raw = 0;
  private _blend = 0;

  /** 0 = pure gameplay scale, 1 = pure actual scale, smoothly eased in between. */
  get blend(): number {
    return this._blend;
  }

  /** True once the toggle is heading toward (or has reached) actual scale - drives the
   * "ACTUAL SCALE" badge, which reflects intent rather than waiting for the blend to finish. */
  get isActualTarget(): boolean {
    return this.target === 1;
  }

  toggle(): void {
    this.target = this.target === 0 ? 1 : 0;
  }

  update(deltaSeconds: number): void {
    const direction = this.target === 1 ? 1 : -1;
    this.raw = Math.min(1, Math.max(0, this.raw + (direction * deltaSeconds) / TRANSITION_DURATION_SECONDS));
    this._blend = easeInOutCubic(this.raw);
  }

  /** Where `body` would currently be (world space) at pure gameplay scale, regardless of the
   * live blend - exploits the fact that a body's position relative to its own orbital focus is
   * purely `unitEllipse * semiMajorAxis`, so it's just that LOCAL offset rescaled by
   * gameplaySemiMajorAxis/currentSemiMajorAxis. For a star-orbiting body that local offset IS
   * the world position (orbitNode sits directly at the star's world origin - see CelestialOrbit's
   * own class doc comment); for a moon (a Base/Station can orbit one - e.g. the Moon - since a
   * later diff added a route there) it's only the offset from its parent planet, so this recurses
   * through `parentBody` and adds the parent's own gameplay-equivalent world position. Used by
   * Ship.departNext (via shipTransit.ts) to keep travel time invariant across the orbital-scale
   * toggle - see that call site's own comment for why. */
  gameplayPositionOf(body: CelestialBody, out: Vector3): Vector3 {
    const ratio = body.gameplaySemiMajorAxis / body.orbit.semiMajorAxis;
    out.copyFrom(body.orbit.orbitNode.position).scaleInPlace(ratio);
    if (body.parentBody) {
      // A fresh Vector3, not the shared tmpParentGameplay scratch: for a 2+-level parentBody
      // chain, reusing one shared scratch across recursive calls means an inner call's write
      // clobbers the outer call's own in-progress `out` (also tmpParentGameplay) before the
      // outer addInPlace below reads it - silently dropping the middle body's own local offset.
      // Not triggered by today's BODY_DEFS (moons never nest), but wrong for any future one that
      // does. This recursion is only ever a handful of levels deep and not a per-frame hot path
      // (called from ship departure planning, not every frame), so the extra allocation is cheap.
      out.addInPlace(this.gameplayPositionOf(body.parentBody, new Vector3()));
    }
    return out;
  }
}

export const orbitalScale = new OrbitalScale();
