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
import { computeLookRotationToRef } from "./camera/lookRotation";
import { SolarSystem } from "./solarSystem/solarSystem";
import { BODY_DEFS, sceneDistance, HEIGHTMAP_SOURCES, textureResolutionFor } from "./solarSystem/scale";
import { loadHeightmapImage, type HeightmapImageData } from "./terrain/heightmapImage";
import { StellarDust } from "./environment/stellarDust";
import { SelectionUI } from "./ui/selection";
import { SettingsMenu } from "./ui/settingsMenu";
import { keybindings } from "./input/keybindings";
import { graphicsSettings } from "./settings/graphicsSettings";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const freeCamBadge = document.getElementById("freeCamBadge") as HTMLElement;
const planeLockBadge = document.getElementById("planeLockBadge") as HTMLElement;
const freeCamReticle = document.getElementById("freeCamReticle") as HTMLElement;

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
  catchRadius: number;
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
    // Free cam "catch" distance (see updateFreeCamCatch in main()) - deliberately smaller than
    // maxOrbit, which serves a different purpose (the orbit camera's own zoom-out clamp). At
    // 10x, a gas giant's already-large radius (Jupiter alone is 4x Earth's) balloons into a
    // catch zone that can swallow a third of the way to its neighbors, making the "flown clear
    // of everything" re-arm condition nearly unreachable from well within the system.
    catchRadius: bodyRadius * 5,
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Loads every body's real heightmap (see scale.ts's HEIGHTMAP_SOURCES) up front, resampled to
 * its size-proportional target resolution, before the solar system is built - CelestialBody
 * needs the fully-decoded image synchronously at construction time (PlanetHeightfield.elevationAt
 * is called many times per terrain patch), so this can't happen lazily per-body later. A body
 * whose real map fails to load just keeps PlanetHeightfield's procedural fallback instead of
 * blocking the whole scene. */
async function preloadHeightmaps(maxTextureSize: number): Promise<Partial<Record<string, HeightmapImageData>>> {
  const results = await Promise.all(
    BODY_DEFS.filter((def) => HEIGHTMAP_SOURCES[def.name]).map(async (def) => {
      const source = HEIGHTMAP_SOURCES[def.name]!;
      const { width, height } = textureResolutionFor(def, maxTextureSize);
      try {
        const image = await loadHeightmapImage(source.url, width, height, source.minSample ?? 0);
        return [def.name, image] as const;
      } catch (err) {
        console.warn(`Failed to load real heightmap for ${def.name}, using procedural terrain instead.`, err);
        return null;
      }
    }),
  );
  const images: Partial<Record<string, HeightmapImageData>> = {};
  for (const result of results) {
    if (result) images[result[0]] = result[1];
  }
  return images;
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

  const heightmapImages = await preloadHeightmaps(engine.getCaps().maxTextureSize);
  const solarSystem = new SolarSystem(scene, FAR_CLIP, heightmapImages);
  let focused = solarSystem.focused;
  let thresholds = radiusThresholds(focused.radius);

  const orbitCamera = new OrbitTrackballCamera(scene, canvas, thresholds.defaultOrbit, thresholds.minOrbit, thresholds.maxOrbit, FAR_CLIP);
  orbitCamera.camera.parent = focused.orbit.spinNode;
  scene.activeCamera = orbitCamera.camera;
  orbitCamera.attach();

  const groundCamera = new RtsGroundCamera(scene, canvas, focused.heightfield!);
  groundCamera.camera.parent = focused.orbit.spinNode;

  const freeFlyCamera = new FreeFlyCamera(scene, canvas, FAR_CLIP);

  // Tracks orbitCamera.camera.position by reference (the same Vector3 object the transit code
  // below mutates every frame via LerpToRef, never reassigned) - see StellarDust's doc comment.
  const stellarDust = new StellarDust(scene, orbitCamera.camera.position);

  let mode: "orbit" | "ground" = "orbit";
  let freeCamActive = false;
  let escapePressed = false;
  let tabPressed = false;
  let reorientPressed = false;
  let freeCamTogglePressed = false;
  let lockPlaneTogglePressed = false;

  const selectionUI = new SelectionUI(solarSystem, scene, engine, canvas, freeFlyCamera, () => freeCamActive);

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
    if (e.code === keybindings.get("lockPlane")) lockPlaneTogglePressed = true;
    if (e.code === keybindings.get("selectTarget") && freeCamActive) {
      // Keyboard alternative to left-click for the free-cam reticle - clicking under Pointer
      // Lock works too, but a dedicated key is easier to hit without disturbing mouselook.
      e.preventDefault();
      selectionUI.selectWithReticle();
    }
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
    orbitCamera.resetView(groundCamera.anchor);
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
      freeCamReticle.hidden = false;
      planeLockBadge.hidden = true;
      // If free cam starts out already within some body's catch radius (the common case -
      // free cam is usually toggled on while already close to whatever you were just orbiting),
      // don't immediately catch it right back - require flying clear of every body's catch
      // radius at least once first. See updateFreeCamCatch().
      freeCamCatchArmed = !isWithinAnyBodyCatchRadius(worldPos);
    } else {
      freeFlyCamera.detach();
      freeCamActive = false;
      freeCamBadge.hidden = true;
      freeCamReticle.hidden = true;

      orbitCamera.camera.parent = focused.orbit.spinNode;
      orbitCamera.resetView(new Vector3(0, 0.35, 1));
      orbitCamera.setRadius(thresholds.defaultOrbit);
      scene.activeCamera = orbitCamera.camera;
      orbitCamera.attach();
      mode = "orbit";
      planeLockBadge.hidden = !orbitCamera.isPlaneLocked;
    }
  }

  // --- Free cam "catch": flying close enough to any body while in free cam automatically
  // hands control to the orbit camera, framed on that body - the camera can never fly straight
  // through a planet, it always gets caught into orbit first (which itself naturally narrows
  // into RTS ground view on a landable body as you keep pulling in closer, and back out to
  // orbit view as you pull away - see the enterGroundMode/exitToOrbitMode threshold checks
  // below). Armed/disarmed by updateFreeCamCatch() rather than a plain radius check, so
  // toggling free cam on while already close to a body doesn't instantly re-catch you.
  let freeCamCatchArmed = false;
  const tmpCatchDir = new Vector3();

  function isWithinAnyBodyCatchRadius(worldPos: Vector3): boolean {
    for (const body of solarSystem.bodies) {
      const bodyPos = body.orbit.spinNode.getAbsolutePosition();
      if (Vector3.Distance(worldPos, bodyPos) < radiusThresholds(body.radius).catchRadius) return true;
    }
    return false;
  }

  function updateFreeCamCatch(): void {
    const camPos = freeFlyCamera.camera.globalPosition;
    if (!freeCamCatchArmed) {
      if (!isWithinAnyBodyCatchRadius(camPos)) freeCamCatchArmed = true;
      return;
    }
    for (const body of solarSystem.bodies) {
      const bodyPos = body.orbit.spinNode.getAbsolutePosition();
      const dist = Vector3.Distance(camPos, bodyPos);
      const targetThresholds = radiusThresholds(body.radius);
      if (dist < targetThresholds.catchRadius) {
        catchFreeCamIntoOrbit(body, targetThresholds, camPos, bodyPos, dist);
        return;
      }
    }
  }

  function catchFreeCamIntoOrbit(
    target: (typeof solarSystem.bodies)[number],
    targetThresholds: RadiusThresholds,
    camPos: Vector3,
    bodyPos: Vector3,
    dist: number,
  ): void {
    // Same world-direction-to-local-viewDir conversion as completeTransit() below - spinNode's
    // world rotation equals its own local rotationQuaternion (its parent orbitNode never
    // rotates, only translates), so its inverse converts world directions into the frame
    // OrbitTrackballCamera's local viewDir/up are expressed in.
    tmpCatchDir.copyFrom(camPos).subtractInPlace(bodyPos).normalize();
    const spinWorldRot = target.orbit.spinNode.rotationQuaternion!.clone().conjugateInPlace();
    Matrix.FromQuaternionToRef(spinWorldRot, tmpInvMatrix);
    Vector3.TransformCoordinatesToRef(tmpCatchDir, tmpInvMatrix, tmpLocalViewDir);
    tmpLocalViewDir.normalize();

    solarSystem.focusedIndex = solarSystem.bodies.indexOf(target);
    focused = target;
    thresholds = targetThresholds;

    freeFlyCamera.detach();
    freeCamActive = false;
    freeCamBadge.hidden = true;
    freeCamReticle.hidden = true;

    orbitCamera.camera.parent = target.orbit.spinNode;
    orbitCamera.resetView(tmpLocalViewDir);
    orbitCamera.setRadius(Math.min(targetThresholds.maxOrbit, Math.max(targetThresholds.minOrbit, dist)));
    orbitCamera.setRadiusLimits(targetThresholds.minOrbit, targetThresholds.maxOrbit);
    // Forces camera.position/rotationQuaternion to be computed immediately from the fields just
    // set above, rather than staying at their stale pre-free-cam values for one visible frame
    // until the next regular orbitCamera.update() call (which won't happen until next tick,
    // since this frame already took the freeCamActive branch for camera movement).
    orbitCamera.update(0);

    scene.activeCamera = orbitCamera.camera;
    orbitCamera.attach();
    mode = "orbit";
    planeLockBadge.hidden = !orbitCamera.isPlaneLocked;

    if (target.landable && target.heightfield) {
      groundCamera.setHeightfield(target.heightfield);
      groundCamera.camera.parent = target.orbit.spinNode;
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
  const tmpArrivalForward = new Vector3();
  const tmpInvMatrix = new Matrix();
  const tmpLocalViewDir = new Vector3();
  const tmpLocalUp = new Vector3();
  const tmpFreeCamLocalPos = new Vector3();
  const tmpTransitDustMatrix = new Matrix();
  const tmpTransitDustDir = new Vector3();

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

    // Streaks stream backward relative to the direction the camera is coasting toward - since
    // it looks roughly toward where it's going throughout the flight (see the continuous
    // "makes sense from the camera's perspective" transit design), that's just its own forward.
    Vector3.TransformNormalToRef(Vector3.Forward(), Matrix.FromQuaternionToRef(transitFromRot, tmpTransitDustMatrix), tmpTransitDustDir);
    stellarDust.start(tmpTransitDustDir);
  }

  function updateTransit(deltaSeconds: number) {
    transitElapsed += deltaSeconds;
    const t = Math.min(1, transitElapsed / TRANSIT_DURATION_SECONDS);
    const eased = easeInOutCubic(t);

    const target = solarSystem.bodies[transitTargetIndex];
    const targetThresholds = radiusThresholds(target.radius);
    const targetWorldPos = target.orbit.spinNode.getAbsolutePosition();
    tmpArrivalPos.copyFrom(targetWorldPos).addInPlace(transitApproachDir.scale(targetThresholds.defaultOrbit));
    // Camera arrives on the near side (along transitApproachDir from the target) looking back
    // toward it, i.e. forward is the opposite direction - see lookRotation.ts for why this
    // goes through computeLookRotationToRef rather than Babylon's own FromLookDirectionLHToRef.
    tmpArrivalForward.copyFrom(transitApproachDir).scaleInPlace(-1);
    computeLookRotationToRef(tmpArrivalForward, Vector3.Up(), tmpArrivalRot);

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
    orbitCamera.setRadius(thresholds.defaultOrbit);
    orbitCamera.setRadiusLimits(thresholds.minOrbit, thresholds.maxOrbit);

    if (target.landable && target.heightfield) {
      groundCamera.setHeightfield(target.heightfield);
      groundCamera.camera.parent = target.orbit.spinNode;
    }

    orbitCamera.attach();
    transiting = false;
    stellarDust.stop();
  }

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    if (freeCamActive) {
      freeFlyCamera.update(dt);
      updateFreeCamCatch(); // may flip freeCamActive/mode to orbit right here, mid-frame
    } else if (transiting) {
      updateTransit(dt);
    } else if (mode === "orbit") {
      orbitCamera.update(dt);
    } else {
      groundCamera.update(dt, focused.radius);
    }

    if (transiting) {
      // Keep every body's orbit/spin advancing during transit (including the live target),
      // but skip terrain LOD work - camera position isn't meaningful in any body's local
      // frame while it's unparented mid-flight.
      solarSystem.update(dt, Vector3.Zero(), sun);
    } else if (freeCamActive) {
      // Free cam is unparented (true world space), so the focused body's terrain still needs
      // its camera position converted into that body's local frame - otherwise LOD freezes at
      // whatever level it was when free cam was toggled on, making nearby terrain look
      // permanently low-res no matter how close the camera actually flies.
      focused.orbit.spinNode.getWorldMatrix().invertToRef(tmpInvMatrix);
      Vector3.TransformCoordinatesToRef(freeFlyCamera.camera.globalPosition, tmpInvMatrix, tmpFreeCamLocalPos);
      solarSystem.update(dt, tmpFreeCamLocalPos, sun);
    } else {
      const focusedCameraLocalPosition = mode === "orbit" ? orbitCamera.camera.position : groundCamera.camera.position;
      solarSystem.update(dt, focusedCameraLocalPosition, sun);
    }

    if (freeCamTogglePressed) toggleFreeCam();
    freeCamTogglePressed = false;

    if (!freeCamActive) {
      if (reorientPressed && mode === "orbit") orbitCamera.reorient();
      reorientPressed = false;

      if (lockPlaneTogglePressed && mode === "orbit") {
        orbitCamera.setPlaneLocked(!orbitCamera.isPlaneLocked);
        planeLockBadge.hidden = !orbitCamera.isPlaneLocked;
      }
      lockPlaneTogglePressed = false;

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

    // Runs regardless of mode, including free cam, so the corner-bracket target-lock reticle
    // keeps tracking a selected body's screen position (via scene.activeCamera, which is
    // whichever camera is active) even while flying - it uses screen-space projection, not
    // pointer position, so it isn't affected by Pointer Lock freezing the cursor.
    selectionUI.update();

    const b = graphicsSettings.nightBrightness;
    ambient.groundColor.set(b, b, b * 1.4);

    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
