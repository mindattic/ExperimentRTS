import "./style.css";

import { EngineFactory, type AbstractEngine, Scene, Vector3, Color3, Color4, HemisphericLight, DirectionalLight } from "@babylonjs/core";

import { RtsGroundCamera } from "./camera/rtsGroundCamera";
import { OrbitTrackballCamera } from "./camera/orbitTrackballCamera";
import { SolarSystem } from "./solarSystem/solarSystem";
import { BODY_DEFS, sceneDistance } from "./solarSystem/scale";
import { SelectionUI } from "./ui/selection";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const reorientButton = document.getElementById("reorientButton") as HTMLButtonElement;

const EARTH = BODY_DEFS.find((b) => b.name === "Earth")!;
const PLANET_RADIUS = 2000 * EARTH.relativeRadius;

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
/** Zoomed all the way out, the focused planet should still read clearly as a sphere, not a
 * speck - capped below the gap to the nearest neighboring planet so zooming out from Earth
 * doesn't wander into Venus or Mars's territory. */
const MAX_ORBIT_RADIUS = PLANET_RADIUS * 10;
/** Comfortably past Eris's orbit (the outermost body) so nothing in the system is ever clipped. */
const FAR_CLIP = Math.max(...BODY_DEFS.map((b) => sceneDistance(b.auDistance))) * 1.4;

async function main() {
  const engine: AbstractEngine = await EngineFactory.CreateAsync(canvas, {});
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.01, 0.01, 0.02, 1);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.8, 0.3), scene);
  sun.intensity = 1.1;
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.18;
  // Without a non-black groundColor, surfaces facing away from (0,1,0) get zero ambient -
  // on a sphere that's roughly half the terrain, which combined with the night side (no
  // direct light either) went fully black. This is the "minimum light" floor so the night
  // side is always at least dimly visible.
  ambient.groundColor = new Color3(0.05, 0.05, 0.07);

  const solarSystem = new SolarSystem(scene);
  const focused = solarSystem.focused;

  const orbitCamera = new OrbitTrackballCamera(scene, canvas, PLANET_RADIUS * 3.5, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, FAR_CLIP);
  orbitCamera.camera.parent = focused.orbit.spinNode;
  scene.activeCamera = orbitCamera.camera;
  orbitCamera.attach();

  const groundCamera = new RtsGroundCamera(scene, canvas, focused.heightfield!);
  groundCamera.camera.parent = focused.orbit.spinNode;

  const selectionUI = new SelectionUI(solarSystem, scene, engine, canvas);

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

    if (mode === "orbit") {
      orbitCamera.update(dt);
    } else {
      groundCamera.update(dt, PLANET_RADIUS);
    }

    const focusedCameraLocalPosition = mode === "orbit" ? orbitCamera.camera.position : groundCamera.camera.position;
    solarSystem.update(dt, focusedCameraLocalPosition, sun);

    if (mode === "orbit") {
      if (!orbitCamera.isFlying && orbitCamera.radius < ENTER_GROUND_RADIUS) {
        enterGroundMode();
      }
    } else {
      if (groundCamera.requestExitToOrbit || escapePressed) {
        exitToOrbitMode();
      }
    }
    escapePressed = false;

    selectionUI.update();

    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
