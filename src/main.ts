import "./style.css";

import {
  EngineFactory,
  type AbstractEngine,
  Scene,
  Vector3,
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  Matrix,
  Quaternion,
} from "@babylonjs/core";

import { RtsGroundCamera } from "./camera/rtsGroundCamera";
import { OrbitTrackballCamera } from "./camera/orbitTrackballCamera";
import { FreeFlyCamera } from "./camera/freeFlyCamera";
import { SolarSystem } from "./solarSystem/solarSystem";
import { BODY_DEFS, sceneDistance } from "./solarSystem/scale";
import { SelectionUI } from "./ui/selection";
import { SettingsMenu } from "./ui/settingsMenu";
import { keybindings } from "./input/keybindings";
import { graphicsSettings } from "./settings/graphicsSettings";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const freeCamBadge = document.getElementById("freeCamBadge") as HTMLElement;

/** Comfortably past Eris's orbit (the outermost body) so nothing in the system is ever clipped. */
const FAR_CLIP = Math.max(...BODY_DEFS.map((b) => sceneDistance(b.auDistance))) * 1.4;
/** Stylized transit duration - not physically timed against distance, just a consistent "warp" feel. */
const TRANSIT_DURATION_SECONDS = 3.0;

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

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
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

  const freeFlyCamera = new FreeFlyCamera(scene, canvas, FAR_CLIP);

  const selectionUI = new SelectionUI(solarSystem, scene, engine, canvas);

  let mode: "orbit" | "ground" = "orbit";
  let freeCamActive = false;
  let escapePressed = false;
  let tabPressed = false;
  let reorientPressed = false;
  let freeCamTogglePressed = false;

  const settingsMenu = new SettingsMenu(
    () => {
      reorientPressed = true;
    },
    () => {
      freeCamTogglePressed = true;
    },
  );

  window.addEventListener("keydown", (e) => {
    if (settingsMenu.isListeningForKey) return;
    if (e.code === keybindings.get("exitGround")) escapePressed = true;
    if (e.code === keybindings.get("travel")) {
      e.preventDefault();
      tabPressed = true;
    }
    if (e.code === keybindings.get("reorient")) reorientPressed = true;
    if (e.code === keybindings.get("freeCam")) freeCamTogglePressed = true;
  });

  function enterGroundMode() {
    groundCamera.setAnchorFromWorldPoint(orbitCamera.viewDir);
    const lastOrbitPosition = orbitCamera.camera.position.clone();
    const lastOrbitRotation = orbitCamera.camera.rotationQuaternion!.clone();
    orbitCamera.detach();
    scene.activeCamera = groundCamera.camera;
    groundCamera.attach(lastOrbitPosition, lastOrbitRotation);
    mode = "ground";
  }

  function exitToOrbitMode() {
    groundCamera.detach();
    orbitCamera.setViewDirFromWorldPoint(groundCamera.anchor);
    scene.activeCamera = orbitCamera.camera;
    orbitCamera.attach();
    mode = "orbit";
    orbitCamera.flyToRadius(thresholds.exitOrbit);
  }

  // --- Free cam: toggled independently of orbit/ground mode. Entering captures whichever
  // camera is currently active's true world pose (no snap); exiting reframes the orbit
  // camera on the currently-focused body (a plain cut here is fine - this is "return to
  // normal control", not the cinematic interplanetary beat Tab gets).
  function toggleFreeCam() {
    if (!freeCamActive) {
      const activeCamera = mode === "orbit" ? orbitCamera.camera : groundCamera.camera;
      const worldPos = activeCamera.globalPosition.clone();
      const worldRot = new Quaternion();
      activeCamera.getWorldMatrix().decompose(undefined, worldRot, undefined);

      if (mode === "orbit") orbitCamera.detach();
      else groundCamera.detach();

      freeFlyCamera.setPose(worldPos, worldRot);
      scene.activeCamera = freeFlyCamera.camera;
      freeFlyCamera.attach();
      freeCamActive = true;
      freeCamBadge.hidden = false;
    } else {
      freeFlyCamera.detach();
      freeCamActive = false;
      freeCamBadge.hidden = true;

      orbitCamera.camera.parent = focused.orbit.spinNode;
      orbitCamera.setViewDirFromWorldPoint(new Vector3(0, 0.35, 1));
      orbitCamera.radius = thresholds.defaultOrbit;
      scene.activeCamera = orbitCamera.camera;
      orbitCamera.attach();
      mode = "orbit";
    }
  }

  // --- Interplanetary transit: continuous world-space flight (lerp position, slerp
  // rotation) from wherever the camera currently is toward a live-tracked, continuously
  // updated framing of the target (it keeps orbiting during the flight), reparenting only
  // once arrived - so there's no snap/pop at any point, and the camera keeps roughly the
  // same relative viewing angle throughout ("makes sense from the camera's perspective").
  let transiting = false;
  let transitElapsed = 0;
  let transitTargetIndex = -1;
  const transitFromPos = new Vector3();
  const transitFromRot = new Quaternion();
  const transitApproachDir = new Vector3();
  const tmpArrivalPos = new Vector3();
  const tmpArrivalRot = new Quaternion();
  const tmpInvMatrix = new Matrix();
  const tmpLocalViewDir = new Vector3();
  const tmpLocalUp = new Vector3();

  function beginTransit() {
    if (mode !== "orbit" || transiting || freeCamActive) return;
    const targetIndex = selectionUI.targetIndex;
    if (targetIndex === null || targetIndex === solarSystem.focusedIndex) return;

    const camera = orbitCamera.camera;
    transitFromPos.copyFrom(camera.globalPosition);
    const worldMatrix = camera.getWorldMatrix();
    worldMatrix.decompose(undefined, transitFromRot, undefined);

    const departureBodyPos = focused.orbit.spinNode.getAbsolutePosition();
    transitApproachDir.copyFrom(transitFromPos).subtractInPlace(departureBodyPos).normalize();

    orbitCamera.detach();
    camera.parent = null;
    camera.position.copyFrom(transitFromPos);
    camera.rotationQuaternion!.copyFrom(transitFromRot);

    transitTargetIndex = targetIndex;
    transitElapsed = 0;
    transiting = true;
  }

  function updateTransit(deltaSeconds: number) {
    transitElapsed += deltaSeconds;
    const t = Math.min(1, transitElapsed / TRANSIT_DURATION_SECONDS);
    const eased = easeInOutCubic(t);

    const target = solarSystem.bodies[transitTargetIndex];
    const targetThresholds = radiusThresholds(target.radius);
    const targetWorldPos = target.orbit.spinNode.getAbsolutePosition();
    tmpArrivalPos.copyFrom(targetWorldPos).addInPlace(transitApproachDir.scale(targetThresholds.defaultOrbit));
    Quaternion.FromLookDirectionLHToRef(transitApproachDir, Vector3.Up(), tmpArrivalRot);

    const camera = orbitCamera.camera;
    Vector3.LerpToRef(transitFromPos, tmpArrivalPos, eased, camera.position);
    Quaternion.SlerpToRef(transitFromRot, tmpArrivalRot, eased, camera.rotationQuaternion!);

    if (t >= 1) completeTransit(target, targetThresholds);
  }

  function completeTransit(target: (typeof solarSystem.bodies)[number], targetThresholds: RadiusThresholds) {
    solarSystem.focusedIndex = transitTargetIndex;
    focused = target;
    thresholds = targetThresholds;

    // spinNode's world rotation equals its own local rotationQuaternion (its parent orbitNode
    // never rotates, only translates), so its inverse converts world directions into the
    // frame OrbitTrackballCamera's local viewDir/up are expressed in.
    const spinWorldRot = target.orbit.spinNode.rotationQuaternion!.clone().conjugateInPlace();
    Matrix.FromQuaternionToRef(spinWorldRot, tmpInvMatrix);
    Vector3.TransformCoordinatesToRef(transitApproachDir, tmpInvMatrix, tmpLocalViewDir);
    tmpLocalViewDir.normalize();
    Vector3.TransformCoordinatesToRef(Vector3.Up(), tmpInvMatrix, tmpLocalUp);
    tmpLocalUp.normalize();

    orbitCamera.camera.parent = target.orbit.spinNode;
    orbitCamera.setViewDirFromWorldPoint(tmpLocalViewDir);
    orbitCamera.up.copyFrom(tmpLocalUp);
    orbitCamera.radius = thresholds.defaultOrbit;
    orbitCamera.setRadiusLimits(thresholds.minOrbit, thresholds.maxOrbit);

    if (target.landable && target.heightfield) {
      groundCamera.setHeightfield(target.heightfield);
      groundCamera.camera.parent = target.orbit.spinNode;
    }

    orbitCamera.attach();
    transiting = false;
  }

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    if (freeCamActive) {
      freeFlyCamera.update(dt);
    } else if (transiting) {
      updateTransit(dt);
    } else if (mode === "orbit") {
      orbitCamera.update(dt);
    } else {
      groundCamera.update(dt, focused.radius);
    }

    if (!transiting && !freeCamActive) {
      const focusedCameraLocalPosition = mode === "orbit" ? orbitCamera.camera.position : groundCamera.camera.position;
      solarSystem.update(dt, focusedCameraLocalPosition, sun);
    } else {
      // Keep every body's orbit/spin advancing during transit/free-cam (including the live
      // transit target), but skip terrain LOD work - camera position isn't meaningful in any
      // body's local frame right now.
      solarSystem.update(dt, Vector3.Zero(), sun);
    }

    if (freeCamTogglePressed) toggleFreeCam();
    freeCamTogglePressed = false;

    if (!freeCamActive) {
      if (reorientPressed && mode === "orbit") orbitCamera.reorient();
      reorientPressed = false;

      if (tabPressed) beginTransit();
      tabPressed = false;

      if (!transiting) {
        if (mode === "orbit") {
          if (focused.landable && !orbitCamera.isFlying && orbitCamera.radius < thresholds.enterGround) {
            enterGroundMode();
          }
        } else if (groundCamera.requestExitToOrbit || escapePressed) {
          exitToOrbitMode();
        }
      }
    }
    escapePressed = false;

    if (!freeCamActive) selectionUI.update();

    const b = graphicsSettings.nightBrightness;
    ambient.groundColor.set(b, b, b * 1.4);

    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
