import type { Vector3 } from "@babylonjs/core";
import { Fbm3 } from "./noise";
import { TOPOLOGIES } from "./topology";
import { mulberry32 } from "./prng";
import { smoothstep } from "./mathUtils";
import type { HeightmapImageData } from "./heightmapImage";

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

/** Elevation amplitude, meters, applied to a real heightmap's normalized 0-1 sample range -
 * matches the procedural path's own ELEVATION_CAP so real and procedural terrain read at a
 * consistent scale (this project's "fun over accuracy" philosophy, not real-world meters). */
const IMAGE_AMPLITUDE_METERS = 60;

/** Elevation field for the whole planet, sampled directly on the unit sphere (seamless across
 * cube-sphere faces) - either procedural noise (default) or a real heightmap image once
 * useImage() is called (see heightmapImage.ts and SolarSystem's preload step in main.ts). */
export class PlanetHeightfield {
  private readonly fbm: Fbm3;
  private readonly seeds: BiomeSeed[] = [];
  private image: HeightmapImageData | null = null;

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

  /** Switches this heightfield to sample a real elevation image instead of procedural noise -
   * call once, after construction, when the body's real heightmap has finished loading. */
  useImage(image: HeightmapImageData): void {
    this.image = image;
  }

  /** Elevation above/below the base planet radius, in meters, at a unit sphere direction. */
  elevationAt(dir: Vector3): number {
    if (this.image) return this.elevationFromImage(this.image, dir);
    return this.elevationFromNoise(dir);
  }

  private elevationFromImage(image: HeightmapImageData, dir: Vector3): number {
    // Equirectangular convention matching the source photos: y is the polar axis, row 0 is
    // the north pole, and longitude increases eastward from an arbitrary prime meridian (this
    // game has no notion of a "real" Greenwich to align to, so any fixed convention is fine as
    // long as it's used consistently for a given body).
    const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const lon = Math.atan2(dir.z, dir.x);
    const u = lon / (Math.PI * 2) + 0.5;
    const v = 0.5 - lat / Math.PI;

    const fx = u * image.width;
    const fy = v * (image.height - 1);
    const x0 = Math.floor(fx) % image.width;
    const x1 = (x0 + 1) % image.width; // wraps at the antimeridian instead of clamping/seaming
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
    const tx = fx - Math.floor(fx);
    const ty = fy - y0;

    const sample = (x: number, y: number) => image.samples[y * image.width + x] / 255;
    const top = sample(x0, y0) * (1 - tx) + sample(x1, y0) * tx;
    const bottom = sample(x0, y1) * (1 - tx) + sample(x1, y1) * tx;
    const t = top * (1 - ty) + bottom * ty;
    return (t - 0.5) * 2 * IMAGE_AMPLITUDE_METERS;
  }

  private elevationFromNoise(dir: Vector3): number {
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
