import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

/**
 * The star itself: fixed at the world origin (a focus of every body's orbital ellipse - see
 * CelestialOrbit, which uses the same origin-at-focus parametrization). It never moves;
 * bodies orbit it.
 *
 * Rendered as a camera-facing billboard with a soft radial-gradient glow rather than a solid
 * sphere - reads as a bright light source itself, not a lit geometric object.
 */
export class Star {
  constructor(scene: Scene, radius: number) {
    const mesh = MeshBuilder.CreatePlane("star", { size: radius * 3.5 }, scene);
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.isPickable = false;

    const size = 256;
    const texture = new DynamicTexture("starGlowTexture", size, scene, false);
    texture.hasAlpha = true;
    const ctx = texture.getContext();
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.12, "rgba(255,250,235,1)");
    gradient.addColorStop(0.35, "rgba(255,225,150,0.6)");
    gradient.addColorStop(0.7, "rgba(255,205,120,0.15)");
    gradient.addColorStop(1, "rgba(255,190,100,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    texture.update(false);

    const material = new StandardMaterial("starMaterial", scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    mesh.material = material;
  }
}
