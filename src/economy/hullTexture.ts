import { Color3, DynamicTexture, Scene, StandardMaterial, Texture, Vector4 } from "@babylonjs/core";
import { FACTION_PALETTES, type FactionId } from "./factions";
import { mulberry32 } from "../terrain/prng";

const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;
const CELL = 128;

/**
 * Babylon's CreateBox `faceUV` index -> face, verified directly against the installed
 * @babylonjs/core box-builder source (node_modules/@babylonjs/core/Meshes/Builders/
 * boxBuilder.pure.js - its `normals` array groups 4 vertices per face in this exact order):
 * 0:+Z(front) 1:-Z(back) 2:+X(right) 3:-X(left) 4:+Y(top) 5:-Y(bottom). Index 0 = +Z lines up
 * exactly with this codebase's existing forward-axis convention (computeLookRotationToRef's
 * `forward` param), so "face 0 = front" needs no extra bookkeeping to match a ship's direction
 * of travel.
 */
const FRONT = 0;
const BACK = 1;
const RIGHT = 2;
const LEFT = 3;
const TOP = 4;
const BOTTOM = 5;

/** Atlas grid layout: [col, row] per face, drawn into a 3-col x 2-row grid.
 * NOTE: DynamicTexture's canvas-row-vs-UV-V orientation has not been empirically verified yet
 * (useOpenGLOrientationForUV defaults to false in this Babylon version, meaning faceUV's V
 * coordinate is used un-flipped - but whether that lines up with "row 0 = top of canvas" as
 * drawn here is a separate question about how Texture sampling itself orients V). If faces come
 * out upside-down or on the wrong side when screenshotted, flip the row values here - the fix
 * is confined to this one table. */
const CELL_FOR_FACE: Record<number, [number, number]> = {
  [FRONT]: [0, 0],
  [BACK]: [1, 0],
  [TOP]: [2, 0],
  [LEFT]: [0, 1],
  [RIGHT]: [1, 1],
  [BOTTOM]: [2, 1],
};

function cellUV(col: number, row: number): Vector4 {
  const u0 = col / ATLAS_COLS;
  const u1 = (col + 1) / ATLAS_COLS;
  const v0 = row / ATLAS_ROWS;
  const v1 = (row + 1) / ATLAS_ROWS;
  return new Vector4(u0, v0, u1, v1);
}

/** faceUV array for MeshBuilder.CreateBox, matching the atlas this module generates. */
export const HULL_FACE_UV: Vector4[] = [FRONT, BACK, RIGHT, LEFT, TOP, BOTTOM].map((face) => {
  const [col, row] = CELL_FOR_FACE[face];
  return cellUV(col, row);
});

function colorToCss(c: Color3, alpha = 1): string {
  return `rgba(${(c.r * 255) | 0}, ${(c.g * 255) | 0}, ${(c.b * 255) | 0}, ${alpha})`;
}

function shade(c: Color3, factor: number): Color3 {
  return new Color3(Math.min(1, Math.max(0, c.r * factor)), Math.min(1, Math.max(0, c.g * factor)), Math.min(1, Math.max(0, c.b * factor)));
}

function cellOrigin(face: number): [number, number] {
  const [col, row] = CELL_FOR_FACE[face];
  return [col * CELL, row * CELL];
}

function drawFront(ctx: CanvasRenderingContext2D, hull: Color3, accent: Color3): void {
  const [ox, oy] = cellOrigin(FRONT);
  ctx.fillStyle = colorToCss(hull);
  ctx.fillRect(ox, oy, CELL, CELL);
  ctx.fillStyle = colorToCss(accent);
  ctx.strokeStyle = colorToCss(shade(accent, 0.5));
  ctx.lineWidth = 3;
  const pad = CELL * 0.22;
  const w = CELL - pad * 2;
  const h = CELL * 0.42;
  const y = CELL * 0.3;
  ctx.beginPath();
  ctx.roundRect(pad, y, w, h, 10);
  ctx.fill();
  ctx.stroke();
}

function drawBack(ctx: CanvasRenderingContext2D, hull: Color3, accent: Color3): void {
  const [ox, oy] = cellOrigin(BACK);
  ctx.fillStyle = colorToCss(shade(hull, 0.5));
  ctx.fillRect(ox, oy, CELL, CELL);
  const cx = ox + CELL / 2;
  const cy = oy + CELL / 2;
  const r = CELL * 0.36;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  gradient.addColorStop(0, colorToCss(new Color3(1, 1, 1)));
  gradient.addColorStop(0.35, colorToCss(accent, 0.9));
  gradient.addColorStop(1, colorToCss(accent, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colorToCss(shade(accent, 0.7));
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.75, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSide(ctx: CanvasRenderingContext2D, face: number, tint: Color3, arrowRight: boolean): void {
  const [ox, oy] = cellOrigin(face);
  ctx.fillStyle = colorToCss(shade(tint, 0.85));
  ctx.fillRect(ox, oy, CELL, CELL);
  ctx.fillStyle = colorToCss(new Color3(1, 1, 1));
  const cy = oy + CELL / 2;
  const dir = arrowRight ? 1 : -1;
  const cx = ox + CELL / 2 - dir * CELL * 0.12;
  const size = CELL * 0.16;
  ctx.beginPath();
  ctx.moveTo(cx + dir * size, cy);
  ctx.lineTo(cx - dir * size * 0.4, cy - size * 0.7);
  ctx.lineTo(cx - dir * size * 0.4, cy + size * 0.7);
  ctx.closePath();
  ctx.fill();
}

function drawTop(ctx: CanvasRenderingContext2D, hull: Color3, seed: number): void {
  const [ox, oy] = cellOrigin(TOP);
  ctx.fillStyle = colorToCss(hull);
  ctx.fillRect(ox, oy, CELL, CELL);
  ctx.strokeStyle = colorToCss(shade(hull, 0.6));
  ctx.lineWidth = 2;
  const rand = mulberry32(seed);
  for (let i = 0; i < 5; i++) {
    const y = oy + 10 + i * (CELL - 20) * (1 / 4) + (rand() - 0.5) * 4;
    ctx.beginPath();
    ctx.moveTo(ox + 8, y);
    ctx.lineTo(ox + CELL - 8, y);
    ctx.stroke();
  }
}

function drawBottom(ctx: CanvasRenderingContext2D, hull: Color3, seed: number): void {
  const [ox, oy] = cellOrigin(BOTTOM);
  ctx.fillStyle = colorToCss(hull);
  ctx.fillRect(ox, oy, CELL, CELL);
  ctx.strokeStyle = colorToCss(shade(hull, 0.55));
  ctx.lineWidth = 2;
  const rand = mulberry32(seed);
  const positions: [number, number][] = [
    [ox + CELL * 0.3, oy + CELL * 0.3],
    [ox + CELL * 0.7, oy + CELL * 0.3],
    [ox + CELL * 0.3, oy + CELL * 0.7],
    [ox + CELL * 0.7, oy + CELL * 0.7],
  ];
  const hatchSize = CELL * 0.22;
  for (const [hx, hy] of positions) {
    const jitter = (rand() - 0.5) * 4;
    ctx.strokeRect(hx - hatchSize / 2 + jitter, hy - hatchSize / 2, hatchSize, hatchSize);
  }
}

/** Deterministic string -> numeric seed, for turning a def's `id`/`bodyName` into a mulberry32
 * seed (surface-anchor placement, hull texture panel-line jitter, etc.) without needing a
 * hand-picked numeric seed field on every def. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const materialCache = new Map<string, StandardMaterial>();

/**
 * Builds (and caches, per faction) the procedural die-cross hull texture atlas + material for
 * Base/Station/Ship cuboids. Pass `atlasUrl` to load a real downloaded texture (e.g. a Kenney.nl
 * "prototype cube" atlas) instead of generating one procedurally - same faceUV/grid convention,
 * so no mesh-code changes are needed either way.
 */
export function createHullMaterial(scene: Scene, faction: FactionId, seed: number, atlasUrl?: string): StandardMaterial {
  const cacheKey = atlasUrl ?? faction;
  const cached = materialCache.get(cacheKey);
  if (cached) return cached;

  const material = new StandardMaterial(`hullMaterial_${cacheKey}`, scene);
  material.specularColor = Color3.Black();
  material.backFaceCulling = true;

  if (atlasUrl) {
    material.diffuseTexture = new Texture(atlasUrl, scene);
  } else {
    const palette = FACTION_PALETTES[faction];
    const texture = new DynamicTexture(`hullTexture_${faction}`, { width: ATLAS_COLS * CELL, height: ATLAS_ROWS * CELL }, scene, false);
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    drawFront(ctx, palette.hull, palette.accent);
    drawBack(ctx, palette.hull, palette.accent);
    drawSide(ctx, LEFT, new Color3(0.8, 0.15, 0.15), false);
    drawSide(ctx, RIGHT, new Color3(0.15, 0.7, 0.2), true);
    drawTop(ctx, palette.hull, seed);
    drawBottom(ctx, palette.hull, seed ^ 0x9e3779b9);
    texture.update(false);
    material.diffuseTexture = texture;
  }

  materialCache.set(cacheKey, material);
  return material;
}

const iconMaterialCache = new Map<FactionId, StandardMaterial>();

/**
 * Builds (and caches, per faction) the small glowing-dot icon texture/material a Ship swaps to
 * once it's far from the camera (see ship.ts's updateLod) - a Homeworld-style billboarded
 * sprite, same radial-gradient-on-a-DynamicTexture technique already used for Star's glow.
 */
export function createShipIconMaterial(scene: Scene, faction: FactionId): StandardMaterial {
  const cached = iconMaterialCache.get(faction);
  if (cached) return cached;

  const palette = FACTION_PALETTES[faction];
  const size = 32;
  const texture = new DynamicTexture(`shipIconTexture_${faction}`, size, scene, false);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  const cx = size / 2;
  const cy = size / 2;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  gradient.addColorStop(0, colorToCss(new Color3(1, 1, 1)));
  gradient.addColorStop(0.4, colorToCss(palette.accent, 0.9));
  gradient.addColorStop(1, colorToCss(palette.accent, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update(false);

  const material = new StandardMaterial(`shipIconMaterial_${faction}`, scene);
  material.diffuseTexture = texture;
  material.opacityTexture = texture;
  material.emissiveColor = Color3.White();
  material.disableLighting = true;
  material.backFaceCulling = false;
  iconMaterialCache.set(faction, material);
  return material;
}
