import { createNoise3D, type NoiseFunction3D } from "simplex-noise";
import { mulberry32 } from "./prng";

/** A seeded 3D fBm (fractal Brownian motion) field, sampled directly on the unit sphere so it is seamless across cube-sphere faces. */
export class Fbm3 {
  private readonly noise: NoiseFunction3D;
  private readonly octaves: number;
  private readonly lacunarity: number;
  private readonly gain: number;

  constructor(seed: number, octaves = 5, lacunarity = 2.05, gain = 0.5) {
    this.noise = createNoise3D(mulberry32(seed));
    this.octaves = octaves;
    this.lacunarity = lacunarity;
    this.gain = gain;
  }

  /** Samples raw noise at (x, y, z) * frequency. Returns roughly [-1, 1]. */
  sample(x: number, y: number, z: number, frequency: number): number {
    let amp = 0.5;
    let freq = frequency;
    let sum = 0;
    for (let i = 0; i < this.octaves; i++) {
      sum += amp * this.noise(x * freq, y * freq, z * freq);
      freq *= this.lacunarity;
      amp *= this.gain;
    }
    return sum;
  }

  /** Ridged variant: sharp ridges along zero-crossings, good for canyons/badlands. Returns roughly [0, 1]. */
  sampleRidged(x: number, y: number, z: number, frequency: number): number {
    let amp = 0.5;
    let freq = frequency;
    let sum = 0;
    for (let i = 0; i < this.octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq, z * freq));
      sum += amp * n * n;
      freq *= this.lacunarity;
      amp *= this.gain;
    }
    return sum;
  }

  raw(x: number, y: number, z: number): number {
    return this.noise(x, y, z);
  }
}

/** Domain-warps a unit direction before sampling, breaking up axis-aligned noise artifacts. */
export function domainWarp(fbm: Fbm3, x: number, y: number, z: number, frequency: number, strength: number): [number, number, number] {
  const wx = fbm.sample(x + 11.3, y + 7.1, z + 3.7, frequency);
  const wy = fbm.sample(x + 91.7, y + 23.9, z + 5.2, frequency);
  const wz = fbm.sample(x + 47.4, y + 63.1, z + 17.8, frequency);
  return [x + wx * strength, y + wy * strength, z + wz * strength];
}
