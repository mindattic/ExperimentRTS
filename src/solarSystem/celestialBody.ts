import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3, VertexData } from "@babylonjs/core";
import { PlanetTerrain } from "../terrain/planetTerrain";
import { PlanetHeightfield } from "../terrain/heightfield";
import type { HeightmapImageData } from "../terrain/heightmapImage";
import { CelestialOrbit, type CelestialOrbitOptions } from "./celestialOrbit";
import { bodyRadius, textureResolutionFor, type BodyDef } from "./scale";
import { mulberry32 } from "../terrain/prng";

const GAS_GIANT_PALETTES: Record<string, [Color3, Color3]> = {
  Jupiter: [new Color3(0.55, 0.42, 0.3), new Color3(0.82, 0.68, 0.52)],
  Saturn: [new Color3(0.68, 0.6, 0.42), new Color3(0.88, 0.82, 0.62)],
  Uranus: [new Color3(0.35, 0.62, 0.68), new Color3(0.55, 0.82, 0.85)],
  Neptune: [new Color3(0.18, 0.28, 0.62), new Color3(0.32, 0.42, 0.78)],
};

function createGasGiantTexture(scene: Scene, name: string, seed: number, width: number, height: number): DynamicTexture {
  const [low, high] = GAS_GIANT_PALETTES[name] ?? [new Color3(0.5, 0.5, 0.5), new Color3(0.8, 0.8, 0.8)];
  const texture = new DynamicTexture(`${name}Texture`, { width, height }, scene, false);
  const ctx = texture.getContext();
  const rand = mulberry32(seed);
  const bandCount = 18;
  for (let y = 0; y < height; y++) {
    const v = y / height;
    const band = Math.sin(v * bandCount * Math.PI * 2 + rand() * 0.3) * 0.5 + 0.5;
    const turbulence = Math.sin(v * 47 + rand() * 6) * 0.08;
    const t = Math.min(1, Math.max(0, band + turbulence));
    const r = low.r + (high.r - low.r) * t;
    const g = low.g + (high.g - low.g) * t;
    const b = low.b + (high.b - low.b) * t;
    ctx.fillStyle = `rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`;
    ctx.fillRect(0, y, width, 1);
  }
  texture.update(false);
  return texture;
}

/** A flat, semi-transparent annulus in the XZ plane, tilted slightly for visual interest. */
function createRingMesh(scene: Scene, name: string, innerRadius: number, outerRadius: number, segments: number): Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    positions.push(cos * innerRadius, 0, sin * innerRadius, cos * outerRadius, 0, sin * outerRadius);
    uvs.push(0, i / segments, 1, i / segments);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.uvs = uvs;
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh);

  const material = new StandardMaterial(`${name}Material`, scene);
  material.diffuseColor = new Color3(0.75, 0.68, 0.55);
  material.specularColor = Color3.Black();
  material.alpha = 0.55;
  material.backFaceCulling = false;
  material.useLogarithmicDepth = true;
  mesh.material = material;
  // Pickable (parented to the same spinNode as the planet's own mesh - see the caller below),
  // so clicking/hovering the visually-apparent ring around Saturn resolves to Saturn too,
  // instead of a "miss" that read as a flickering raycast right at the disc's edge where the
  // ring visually extends past the sphere's true silhouette.
  mesh.isPickable = true;
  mesh.rotation.x = 0.35; // tilt so it doesn't read as a flat edge-on line from most angles
  return mesh;
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
  /** The semi-major axis this body was constructed with (always the compressed "gameplay"
   * distance - construction always happens before any actual/gameplay blend ever moves). */
  readonly gameplaySemiMajorAxis: number;
  /** The real-world-proportional semi-major axis this body's orbit blends toward in "actual"
   * scale mode (see orbitalScale.ts) - defaults to gameplaySemiMajorAxis (a no-op scale) for
   * bodies the toggle doesn't apply to, so SolarSystem.update can blend every body uniformly
   * without needing to special-case which ones are in scope. */
  readonly actualSemiMajorAxis: number;

  /**
   * @param heightmapImage A real elevation map preloaded for this body (see heightmapImage.ts
   * and main.ts's preload step) - only meaningful for landable bodies; switches
   * PlanetHeightfield to sample it instead of procedural noise. Omit to keep procedural
   * terrain (Pluto/Eris, or if a real map failed to load).
   * @param actualSemiMajorAxis The real-world-proportional distance this body's orbit blends
   * toward in "actual" scale mode - omit for bodies not in the toggle's scope (e.g. dwarf
   * planets/moons with no accurate real-distance figure entered yet).
   */
  constructor(scene: Scene, def: BodyDef, orbitOptions: CelestialOrbitOptions, heightmapImage?: HeightmapImageData, actualSemiMajorAxis?: number) {
    this.def = def;
    this.orbit = new CelestialOrbit(scene, orbitOptions);
    this.radius = bodyRadius(def);
    this.landable = def.kind !== "gasGiant";
    this.gameplaySemiMajorAxis = orbitOptions.semiMajorAxis;
    this.actualSemiMajorAxis = actualSemiMajorAxis ?? orbitOptions.semiMajorAxis;

    if (this.landable) {
      this.terrain = new PlanetTerrain(scene, this.radius, def.seed, this.orbit.spinNode);
      if (heightmapImage) this.terrain.heightfield.useImage(heightmapImage);
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
      const maxTextureSize = scene.getEngine().getCaps().maxTextureSize;
      const { width, height } = textureResolutionFor(def, maxTextureSize);
      material.diffuseTexture = createGasGiantTexture(scene, def.name, def.seed, width, height);
      material.specularColor = Color3.Black();
      material.useLogarithmicDepth = true;
      this.mesh.material = material;

      if (def.name === "Saturn") {
        const ring = createRingMesh(scene, "SaturnRing", this.radius * 1.4, this.radius * 2.3, 96);
        ring.parent = this.orbit.spinNode;
      }
    }
  }

  get heightfield(): PlanetHeightfield | null {
    return this.terrain?.heightfield ?? null;
  }
}
