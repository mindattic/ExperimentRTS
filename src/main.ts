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
import { computeDetourControlPoint, evaluateDetourPath, type PathObstacle } from "./camera/pathAvoidance";
import { SolarSystem } from "./solarSystem/solarSystem";
import { BODY_DEFS, actualSceneDistance, COLOR_MAP_SOURCES, HEIGHTMAP_SOURCES, textureResolutionFor, STAR_RADIUS } from "./solarSystem/scale";
import { orbitalScale } from "./solarSystem/orbitalScale";
import { loadColorImage, loadHeightmapImage, type ColorImageData, type HeightmapImageData } from "./terrain/heightmapImage";
import { StellarDust } from "./environment/stellarDust";
import { SelectionUI, type SelectedEntity } from "./ui/selection";
import { SelectionAreaUI } from "./ui/selectionArea";
import { BodyIconsUI } from "./ui/bodyIcons";
import { EconomyManager } from "./economy/economyManager";
import { ExamineUI } from "./ui/examineUI";
import { SettingsMenu } from "./ui/settingsMenu";
import { keybindings } from "./input/keybindings";
import { graphicsSettings } from "./settings/graphicsSettings";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const freeCamBadge = document.getElementById("freeCamBadge") as HTMLElement;
const planeLockBadge = document.getElementById("planeLockBadge") as HTMLElement;
const orbitalScaleBadge = document.getElementById("orbitalScaleBadge") as HTMLElement;
const freeCamReticle = document.getElementById("freeCamReticle") as HTMLElement;
const devStats = document.getElementById("devStats") as HTMLElement;

/** RTS ground mode is disabled for now ("disable RTS mode for now") - Free Cam and Focus/Orbit
 * are the two supported modes. Gates every path INTO ground mode (jumpToRtsAtSpot's fast jump
 * from free cam, and orbit mode's own automatic zoom-in transition below) - flip back to true
 * to restore it; none of the gated logic itself is removed. */
const RTS_MODE_ENABLED = false;

/** Fixed "parking distance" focus mode zooms to when double-tapping F around a selected body -
 * not the current distance (clamped), so committing to focus mode always reads the same
 * regardless of how far away free cam happened to be. */
const FOCUS_MODE_ORBIT_RADIUS_FACTOR = 2.5;

/** How long a second F press must land within a first for enterOrbit to fire - the same
 * "double-actuate to commit" idea as the mouse double-click-to-zoom, so a single stray tap of F
 * (which also toggles free cam on its own - both share this key) can't accidentally commit to
 * focus mode. */
const ENTER_FOCUS_DOUBLE_TAP_MS = 400;

/** Comfortably past Eris's orbit (the outermost body) so nothing in the system is ever clipped -
 * uses actualSceneDistance (not sceneDistance) since Actual scale mode's real-proportional
 * distances are always farther than gameplay scale's compressed ones for the same body. */
const FAR_CLIP = Math.max(...BODY_DEFS.map((b) => actualSceneDistance(b.auDistance))) * 1.4;
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
    // Raised from 1.06/1.25 per "transition to RTS view much further out" - ground mode now
    // kicks in (and hands back to orbit) noticeably farther from the surface, matching
    // RtsGroundCamera's own much larger MAX_EYE_HEIGHT.
    enterGround: bodyRadius * 1.35,
    exitOrbit: bodyRadius * 1.5,
    minOrbit: bodyRadius * 1.02,
    // Capped below the gap to the nearest neighboring body so zooming out doesn't wander into
    // another body's territory (see the scale.ts spacing notes).
    maxOrbit: bodyRadius * 10,
    defaultOrbit: bodyRadius * 3.5,
  };
}

/** Free cam can't fly through a body - it collides against an invisible sphere just outside the
 * visual surface (see resolveFreeCamCollisions), replacing the old automatic proximity "catch"
 * into orbit, which read as jarring/involuntary. Committing to orbit around something is now
 * always a deliberate action instead - see enterOrbitFromFreeCam and jumpToRtsAtSpot below. */
const FREE_CAM_COLLIDER_FACTOR = 1.05;

/** Fixed orbit-radius range for "orbitEntity" mode (orbiting a selected ship/asteroid) - unlike
 * planets, these don't have a per-body radiusThresholds() scale (ships/asteroids are all tiny
 * and roughly similar in size, tens of units, not thousands), so one shared range covers them. */
const ENTITY_ORBIT_MIN_RADIUS = 30;
const ENTITY_ORBIT_MAX_RADIUS = 400;
const ENTITY_ORBIT_DEFAULT_RADIUS = 120;

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

/** Loads every LANDABLE body's real color/diffuse map (see scale.ts's COLOR_MAP_SOURCES) up
 * front, same shape and fallback behavior as preloadHeightmaps - resampled to the same
 * size-proportional target resolution as that body's own heightmap (textureResolutionFor is
 * per-BODY, not per-source, so color and elevation share one target size for a given body).
 * Gas giants are deliberately excluded here: their real color texture (if any) is loaded
 * directly as a GPU Texture at its own native resolution in SolarSystem/CelestialBody instead
 * of being CPU-decoded through this pixel-array path, which only rocky/dwarf terrain needs
 * (see CelestialBody's colorImage vs gasGiantColorTextureUrl params). */
async function preloadColorMaps(maxTextureSize: number): Promise<Partial<Record<string, ColorImageData>>> {
  const results = await Promise.all(
    BODY_DEFS.filter((def) => def.kind !== "gasGiant" && COLOR_MAP_SOURCES[def.name]).map(async (def) => {
      const source = COLOR_MAP_SOURCES[def.name]!;
      const { width, height } = textureResolutionFor(def, maxTextureSize);
      try {
        const image = await loadColorImage(source.url, width, height);
        return [def.name, image] as const;
      } catch (err) {
        console.warn(`Failed to load real color texture for ${def.name}, using procedural terrain color instead.`, err);
        return null;
      }
    }),
  );
  const images: Partial<Record<string, ColorImageData>> = {};
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
  const colorImages = await preloadColorMaps(engine.getCaps().maxTextureSize);
  const solarSystem = new SolarSystem(scene, FAR_CLIP, heightmapImages, colorImages);
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

  let mode: "orbit" | "ground" | "orbitEntity" = "orbit";
  let freeCamActive = false;
  let escapePressed = false;
  let travelPressed = false;
  let reorientPressed = false;
  let freeCamTogglePressed = false;
  let lockPlaneTogglePressed = false;
  let orbitalScaleTogglePressed = false;
  let enterOrbitPressed = false;
  let lastEnterOrbitTapTime = 0;
  // Suppresses the orbit->ground auto-entry check for a moment right after exitToOrbitMode()
  // flies the camera back up past the enterGround threshold - without it, that upward flight's
  // own still-below-threshold starting radius would immediately bounce straight back into
  // ground mode before it ever got anywhere (see exitToOrbitMode/enterGroundMode below).
  let groundExitCooldownRemaining = 0;

  const selectionUI: SelectionUI = new SelectionUI(
    solarSystem,
    scene,
    engine,
    canvas,
    freeFlyCamera,
    () => freeCamActive,
    () => {
      if (freeCamActive || transiting) return null;
      if (mode === "orbit") return solarSystem.focused.def.name;
      if (mode === "orbitEntity") return selectionUI.selectedEntity?.name ?? null;
      return null;
    },
    () => (!freeCamActive && !transiting && mode === "orbit" ? solarSystem.focused : null),
    () => freeFlyCamera.isCursorModeActive,
    () => economyManager,
    () => transiting,
  );
  new SelectionAreaUI(scene, solarSystem, orbitCamera, canvas, () => mode === "orbit" && !freeCamActive && !transiting);
  const bodyIconsUI = new BodyIconsUI(solarSystem, scene, engine, () => transiting, (index) => selectionUI.setTarget(index));
  const economyManager = new EconomyManager(scene, solarSystem);
  const examineUI = new ExamineUI(scene, engine, () => economyManager.getExamineInfo(), () => settingsMenu.isListeningForKey);

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
      travelPressed = true;
    }
    if (e.code === keybindings.get("reorient")) reorientPressed = true;
    if (e.code === keybindings.get("freeCam")) freeCamTogglePressed = true;
    if (e.code === keybindings.get("lockPlane")) lockPlaneTogglePressed = true;
    if (e.code === keybindings.get("toggleOrbitalScale") && !e.repeat) orbitalScaleTogglePressed = true;
    if (e.code === keybindings.get("selectTarget") && freeCamActive) {
      e.preventDefault();
      // Space is the single, universal "commit" key in free cam once something's selected:
      // - a specific surface spot pending (toggle cursor mode on, click a landable body - see
      //   SelectionUI.applyPickResult) flies straight into RTS ground view anchored right there,
      //   skipping orbit mode entirely;
      // - otherwise, a selected body (focus list, or a plain click/reticle-pick) smoothly enters
      //   orbit around it (lerp position + slerp rotation - see enterOrbitFromFreeCam) - the same
      //   thing double-tapping F (enterOrbit) does, without needing this fallback chain;
      // - with nothing selected yet, this is the original keyboard alternative to left-click for
      //   the free-cam reticle - clicking under Pointer Lock works too, but a dedicated key is
      //   easier to hit without disturbing mouselook.
      // The jump-to-RTS-ground branch stays disabled while RTS_MODE_ENABLED is off - see its own
      // comment. The two orbit-entry branches (and plain selection, the final else) are always
      // available.
      const spot = selectionUI.selectedSurfacePoint;
      const spotBody = spot ? solarSystem.bodies[spot.bodyIndex] : null;
      if (RTS_MODE_ENABLED && spot && spotBody?.landable) {
        jumpToRtsAtSpot(spotBody, spot.localDir);
        selectionUI.selectedSurfacePoint = null;
      } else if (selectionUI.targetIndex !== null) {
        enterOrbitFromFreeCam(solarSystem.bodies[selectionUI.targetIndex]);
      } else if (selectionUI.selectedEntity !== null) {
        // A selected ship/asteroid has no surface spot to jump to RTS at - Space just does the
        // same smooth orbit-entry double-tapping F (enterOrbit) would, same as the body case above.
        enterOrbitEntityFromFreeCam(selectionUI.selectedEntity);
      } else {
        selectionUI.selectWithReticle();
      }
    }
    if (
      e.code === keybindings.get("enterOrbit") &&
      freeCamActive &&
      !transiting &&
      !e.repeat &&
      (selectionUI.targetIndex !== null || selectionUI.selectedEntity !== null)
    ) {
      // Needs a double-tap (not a single press) to commit - see ENTER_FOCUS_DOUBLE_TAP_MS's own
      // comment for why (this key is shared with the freeCam toggle).
      const now = performance.now();
      if (now - lastEnterOrbitTapTime <= ENTER_FOCUS_DOUBLE_TAP_MS) {
        enterOrbitPressed = true;
        lastEnterOrbitTapTime = 0; // consumed - a third rapid tap shouldn't immediately fire again
      } else {
        lastEnterOrbitTapTime = now;
      }
    }
  });

  // Double-click a planet in free cam to warp straight to it (stellar dust, same feel as the
  // interplanetary transit below) instead of manually flying the whole way - "so I don't have to
  // manually swim through the whole solar system". Re-picks under the cursor rather than trusting
  // whatever's already selected, so a stray double-click on empty space (or on a body other than
  // the one currently selected) can't fire this using a stale target.
  canvas.addEventListener("dblclick", () => {
    if (!freeCamActive || transiting) return;
    const index = selectionUI.pickBodyIndexUnderCursor();
    if (index === null) return;
    selectionUI.setTarget(index);
    beginFreeCamZoomTo(solarSystem.bodies[index]);
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
    groundExitCooldownRemaining = 0.5;
  }

  // --- Free cam: toggled independently of orbit/ground mode. Entering captures whichever
  // camera is currently active's true world pose (no snap); exiting reframes the orbit
  // camera on the currently-focused body (a plain cut here is fine - this is "return to
  // normal control", not the cinematic interplanetary beat Tab gets).
  function toggleFreeCam() {
    if (!freeCamActive) {
      // "orbit" and "orbitEntity" both use orbitCamera - only "ground" uses groundCamera.
      const activeCamera = mode === "ground" ? groundCamera.camera : orbitCamera.camera;
      const worldPos = activeCamera.globalPosition.clone();
      const worldRot = new Quaternion();
      activeCamera.getWorldMatrix().decompose(undefined, worldRot, undefined);

      if (mode === "ground") groundCamera.detach();
      else orbitCamera.detach();

      freeFlyCamera.setPose(worldPos, worldRot);
      scene.activeCamera = freeFlyCamera.camera;
      freeFlyCamera.attach();
      freeCamActive = true;
      freeCamBadge.hidden = false;
      freeCamReticle.hidden = true; // cursor is free by default (see FreeFlyCamera) - reticle only matters while actively looking
      planeLockBadge.hidden = true;
    } else {
      freeFlyCamera.detach();
      freeCamActive = false;
      freeCamBadge.hidden = true;
      freeCamReticle.hidden = true;

      orbitCamera.trackWorldPosition(null);
      orbitCamera.camera.parent = focused.orbit.spinNode;
      orbitCamera.resetView(new Vector3(0, 0.35, 1));
      orbitCamera.setRadius(thresholds.defaultOrbit);
      scene.activeCamera = orbitCamera.camera;
      orbitCamera.attach();
      mode = "orbit";
      planeLockBadge.hidden = !orbitCamera.isPlaneLocked;
    }
  }

  // --- Free cam collision: a simple sphere collider just outside each body's (and the star's)
  // visual surface, so free cam can never fly through a planet - it slides along the surface
  // instead, same as any basic sphere-collision camera. Replaces the old automatic proximity
  // "catch" into orbit, which read as jarring/involuntary; committing to orbit or RTS view is
  // now always a deliberate action (enterOrbitFromFreeCam/jumpToRtsAtSpot below).
  const tmpCollisionDelta = new Vector3();

  function resolveFreeCamCollisions(): void {
    const pos = freeFlyCamera.camera.position; // unparented - position IS world position
    for (const body of solarSystem.bodies) {
      const bodyPos = body.orbit.spinNode.getAbsolutePosition();
      const minDist = body.radius * FREE_CAM_COLLIDER_FACTOR;
      tmpCollisionDelta.copyFrom(pos).subtractInPlace(bodyPos);
      const dist = tmpCollisionDelta.length();
      if (dist < minDist && dist > 1e-6) {
        tmpCollisionDelta.scaleInPlace(minDist / dist);
        pos.copyFrom(bodyPos).addInPlace(tmpCollisionDelta);
      }
    }
    const starMinDist = STAR_RADIUS * FREE_CAM_COLLIDER_FACTOR;
    const distToStar = pos.length();
    if (distToStar < starMinDist && distToStar > 1e-6) {
      pos.scaleInPlace(starMinDist / distToStar);
    }
  }

  /** Every body (plus the star) except the named ones, as detour obstacles for a camera blend -
   * see pathAvoidance.ts. Excludes whichever body/bodies the blend is actually entering/leaving,
   * since those are the deliberate start/end points, not something to route around. */
  function otherBodyObstacles(...excludeNames: string[]): PathObstacle[] {
    const obstacles: PathObstacle[] = solarSystem.bodies
      .filter((body) => !excludeNames.includes(body.def.name))
      .map((body) => ({ position: body.orbit.spinNode.getAbsolutePosition().clone(), radius: body.radius * FREE_CAM_COLLIDER_FACTOR }));
    obstacles.push({ position: Vector3.Zero(), radius: STAR_RADIUS * FREE_CAM_COLLIDER_FACTOR });
    return obstacles;
  }

  const tmpCatchDir = new Vector3();
  const tmpCatchFromRot = new Quaternion();

  /** Commits to orbit ("focus mode") around `target` from free cam - triggered by double-tapping
   * the "enterOrbit" keybinding (F by default) once a target is selected, rather than
   * automatically. Blends in smoothly from free cam's exact last pose (see
   * OrbitTrackballCamera.enterFromWorldPose) to a fixed FOCUS_MODE_ORBIT_RADIUS_FACTOR parking
   * distance - always the same regardless of how far free cam happened to be, not the current
   * (clamped) distance. */
  function enterOrbitFromFreeCam(target: (typeof solarSystem.bodies)[number]): void {
    const camPos = freeFlyCamera.camera.globalPosition.clone();
    const bodyPos = target.orbit.spinNode.getAbsolutePosition();
    const targetThresholds = radiusThresholds(target.radius);

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

    // Captured before detach() so the orbit camera can blend in continuously from exactly where
    // free cam left off, rather than jump-cutting to the computed orbit pose - see
    // enterFromWorldPose's own doc comment.
    tmpCatchFromRot.copyFrom(freeFlyCamera.camera.rotationQuaternion!);

    freeFlyCamera.detach();
    freeCamActive = false;
    freeCamBadge.hidden = true;
    freeCamReticle.hidden = true;

    orbitCamera.trackWorldPosition(null);
    orbitCamera.camera.parent = target.orbit.spinNode;
    orbitCamera.resetView(tmpLocalViewDir);
    const parkingRadius = target.radius * FOCUS_MODE_ORBIT_RADIUS_FACTOR;
    orbitCamera.setRadius(Math.min(targetThresholds.maxOrbit, Math.max(targetThresholds.minOrbit, parkingRadius)));
    orbitCamera.setRadiusLimits(targetThresholds.minOrbit, targetThresholds.maxOrbit);
    orbitCamera.enterFromWorldPose(camPos, tmpCatchFromRot, otherBodyObstacles(target.def.name));
    // Seeds camera.position/rotationQuaternion at the blend's t=0 start (exactly free cam's last
    // pose) immediately, rather than staying at their stale pre-free-cam values for one visible
    // frame until the next regular orbitCamera.update() call (which won't happen until next
    // tick, since this frame already took the freeCamActive branch for camera movement) -
    // subsequent frames' normal update() calls carry the blend the rest of the way in smoothly.
    orbitCamera.update(0);

    scene.activeCamera = orbitCamera.camera;
    orbitCamera.attach();
    mode = "orbit";
    // Free trackball by default ("WASD and mouse swipe both don't allow free rotation around
    // focused planet/moon/ship" - the previous Google-Earth-style plane-locked default only
    // allows yaw/pitch, no roll/tumble) - still toggleable with the lockPlane key (P) for anyone
    // who wants the constrained style instead.
    orbitCamera.setPlaneLocked(false);
    planeLockBadge.hidden = !orbitCamera.isPlaneLocked;

    if (target.landable && target.heightfield) {
      groundCamera.setHeightfield(target.heightfield);
      groundCamera.camera.parent = target.orbit.spinNode;
    }
  }

  /** Commits to orbit around a selected ship/asteroid from free cam - same trigger (double-tap F)
   * and entry-blend feel as enterOrbitFromFreeCam, but the target has no rotating "surface
   * frame" to parent to (a ship's own orientation changes during flip-and-burn; an asteroid has
   * no per-instance transform node at all), so this leaves the camera unparented and tracks the
   * entity's live world position each frame instead (see OrbitTrackballCamera.trackWorldPosition).
   * Doesn't touch `focused`/`thresholds` - terrain LOD and day/night stay locked to whatever
   * planet was last focused, since none of that applies to a ship/asteroid. */
  function enterOrbitEntityFromFreeCam(entity: SelectedEntity): void {
    const camPos = freeFlyCamera.camera.globalPosition.clone();
    const camRot = freeFlyCamera.camera.rotationQuaternion!.clone();

    freeFlyCamera.detach();
    freeCamActive = false;
    freeCamBadge.hidden = true;
    freeCamReticle.hidden = true;
    planeLockBadge.hidden = true; // plane-lock doesn't apply to entity-orbit
    orbitCamera.setPlaneLocked(false); // defensive - don't inherit a stale true from a prior planet-orbit session

    orbitCamera.camera.parent = null;
    orbitCamera.trackWorldPosition(entity.getWorldPosition);
    orbitCamera.setRadiusLimits(ENTITY_ORBIT_MIN_RADIUS, ENTITY_ORBIT_MAX_RADIUS);
    orbitCamera.setRadius(ENTITY_ORBIT_DEFAULT_RADIUS);
    orbitCamera.resetView(new Vector3(0, 0.35, 1)); // arbitrary reasonable starting angle, same default used elsewhere
    orbitCamera.enterFromWorldPose(camPos, camRot, otherBodyObstacles());
    orbitCamera.update(0); // seed position/rotation at the blend's t=0 start immediately - see enterOrbitFromFreeCam's own comment

    scene.activeCamera = orbitCamera.camera;
    orbitCamera.attach();
    mode = "orbitEntity";
  }

  /** The other, faster way to commit from free cam: toggle cursor mode on to click a specific
   * surface spot, then press Space to fly straight into RTS ground view anchored right there,
   * skipping orbit mode entirely. RtsGroundCamera's own entry blend is distance-scaled (see its
   * ENTRY_BLEND_MIN/MAX_SECONDS), so this reads as a continuous flight even from far away. */
  function jumpToRtsAtSpot(target: (typeof solarSystem.bodies)[number], localDir: Vector3): void {
    if (!target.landable || !target.heightfield) return;
    const targetThresholds = radiusThresholds(target.radius);

    const fromPos = freeFlyCamera.camera.globalPosition.clone();
    const fromRot = freeFlyCamera.camera.rotationQuaternion!.clone();

    solarSystem.focusedIndex = solarSystem.bodies.indexOf(target);
    focused = target;
    thresholds = targetThresholds;

    freeFlyCamera.detach();
    freeCamActive = false;
    freeCamBadge.hidden = true;
    freeCamReticle.hidden = true;
    planeLockBadge.hidden = true;

    groundCamera.setHeightfield(target.heightfield);
    groundCamera.camera.parent = target.orbit.spinNode;
    groundCamera.setAnchorFromWorldPoint(localDir);

    // Defensively reparent/re-range the orbit camera too, even though it stays invisible for
    // this whole jump, so exitToOrbitMode (scrolling/Escape back out of ground mode later) lands
    // somewhere sane instead of still referencing whatever body was focused before this jump.
    orbitCamera.trackWorldPosition(null);
    orbitCamera.camera.parent = target.orbit.spinNode;
    orbitCamera.setRadiusLimits(targetThresholds.minOrbit, targetThresholds.maxOrbit);
    orbitCamera.setRadius(targetThresholds.defaultOrbit);

    scene.activeCamera = groundCamera.camera;
    groundCamera.attach(fromPos, fromRot, otherBodyObstacles(target.def.name));
    mode = "ground";
  }

  // --- Interplanetary transit: continuous world-space flight (lerp position, slerp
  // rotation) from wherever the camera currently is toward a live-tracked, continuously
  // updated framing of the target (it keeps orbiting during the flight), reparenting only
  // once arrived - so there's no snap/pop at any point, and the camera keeps roughly the
  // same relative viewing angle throughout ("makes sense from the camera's perspective").
  let transiting = false;
  /** True for a transit started by beginFreeCamZoomTo (double-click a planet in free cam) - the
   * moving camera is freeFlyCamera instead of orbitCamera, and it lands back in free cam
   * (completeFreeCamZoom) rather than orbit mode (completeTransit). Irrelevant while
   * transitArrivalMode is "away" (beginFreeCamZoomAway always moves orbitCamera.camera, then
   * hands off to freeFlyCamera only once arrived - see its own comment). */
  let transitFreeCamMode = false;
  /** "orbitBody": arrival keeps tracking a live body position/orientation, recomputed fresh
   * every frame in updateTransit (beginTransit, beginFreeCamZoomTo). "away": a fixed arrival
   * pose computed once at begin (beginFreeCamZoomAway) - backing out along a fixed radial line
   * into open space has no body to track. */
  let transitArrivalMode: "orbitBody" | "away" = "orbitBody";
  let transitElapsed = 0;
  let transitTargetIndex = -1;
  const transitFromPos = new Vector3();
  const transitFromRot = new Quaternion();
  const transitApproachDir = new Vector3();
  const transitAwayArrivalPos = new Vector3();
  const transitAwayArrivalRot = new Quaternion();
  const tmpArrivalPos = new Vector3();
  const tmpArrivalRot = new Quaternion();
  const tmpArrivalForward = new Vector3();
  const tmpInvMatrix = new Matrix();
  const tmpLocalViewDir = new Vector3();
  const tmpLocalUp = new Vector3();
  const tmpFreeCamLocalPos = new Vector3();
  const tmpTransitDustMatrix = new Matrix();
  const tmpTransitDustDir = new Vector3();
  let transitControlPoint: Vector3 | null = null;
  const tmpDepartureSunDir = new Vector3();
  const tmpDestinationSunDir = new Vector3();
  /** Set by updateTransit each frame (orbitBody arrival only) to the sun direction blended
   * between the departure and destination bodies at the same eased progress as the camera
   * blend, and read by the render loop's lighting dispatch instead of snapping straight to the
   * destination - without this, the sun direction update in main.ts's transiting branch snaps to
   * the destination body's angle the INSTANT the flight begins, so the target planet's lit
   * hemisphere pops to a different angle over a single frame ("why does the planet light up when
   * double clicked?"). Approximated as lerp+renormalize rather than a true spherical
   * interpolation - visually indistinguishable for the angle differences involved here, and
   * cheaper. */
  let transitSunDirOverride: Vector3 | null = null;
  /** Set once at transit start (beginTransit/beginFreeCamZoomTo) - the "orbitBody" arrival
   * radius, recomputed live around the target's current position every frame in updateTransit.
   * Kept as a plain radius (not a factor) since it's cheaper to precompute once than to re-derive
   * per frame, and lets the two entry points park at different distances: beginTransit (old
   * interplanetary Tab/Space) keeps radiusThresholds' defaultOrbit, while beginFreeCamZoomTo uses
   * FOCUS_MODE_ORBIT_RADIUS_FACTOR so double-click and double-tap-F park at the same distance. */
  let transitArrivalRadius = 0;

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
    transitArrivalMode = "orbitBody";
    transitFreeCamMode = false;

    // Computed once up front (not lazily like the other two blend systems) since transit's
    // duration is always the same fixed TRANSIT_DURATION_SECONDS regardless of distance, so
    // there's no need to wait for a first update() frame - an initial estimate of the arrival
    // point (the target's current position, ignoring its own slow drift during the flight) is
    // already good enough to route around anything genuinely in the way.
    const target = solarSystem.bodies[targetIndex];
    const targetThresholds = radiusThresholds(target.radius);
    transitArrivalRadius = targetThresholds.defaultOrbit;
    const estimatedArrivalPos = target.orbit.spinNode.getAbsolutePosition().add(transitApproachDir.scale(transitArrivalRadius));
    transitControlPoint = computeDetourControlPoint(transitFromPos, estimatedArrivalPos, otherBodyObstacles(focused.def.name, target.def.name));

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

    let target: (typeof solarSystem.bodies)[number] | null = null;
    let targetThresholds: RadiusThresholds | null = null;

    if (transitArrivalMode === "away") {
      tmpArrivalPos.copyFrom(transitAwayArrivalPos);
      tmpArrivalRot.copyFrom(transitAwayArrivalRot);
      transitSunDirOverride = null; // no destination body to blend toward - focused hasn't changed
    } else {
      target = solarSystem.bodies[transitTargetIndex];
      targetThresholds = radiusThresholds(target.radius);
      const targetWorldPos = target.orbit.spinNode.getAbsolutePosition();
      tmpArrivalPos.copyFrom(targetWorldPos).addInPlace(transitApproachDir.scale(transitArrivalRadius));
      // Camera arrives on the near side (along transitApproachDir from the target) looking back
      // toward it, i.e. forward is the opposite direction - see lookRotation.ts for why this
      // goes through computeLookRotationToRef rather than Babylon's own FromLookDirectionLHToRef.
      tmpArrivalForward.copyFrom(transitApproachDir).scaleInPlace(-1);
      computeLookRotationToRef(tmpArrivalForward, Vector3.Up(), tmpArrivalRot);

      // Smoothly blend the sun direction from the departure body's angle to the destination's,
      // at the same eased progress as everything else - see transitSunDirOverride's own comment.
      focused.orbit.sunDirectionTo(Vector3.Zero(), tmpDepartureSunDir);
      target.orbit.sunDirectionTo(Vector3.Zero(), tmpDestinationSunDir);
      Vector3.LerpToRef(tmpDepartureSunDir, tmpDestinationSunDir, eased, tmpDestinationSunDir);
      tmpDestinationSunDir.normalize();
      transitSunDirOverride = tmpDestinationSunDir;
    }

    // beginFreeCamZoomAway always moves orbitCamera.camera (whichever camera was active for
    // "orbit"/"orbitEntity" mode) throughout the flight, only handing off to freeFlyCamera once
    // arrived (see completeZoomAway) - so transitFreeCamMode (which only applies to the
    // orbitBody case) is irrelevant here.
    const camera = transitArrivalMode === "away" ? orbitCamera.camera : transitFreeCamMode ? freeFlyCamera.camera : orbitCamera.camera;
    evaluateDetourPath(transitFromPos, transitControlPoint!, tmpArrivalPos, eased, camera.position);
    Quaternion.SlerpToRef(transitFromRot, tmpArrivalRot, eased, camera.rotationQuaternion!);

    if (t >= 1) {
      if (transitArrivalMode === "away") completeZoomAway();
      else completeTransit(target!, targetThresholds!);
    }
  }

  /** Double-click-to-zoom from free cam: same warp feel as beginTransit (lerp/slerp flight,
   * stellar dust, path-avoidance detour), but the moving camera is freeFlyCamera itself, and it
   * now lands in focus/orbit mode around the target (completeTransit) instead of free cam -
   * "when double click flight to planet ends; automatically focus on planet" - so "I don't have
   * to manually swim through the whole solar system" AND arrive already oriented/parked on it,
   * rather than needing a separate double-tap-F afterward. */
  function beginFreeCamZoomTo(target: (typeof solarSystem.bodies)[number]): void {
    if (!freeCamActive || transiting) return;

    const camera = freeFlyCamera.camera;
    transitFromPos.copyFrom(camera.globalPosition);
    transitFromRot.copyFrom(camera.rotationQuaternion!);

    const targetPos = target.orbit.spinNode.getAbsolutePosition();
    transitApproachDir.copyFrom(transitFromPos).subtractInPlace(targetPos).normalize();

    freeFlyCamera.detach(); // stop WASD/mouselook fighting the automated flight
    camera.parent = null;
    camera.position.copyFrom(transitFromPos);
    camera.rotationQuaternion!.copyFrom(transitFromRot);

    transitTargetIndex = solarSystem.bodies.indexOf(target);
    transitElapsed = 0;
    transiting = true;
    transitFreeCamMode = true;
    transitArrivalMode = "orbitBody";
    // Parks at the same fixed "focus mode" distance double-tapping F does (see
    // enterOrbitFromFreeCam), not radiusThresholds' defaultOrbit - double-click and double-tap-F
    // both mean "commit to focus mode", so they should land at the same distance.
    transitArrivalRadius = target.radius * FOCUS_MODE_ORBIT_RADIUS_FACTOR;

    const estimatedArrivalPos = targetPos.add(transitApproachDir.scale(transitArrivalRadius));
    transitControlPoint = computeDetourControlPoint(transitFromPos, estimatedArrivalPos, otherBodyObstacles(target.def.name));

    Vector3.TransformNormalToRef(Vector3.Forward(), Matrix.FromQuaternionToRef(transitFromRot, tmpTransitDustMatrix), tmpTransitDustDir);
    stellarDust.start(tmpTransitDustDir);
  }

  /** ESC-triggered exit from orbit/orbitEntity ("focus mode") back to free cam: instead of an
   * instant cut, backs the camera straight out along the same radial line it's already on (away
   * from whatever was being orbited) into open space, then hands off to free cam - the reverse
   * of beginFreeCamZoomTo's "swim in" ("when escape detaching from a planet and flying away lock
   * all input"). Doesn't touch focused/thresholds - same as the old instant-cut toggleFreeCam()
   * path, terrain LOD just keeps using whatever was last focused. */
  function beginFreeCamZoomAway(): void {
    if (freeCamActive || transiting) return;

    // Captured before clearSelection() below wipes selectedEntity - orbitEntity mode has no
    // "focused" body of its own (focused stays whatever planet was last focused, unrelated to
    // the orbited ship/asteroid - see enterOrbitEntityFromFreeCam's own comment).
    const centerPos =
      mode === "orbitEntity" && selectionUI.selectedEntity
        ? selectionUI.selectedEntity.getWorldPosition().clone()
        : focused.orbit.spinNode.getAbsolutePosition().clone();

    selectionUI.clearSelection();
    orbitCamera.trackWorldPosition(null); // no-op if not currently tracking an entity - harmless

    const camera = orbitCamera.camera; // only ever called from "orbit"/"orbitEntity", both use orbitCamera
    transitFromPos.copyFrom(camera.globalPosition);
    const worldMatrix = camera.getWorldMatrix();
    worldMatrix.decompose(undefined, transitFromRot, undefined);

    transitApproachDir.copyFrom(transitFromPos).subtractInPlace(centerPos).normalize();
    const awayDist = mode === "orbitEntity" ? ENTITY_ORBIT_MAX_RADIUS * 1.5 : thresholds.maxOrbit * 1.5;
    transitAwayArrivalPos.copyFrom(centerPos).addInPlace(transitApproachDir.scale(awayDist));
    tmpArrivalForward.copyFrom(transitApproachDir).scaleInPlace(-1);
    computeLookRotationToRef(tmpArrivalForward, Vector3.Up(), transitAwayArrivalRot);

    orbitCamera.detach();
    camera.parent = null;
    camera.position.copyFrom(transitFromPos);
    camera.rotationQuaternion!.copyFrom(transitFromRot);

    transitElapsed = 0;
    transiting = true;
    transitArrivalMode = "away";

    const obstacles = mode === "orbitEntity" ? otherBodyObstacles() : otherBodyObstacles(focused.def.name);
    transitControlPoint = computeDetourControlPoint(transitFromPos, transitAwayArrivalPos, obstacles);

    Vector3.TransformNormalToRef(Vector3.Forward(), Matrix.FromQuaternionToRef(transitFromRot, tmpTransitDustMatrix), tmpTransitDustDir);
    stellarDust.start(tmpTransitDustDir);
  }

  function completeZoomAway(): void {
    freeFlyCamera.setPose(transitAwayArrivalPos, transitAwayArrivalRot);
    scene.activeCamera = freeFlyCamera.camera;
    freeFlyCamera.attach();
    freeCamActive = true;
    freeCamBadge.hidden = false;
    freeCamReticle.hidden = true;
    planeLockBadge.hidden = true;

    transiting = false;
    transitArrivalMode = "orbitBody";
    stellarDust.stop();
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

    // Only meaningful when this transit started from free cam (beginFreeCamZoomTo) - harmless
    // no-ops for the old orbit-to-orbit interplanetary beginTransit, which never set these.
    freeFlyCamera.detach();
    freeCamActive = false;
    freeCamBadge.hidden = true;
    freeCamReticle.hidden = true;

    orbitCamera.trackWorldPosition(null);
    orbitCamera.resetInertia(); // this session doesn't go through enterFromWorldPose's own blend (which resets this itself) - see resetInertia's own comment
    orbitCamera.camera.parent = target.orbit.spinNode;
    orbitCamera.setViewDirFromWorldPoint(tmpLocalViewDir);
    orbitCamera.up.copyFrom(tmpLocalUp);
    orbitCamera.setRadius(Math.min(thresholds.maxOrbit, Math.max(thresholds.minOrbit, transitArrivalRadius)));
    orbitCamera.setRadiusLimits(thresholds.minOrbit, thresholds.maxOrbit);

    if (target.landable && target.heightfield) {
      groundCamera.setHeightfield(target.heightfield);
      groundCamera.camera.parent = target.orbit.spinNode;
    }

    // beginFreeCamZoomTo's flight renders from freeFlyCamera.camera (scene.activeCamera was never
    // reassigned here before) - without this, orbitCamera.camera gets parented/posed correctly
    // above but the scene keeps drawing the now-frozen free-fly camera forever, which is exactly
    // what "it locks on then you're stuck facing one way and the planet just moves and spins off
    // screen" looked like: the real orbit camera was tracking Venus perfectly the whole time, it
    // just was never the one being rendered from.
    scene.activeCamera = orbitCamera.camera;
    orbitCamera.attach();
    mode = "orbit";
    // Free trackball by default - see enterOrbitFromFreeCam's own comment.
    orbitCamera.setPlaneLocked(false);
    planeLockBadge.hidden = !orbitCamera.isPlaneLocked;
    transiting = false;
    stellarDust.stop();
  }

  // orbitCamera.attach() alone never actually computes camera.position/rotationQuaternion (only
  // update() does, from viewDir/radius) - without this, toggleFreeCam() below captures the
  // camera's raw construction-time default (world origin, identity rotation, i.e. sitting at the
  // star facing an arbitrary direction) instead of its real orbit pose around Earth, since no
  // render/update tick has happened yet at this point in startup.
  orbitCamera.update(0);
  // Camera.globalPosition is a CACHED field that Babylon only refreshes as a side effect of
  // computing the view matrix (normally once per rendered frame) - camera.position alone
  // (just set correctly above) isn't enough. Since engine.runRenderLoop hasn't started yet at
  // this point in boot, globalPosition would otherwise still read its construction-time default
  // (world origin) despite position now being correct - forcing the view matrix here flushes it.
  orbitCamera.camera.getViewMatrix(true);

  // Boots straight into free cam, reusing toggleFreeCam's own "on" branch (which captures
  // whichever camera is currently active's pose) rather than duplicating that logic -
  // orbitCamera now has its normal default pose established (see the update(0) call just
  // above), so this just carries that straight over into free cam's starting position.
  toggleFreeCam();

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    if (groundExitCooldownRemaining > 0) groundExitCooldownRemaining -= dt;

    // Advanced unconditionally, regardless of mode - SolarSystem.update reads orbitalScale.blend
    // every frame to drive each body's current orbital distance, so this needs to keep animating
    // even while, say, in ground mode looking at just one planet's surface.
    if (orbitalScaleTogglePressed) orbitalScale.toggle();
    orbitalScaleTogglePressed = false;
    orbitalScale.update(dt);
    orbitalScaleBadge.hidden = !orbitalScale.isActualTarget;

    // Transit-specific camera movement has to run before solarSystem.update below (it computes
    // transitSunDirOverride, which that call reads) - every OTHER camera update
    // (orbitCamera/freeFlyCamera/groundCamera) runs AFTER solarSystem.update instead, so it reads
    // this frame's fresh spinNode transform (orbit translation + axial spin) rather than last
    // frame's - a body-parented camera should always be positioned/oriented off the same frame's
    // transform it's about to be rendered with.
    if (transiting) {
      // Checked before freeCamActive: beginFreeCamZoomTo starts a transit without turning
      // freeCamActive off (still conceptually "in free cam", just autopiloting), so this must
      // win the dispatch or freeFlyCamera.update() would fight the transit's own lerp/slerp.
      updateTransit(dt);
    }

    if (transiting) {
      // Keep every body's orbit/spin advancing during transit (including the live target),
      // but skip terrain LOD work - camera position isn't meaningful in any body's local
      // frame while it's unparented mid-flight. Lights using the smoothly-blended direction
      // updateTransit just computed (see transitSunDirOverride's own comment) - "away" flights
      // have no destination body to blend toward, so focused (unchanged) is already right.
      solarSystem.update(dt, Vector3.Zero(), sun, transitSunDirOverride ?? undefined);
    } else if (freeCamActive || mode === "orbitEntity") {
      // Both free cam and orbitEntity (tracking a moving ship/asteroid) are unparented/world-
      // space, so the focused body's terrain still needs its camera position converted into
      // that body's local frame - otherwise LOD freezes at whatever level it was when this mode
      // started, making nearby terrain look permanently low-res no matter how close the camera
      // actually gets. Reads last frame's camera position (this frame's update runs just below) -
      // a one-frame-stale LOD input is imperceptible, unlike a stale camera pose/rotation.
      const camPos = freeCamActive ? freeFlyCamera.camera.globalPosition : orbitCamera.camera.globalPosition;
      focused.orbit.spinNode.getWorldMatrix().invertToRef(tmpInvMatrix);
      Vector3.TransformCoordinatesToRef(camPos, tmpInvMatrix, tmpFreeCamLocalPos);
      solarSystem.update(dt, tmpFreeCamLocalPos, sun);
    } else {
      const focusedCameraLocalPosition = mode === "orbit" ? orbitCamera.camera.position : groundCamera.camera.position;
      solarSystem.update(dt, focusedCameraLocalPosition, sun);
    }

    if (!transiting) {
      if (freeCamActive) {
        freeFlyCamera.update(dt);
        resolveFreeCamCollisions();
      } else if (mode === "ground") {
        groundCamera.update(dt, focused.radius);
      } else {
        orbitCamera.update(dt); // "orbit" and "orbitEntity" both use orbitCamera
      }
    }

    // HemisphericLight's own direction is fixed at construction (world +Y) while the actual sun
    // (a DirectionalLight) rotates every frame with whatever body is focused - left unsynced,
    // the ambient "night floor" only ever applies to the arbitrary half of a sphere facing away
    // from world +Y, not the half actually facing away from the sun, so as a body spins the true
    // night side drifts in and out of the adjustable floor rather than being consistently dim.
    // HemisphericLight's direction is a REFLECTION direction (surfaces facing toward it get the
    // bright side), while DirectionalLight's direction is the direction rays TRAVEL - negating
    // it points at the sun's actual source direction, keeping the two consistent every frame.
    ambient.direction.copyFrom(sun.direction).scaleInPlace(-1);

    if (freeCamTogglePressed) toggleFreeCam();
    freeCamTogglePressed = false;

    if (enterOrbitPressed && freeCamActive && !transiting) {
      if (selectionUI.targetIndex !== null) {
        enterOrbitFromFreeCam(solarSystem.bodies[selectionUI.targetIndex]);
      } else if (selectionUI.selectedEntity !== null) {
        enterOrbitEntityFromFreeCam(selectionUI.selectedEntity);
      }
    }
    enterOrbitPressed = false;

    // Consumed regardless of mode (not just !freeCamActive) - previously this was nested inside
    // the !freeCamActive block below, so pressing reorient's key in free cam left reorientPressed
    // stuck true (never reset) until free cam turned off, at which point it fired late/out of context.
    if (reorientPressed && !transiting) {
      if (freeCamActive) freeFlyCamera.reorient();
      else if (mode !== "ground") orbitCamera.reorient(); // "orbit" and "orbitEntity" both use orbitCamera
    }
    reorientPressed = false;

    if (!freeCamActive) {
      if (!transiting && lockPlaneTogglePressed && mode === "orbit") {
        orbitCamera.setPlaneLocked(!orbitCamera.isPlaneLocked);
        planeLockBadge.hidden = !orbitCamera.isPlaneLocked;
      }
      lockPlaneTogglePressed = false;

      if (!transiting && travelPressed) beginTransit();
      travelPressed = false;

      if (!transiting) {
        if (mode === "orbit") {
          if (escapePressed) {
            // Disengage "Focus mode": back out along the same radial line into open space
            // ("when escape detaching from a planet and flying away lock all input" - see
            // beginFreeCamZoomAway), the same "back out one level" meaning ESC already has in
            // ground mode below, just one level further out.
            beginFreeCamZoomAway();
          } else if (orbitCamera.requestExitToFreeCam) {
            // Zoomed out past maxRadius while already there - release back to free cam, the
            // opposite end of the "swim through the system" continuum from enterGroundMode below.
            // An instant cut is fine here (unlike ESC) - the camera's already drifting outward
            // under continuous user-driven zoom, not a sudden context switch.
            toggleFreeCam();
          } else if (
            // No !orbitCamera.isFlying guard here - now that scroll zoom flows through the same
            // flyToRadius lerp as exitToOrbitMode's cinematic fly-up, "isFlying" no longer means
            // "just exited ground mode" on its own. groundExitCooldownRemaining (set only by
            // exitToOrbitMode) is the actual, narrowly-targeted guard against bouncing straight
            // back into ground mode mid fly-up; ordinary scroll-in should enter ground mode
            // promptly the moment the interpolating radius crosses below threshold, mid-lerp or not.
            RTS_MODE_ENABLED &&
            focused.landable &&
            groundExitCooldownRemaining <= 0 &&
            orbitCamera.radius < thresholds.enterGround
          ) {
            enterGroundMode();
          }
        } else if (mode === "orbitEntity") {
          if (escapePressed) {
            // Same "back out to free cam" meaning as orbit mode's own ESC above - ships/asteroids
            // have no ground mode to narrow into, so this is the only way out.
            beginFreeCamZoomAway();
          } else if (orbitCamera.requestExitToFreeCam) {
            selectionUI.clearSelection();
            orbitCamera.trackWorldPosition(null);
            toggleFreeCam();
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
    selectionUI.updateHoverLabel();
    bodyIconsUI.update();
    economyManager.update(dt, scene.activeCamera!.globalPosition);
    examineUI.update();

    devStats.hidden = !graphicsSettings.developerMode;
    if (graphicsSettings.developerMode) {
      const camPos = scene.activeCamera!.globalPosition;
      const distanceFromFocused = Vector3.Distance(camPos, focused.orbit.spinNode.getAbsolutePosition());
      const cameraMode = freeCamActive ? (freeFlyCamera.isCursorModeActive ? "free (cursor)" : "free (looking)") : transiting ? "transiting" : mode;
      devStats.textContent =
        `FPS: ${engine.getFps().toFixed(0)}\n` +
        `Mode: ${cameraMode}\n` +
        `Focused: ${focused.def.name}\n` +
        (mode === "orbitEntity" ? `Orbiting: ${selectionUI.selectedEntity?.name ?? "-"}\n` : "") +
        `Dist from focused: ${distanceFromFocused.toFixed(0)}\n` +
        `Orbit radius: ${mode !== "ground" ? orbitCamera.radius.toFixed(0) : "-"}\n` +
        `Ground eye height: ${mode === "ground" ? groundCamera.eyeHeight.toFixed(0) : "-"}\n` +
        `Ships: ${economyManager.getExamineInfo().filter((e) => e.kind === "Ship").length}`;
    }

    const b = graphicsSettings.nightBrightness;
    ambient.groundColor.set(b, b, b * 1.4);

    // Cheap enough (a couple dozen meshes) to just re-apply unconditionally every frame, same
    // pattern as nightBrightness above, rather than tracking a "did this setting just change"
    // flag - setEnabled() with the same value it already has is a no-op either way.
    solarSystem.setOrbitLinesVisible(graphicsSettings.showOrbitLines);
    economyManager.setShipTrajectoriesVisible(graphicsSettings.showShipTrajectories);

    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
