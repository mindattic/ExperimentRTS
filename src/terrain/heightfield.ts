import type { Vector3 } from "@babylonjs/core";
import { Fbm3 } from "./noise";
import { TOPOLOGIES } from "./topology";
import { mulberry32 } from "./prng";
import { smoothstep } from "./mathUtils";

interface BiomeSeed {
  x: number;
  y: number;
  z: number;
  topology: number;
}

const BIOME_SEED_COUNT = 28;
/** Width, in unit-sphere distance, of the smoothed transition between two biome cells. */
const BIOME_BLEND_SPAN = 0.18;
/**
 * Soft ceiling/floor on elevation, in meters. Approached smoothly (via tanh, not a hard clip)
 * so even the most extreme terrain a preset can produce rounds off into a peak/pit instead of
 * a razor-sharp spike - a hard clamp would instead flatten extremes into an unnatural plateau.
 */
const ELEVATION_CAP = 65;

/** Procedural, seeded elevation field for the whole planet, sampled directly on the unit sphere (seamless across cube-sphere faces). */
export class PlanetHeightfield {
  private readonly fbm: Fbm3;
  private readonly seeds: BiomeSeed[] = [];

  constructor(seed: number) {
    this.fbm = new Fbm3(seed, 5, 2.05, 0.48);

    const rand = mulberry32(seed ^ 0x9e3779b9);
    for (let i = 0; i < BIOME_SEED_COUNT; i++) {
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      this.seeds.push({
        x: r * Math.cos(theta),
        y: r * Math.sin(theta),
        z: u,
        topology: Math.floor(rand() * TOPOLOGIES.length),
      });
    }
  }

  /** Elevation above/below the base planet radius, in meters, at a unit sphere direction. */
  elevationAt(dir: Vector3): number {
    let d0 = Infinity;
    let d1 = Infinity;
    let i0 = 0;
    let i1 = 0;
    for (let i = 0; i < this.seeds.length; i++) {
      const s = this.seeds[i];
      const dx = dir.x - s.x;
      const dy = dir.y - s.y;
      const dz = dir.z - s.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < d0) {
        d1 = d0;
        i1 = i0;
        d0 = d;
        i0 = i;
      } else if (d < d1) {
        d1 = d;
        i1 = i;
      }
    }

    const dd0 = Math.sqrt(d0);
    const dd1 = Math.sqrt(d1);
    // 0 deep inside seed i0's cell, 1 deep inside seed i1's cell, smoothed across the shared border.
    const w = smoothstep(0.5 - (dd1 - dd0) / (2 * BIOME_BLEND_SPAN));

    const presetA = TOPOLOGIES[this.seeds[i0].topology];
    const presetB = TOPOLOGIES[this.seeds[i1].topology];
    const ha = presetA.height01(dir.x, dir.y, dir.z, this.fbm) * presetA.amplitudeMeters;
    const hb = presetB.height01(dir.x, dir.y, dir.z, this.fbm) * presetB.amplitudeMeters;
    const raw = ha * (1 - w) + hb * w;
    return ELEVATION_CAP * Math.tanh(raw / ELEVATION_CAP);
  }
}
