import { Fbm3, domainWarp } from "./noise";
import { clamp01, hash3 } from "./mathUtils";

export interface TopologyPreset {
  readonly name: string;
  /** Max relief this preset can contribute, in meters. */
  readonly amplitudeMeters: number;
  /** Normalized height in [0, 1] at a point on the unit sphere. */
  height01(x: number, y: number, z: number, fbm: Fbm3): number;
}

const plains: TopologyPreset = {
  name: "plains",
  amplitudeMeters: 6,
  height01(x, y, z, fbm) {
    return fbm.sample(x, y, z, 4) * 0.5 + 0.5;
  },
};

const dunes: TopologyPreset = {
  name: "dunes",
  amplitudeMeters: 16,
  height01(x, y, z, fbm) {
    const [wx, wy, wz] = domainWarp(fbm, x, y, z, 2, 0.15);
    const ridge = Math.abs(Math.sin((wx + wy + wz) * 6 + fbm.sample(x, y, z, 3) * 2));
    const detail = fbm.sample(x, y, z, 18) * 0.12;
    return clamp01(ridge * 0.7 + detail + 0.15);
  },
};

const mesas: TopologyPreset = {
  name: "mesas",
  amplitudeMeters: 35,
  height01(x, y, z, fbm) {
    const base = fbm.sample(x, y, z, 2) * 0.5 + 0.5;
    const levels = 5;
    const terraced = Math.floor(base * levels) / (levels - 1);
    return clamp01(terraced * 0.7 + base * 0.3);
  },
};

const canyons: TopologyPreset = {
  name: "canyons",
  amplitudeMeters: 42,
  height01(x, y, z, fbm) {
    const carved = 1 - fbm.sampleRidged(x, y, z, 2);
    const base = fbm.sample(x, y, z, 1.4) * 0.35 + 0.5;
    return clamp01(base * 0.5 + carved * 0.5);
  },
};

const craterBasins: TopologyPreset = {
  name: "craterBasins",
  amplitudeMeters: 30,
  height01(x, y, z, fbm) {
    const freq = 1.6;
    const px = x * freq;
    const py = y * freq;
    const pz = z * freq;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);

    let bestDist = Infinity;
    let bestJitter = 0.5;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cx = ix + dx;
          const cy = iy + dy;
          const cz = iz + dz;
          const jx = cx + hash3(cx, cy, cz + 0.1);
          const jy = cy + hash3(cx + 7.3, cy + 3.1, cz);
          const jz = cz + hash3(cx, cy + 9.7, cz + 5.9);
          const ddx = px - jx;
          const ddy = py - jy;
          const ddz = pz - jz;
          const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          if (d < bestDist) {
            bestDist = d;
            bestJitter = hash3(cx * 3.1, cy * 3.7, cz * 3.3);
          }
        }
      }
    }

    const craterRadius = 0.4 + bestJitter * 0.3;
    const t = clamp01(bestDist / craterRadius);
    const rim = Math.exp(-(((t - 0.85) / 0.16) ** 2)) * 0.14;
    const bowl = 0.5 - (1 - t) * 0.3 + rim;
    const base = fbm.sample(x, y, z, 3) * 0.5 + 0.5;
    return clamp01(bowl * 0.8 + base * 0.2);
  },
};

const badlands: TopologyPreset = {
  name: "badlands",
  amplitudeMeters: 30,
  height01(x, y, z, fbm) {
    const [wx, wy, wz] = domainWarp(fbm, x, y, z, 2.5, 0.2);
    const ridged = fbm.sampleRidged(wx, wy, wz, 4.5);
    const fine = fbm.sample(x, y, z, 20) * 0.12;
    const base = fbm.sample(x, y, z, 1.8) * 0.5 + 0.5;
    return clamp01(ridged * 0.6 + base * 0.28 + fine + 0.06);
  },
};

export const TOPOLOGIES: readonly TopologyPreset[] = [plains, dunes, mesas, canyons, craterBasins, badlands];
