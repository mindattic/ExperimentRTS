import "./style.css";

import { EngineFactory, type AbstractEngine, Scene, Vector3, Color3, Color4, HemisphericLight, DirectionalLight } from "@babylonjs/core";

import { RtsGroundCamera } from "./camera/rtsGroundCamera";
import { OrbitTrackballCamera } from "./camera/orbitTrackballCamera";
import { SolarSystem } from "./solarSystem/solarSystem";
import { BODY_DEFS, sceneDistance } from "./solarSystem/scale";
import { SelectionUI } from "./ui/selection";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const reorientButton = document.getElementById("reorientButton") as HTMLButtonElement;

/** Comfortably past Eris's orbit (the outermost body) so nothing in the system is ever clipped. */
const FAR_CLIP = Math.max(...BODY_DEFS.map((b) => sceneDistance(b.auDistance))) * 1.4;
/** Fraction of a body's max orbit radius the camera pulls back to during the transit's departure beat. */
const TRANSIT_PULLBACK_FRACTION = 0.92;
const DEFAULT_ARRIVAL_VIEW_DIR = new Vector3(0, 0.35, 1);

interface RadiusThresholds {
  enterGround: number;
  exitOrbit: number;
  minOrbit: number;
  maxOrbit: number;
  defaultOrbit: number;
}

function radiusThresholds(bodyRadius: number): RadiusThresholds {
  return {
    enterGround: bodyRadius * 1.06,
    exitOrbit: bodyRadius * 1.25,
    minOrbit: bodyRadius * 1.02,
    // Capped below the gap to the nearest neighboring body so zooming out doesn't wander into
    // another body's territory (see the scale.ts spacing notes).
    maxOrbit: bodyRadius * 10,
    defaultOrbit: bodyRadius * 3.5,
  };
}

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
  let focused = solarSystem.focused;
  let thresholds = radiusThresholds(focused.radius);

  const orbitCamera = new OrbitTrackballCamera(scene, canvas, thresholds.defaultOrbit, thresholds.minOrbit, thresholds.maxOrbit, FAR_CLIP);
  orbitCamera.camera.parent = focused.orbit.spinNode;
  scene.activeCamera = orbitCamera.camera;
  orbitCamera.attach();

  const groundCamera = new RtsGroundCamera(scene, canvas, focused.heightfield!);
  groundCamera.camera.parent = focused.orbit.spinNode;

  const selectionUI = new SelectionUI(solarSystem, scene, engine, canvas);

  let mode: "orbit" | "ground" = "orbit";
  /** Two-beat transit: pull back from the departure body, reparent+reset at peak pullback, fly in on the target. Simpler and far more robust than puppeteering true world-space flight through a continuously-moving target - see the Sol System Explorer plan's Phase 4 notes. */
  let transitPhase: "pullback" | "arrive" | null = null;
  let escapePressed = false;
  let tabPressed = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") escapePressed = true;
    if (e.code === "Tab") {
      e.preventDefault();
      tabPressed = true;
    }
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
    orbitCamera.flyToRadius(thresholds.exitOrbit);
    reorientButton.hidden = false;
  }

  function beginTransit() {
    if (mode !== "orbit" || transitPhase) return;
    const targetIndex = selectionUI.targetIndex;
    if (targetIndex === null || targetIndex === solarSystem.focusedIndex) return;
    transitPhase = "pullback";
    orbitCamera.flyToRadius(thresholds.maxOrbit * TRANSIT_PULLBACK_FRACTION);
  }

  function completePullback() {
    const targetIndex = selectionUI.targetIndex!;
    const target = solarSystem.bodies[targetIndex];
    solarSystem.focusedIndex = targetIndex;
    focused = target;
    thresholds = radiusThresholds(target.radius);

    orbitCamera.camera.parent = target.orbit.spinNode;
    orbitCamera.setViewDirFromWorldPoint(DEFAULT_ARRIVAL_VIEW_DIR);
    orbitCamera.radius = thresholds.maxOrbit * TRANSIT_PULLBACK_FRACTION;
    orbitCamera.setRadiusLimits(thresholds.minOrbit, thresholds.maxOrbit);

    if (target.landable && target.heightfield) {
      groundCamera.setHeightfield(target.heightfield);
      groundCamera.camera.parent = target.orbit.spinNode;
    }

    transitPhase = "arrive";
    orbitCamera.flyToRadius(thresholds.defaultOrbit);
  }

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    if (mode === "orbit") {
      orbitCamera.update(dt);
    } else {
      groundCamera.update(dt, focused.radius);
    }

    const focusedCameraLocalPosition = mode === "orbit" ? orbitCamera.camera.position : groundCamera.camera.position;
    solarSystem.update(dt, focusedCameraLocalPosition, sun);

    if (transitPhase === "pullback" && !orbitCamera.isFlying) {
      completePullback();
    } else if (transitPhase === "arrive" && !orbitCamera.isFlying) {
      transitPhase = null;
    }

    if (tabPressed) beginTransit();
    tabPressed = false;

    if (!transitPhase) {
      if (mode === "orbit") {
        if (focused.landable && !orbitCamera.isFlying && orbitCamera.radius < thresholds.enterGround) {
          enterGroundMode();
        }
      } else if (groundCamera.requestExitToOrbit || escapePressed) {
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
