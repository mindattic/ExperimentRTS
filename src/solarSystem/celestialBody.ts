import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { PlanetTerrain } from "../terrain/planetTerrain";
import { PlanetHeightfield } from "../terrain/heightfield";
import { CelestialOrbit, type CelestialOrbitOptions } from "./celestialOrbit";
import { bodyRadius, type BodyDef } from "./scale";
import { mulberry32 } from "../terrain/prng";

const GAS_GIANT_PALETTES: Record<string, [Color3, Color3]> = {
  Jupiter: [new Color3(0.55, 0.42, 0.3), new Color3(0.82, 0.68, 0.52)],
  Saturn: [new Color3(0.68, 0.6, 0.42), new Color3(0.88, 0.82, 0.62)],
  Uranus: [new Color3(0.35, 0.62, 0.68), new Color3(0.55, 0.82, 0.85)],
  Neptune: [new Color3(0.18, 0.28, 0.62), new Color3(0.32, 0.42, 0.78)],
};

function createGasGiantTexture(scene: Scene, name: string, seed: number): DynamicTexture {
  const [low, high] = GAS_GIANT_PALETTES[name] ?? [new Color3(0.5, 0.5, 0.5), new Color3(0.8, 0.8, 0.8)];
  const size = 512;
  const texture = new DynamicTexture(`${name}Texture`, { width: size, height: size }, scene, false);
  const ctx = texture.getContext();
  const rand = mulberry32(seed);
  const bandCount = 18;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const band = Math.sin(v * bandCount * Math.PI * 2 + rand() * 0.3) * 0.5 + 0.5;
    const turbulence = Math.sin(v * 47 + rand() * 6) * 0.08;
    const t = Math.min(1, Math.max(0, band + turbulence));
    const r = low.r + (high.r - low.r) * t;
    const g = low.g + (high.g - low.g) * t;
    const b = low.b + (high.b - low.b) * t;
    ctx.fillStyle = `rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`;
    ctx.fillRect(0, y, size, 1);
  }
  texture.update(false);
  return texture;
}

/**
 * One body in the system: either a landable rocky/dwarf planet (full cube-sphere quadtree
 * terrain, reusing PlanetTerrain as-is) or a flyby-only gas giant (a cheap textured sphere,
 * no terrain, never enters RTS ground mode). Owns its own CelestialOrbit.
 */
export class CelestialBody {
  readonly def: BodyDef;
  readonly orbit: CelestialOrbit;
  readonly landable: boolean;
  readonly terrain: PlanetTerrain | null;
  readonly mesh: Mesh | null;
  readonly radius: number;

  constructor(scene: Scene, def: BodyDef, orbitOptions: CelestialOrbitOptions) {
    this.def = def;
    this.orbit = new CelestialOrbit(scene, orbitOptions);
    this.radius = bodyRadius(def);
    this.landable = def.kind !== "gasGiant";

    if (this.landable) {
      this.terrain = new PlanetTerrain(scene, this.radius, def.seed, this.orbit.spinNode);
      this.mesh = null;
      // Seed root-level patches once up front (each call only budgets a few patches - three
      // calls comfortably covers all 6 root faces) using a point far enough away that no
      // split ever triggers, so non-focused bodies still render at their coarsest LOD instead
      // of being invisible.
      const farLocal = new Vector3(0, 0, this.radius * 1000);
      this.terrain.update(farLocal);
      this.terrain.update(farLocal);
      this.terrain.update(farLocal);
    } else {
      this.terrain = null;
      this.mesh = MeshBuilder.CreateSphere(`${def.name}Mesh`, { diameter: this.radius * 2, segments: 32 }, scene);
      this.mesh.parent = this.orbit.spinNode;
      const material = new StandardMaterial(`${def.name}Material`, scene);
      material.diffuseTexture = createGasGiantTexture(scene, def.name, def.seed);
      material.specularColor = Color3.Black();
      material.useLogarithmicDepth = true;
      this.mesh.material = material;
    }
  }

  get heightfield(): PlanetHeightfield | null {
    return this.terrain?.heightfield ?? null;
  }
}
