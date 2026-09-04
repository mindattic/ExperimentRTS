import "./style.css";

import { EngineFactory, type AbstractEngine, Scene, Vector3, Color3, Color4, HemisphericLight, DirectionalLight } from "@babylonjs/core";

import { PLANET_RADIUS, PLANET_SEED } from "./config";
import { PlanetTerrain } from "./terrain/planetTerrain";
import { RtsGroundCamera } from "./camera/rtsGroundCamera";
import { OrbitTrackballCamera } from "./camera/orbitTrackballCamera";
import { Star } from "./environment/star";
import { PlanetMotion } from "./environment/planetMotion";
import { createStarfield } from "./environment/starfield";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const reorientButton = document.getElementById("reorientButton") as HTMLButtonElement;

/** Orbit radius below which we hand off to the fixed RTS ground camera. */
const ENTER_GROUND_RADIUS = PLANET_RADIUS * 1.06;
/**
 * Radius the orbit camera flies back out to when leaving ground mode. Kept comfortably above
 * ENTER_GROUND_RADIUS: the fly-back animates radius upward through that threshold, so without
 * this margin (and the `flyingToOrbit` guard below) the orbit-mode entry check would
 * immediately re-trigger ground mode mid-animation.
 */
const EXIT_ORBIT_RADIUS = PLANET_RADIUS * 1.25;
const MIN_ORBIT_RADIUS = PLANET_RADIUS * 1.02;
/** Zoomed all the way out, the planet should still read clearly as a sphere, not a speck. */
const MAX_ORBIT_RADIUS = PLANET_RADIUS * 15;
/** Comfortably past the star's orbit distance (40x planet radius) so it's never clipped. */
const FAR_CLIP = PLANET_RADIUS * 80;

const tmpSunDirection = new Vector3();

async function main() {
  const engine: AbstractEngine = await EngineFactory.CreateAsync(canvas, {});
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.01, 0.01, 0.02, 1);

  createStarfield(scene, FAR_CLIP * 0.95);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.8, 0.3), scene);
  sun.intensity = 1.1;
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.18;
  // Without a non-black groundColor, surfaces facing away from (0,1,0) get zero ambient -
  // on a sphere that's roughly half the terrain, which combined with the night side (no
  // direct light either) went fully black. This is the "minimum light" floor so the night
  // side is always at least dimly visible.
  ambient.groundColor = new Color3(0.05, 0.05, 0.07);

  new Star(scene, PLANET_RADIUS);
  const motion = new PlanetMotion(scene, PLANET_RADIUS);
  motion.createOrbitLine(scene);

  const terrain = new PlanetTerrain(scene, PLANET_RADIUS, PLANET_SEED, motion.spinNode);

  const orbitCamera = new OrbitTrackballCamera(scene, canvas, PLANET_RADIUS * 3.5, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, FAR_CLIP);
  orbitCamera.camera.parent = motion.spinNode;
  scene.activeCamera = orbitCamera.camera;
  orbitCamera.attach();

  const groundCamera = new RtsGroundCamera(scene, canvas, terrain.heightfield);
  groundCamera.camera.parent = motion.spinNode;

  let mode: "orbit" | "ground" = "orbit";
  let escapePressed = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") escapePressed = true;
  });

  reorientButton.addEventListener("click", () => {
    orbitCamera.reorient();
  });

  function enterGroundMode() {
    groundCamera.setAnchorFromWorldPoint(orbitCamera.viewDir);
    const lastOrbitPosition = orbitCamera.camera.position.clone();
    const lastOrbitRotation = orbitCamera.camera.rotationQuaternion!.clone();
    orbitCamera.detach();
    scene.activeCamera = groundCamera.camera;
    groundCamera.attach(lastOrbitPosition, lastOrbitRotation);
    mode = "ground";
    reorientButton.hidden = true;
  }

  function exitToOrbitMode() {
    groundCamera.detach();
    orbitCamera.setViewDirFromWorldPoint(groundCamera.anchor);
    scene.activeCamera = orbitCamera.camera;
    orbitCamera.attach();
    mode = "orbit";
    orbitCamera.flyToRadius(EXIT_ORBIT_RADIUS);
    reorientButton.hidden = false;
  }

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    motion.update(dt);
    motion.sunDirectionTo(Vector3.Zero(), tmpSunDirection);
    sun.direction.copyFrom(tmpSunDirection);

    if (mode === "orbit") {
      orbitCamera.update(dt);
      terrain.update(orbitCamera.camera.position);
      if (!orbitCamera.isFlying && orbitCamera.radius < ENTER_GROUND_RADIUS) {
        enterGroundMode();
      }
    } else {
      groundCamera.update(dt, PLANET_RADIUS);
      terrain.update(groundCamera.camera.position);
      if (groundCamera.requestExitToOrbit || escapePressed) {
        exitToOrbitMode();
      }
    }
    escapePressed = false;

    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
