import { Color3, DynamicTexture, MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

const TEXTURE_SIZE = 1024;
const STAR_COUNT = 2500;

/** A big inward-facing sphere with a procedurally-dotted starfield texture, so the void isn't flat black. */
export function createStarfield(scene: Scene, radius: number): void {
  const skybox = MeshBuilder.CreateSphere("starfieldSkybox", { diameter: radius * 2, segments: 16 }, scene);
  skybox.isPickable = false;

  const material = new StandardMaterial("starfieldMaterial", scene);
  const texture = new DynamicTexture("starfieldTexture", TEXTURE_SIZE, scene, false);
  const ctx = texture.getContext();
  ctx.fillStyle = "#000005";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const brightness = Math.random();
    const size = brightness > 0.97 ? 1.8 : 0.8;
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.35 + brightness * 0.65).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  texture.update(false);

  material.emissiveTexture = texture;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.backFaceCulling = false;
  material.disableLighting = true;
  material.useLogarithmicDepth = true;
  skybox.material = material;
}
