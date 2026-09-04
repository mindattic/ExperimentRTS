import "./style.css";

import { EngineFactory, type AbstractEngine, Scene, Vector3, Color4, HemisphericLight, DirectionalLight } from "@babylonjs/core";
import { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";

import { PLANET_RADIUS, PLANET_SEED } from "./config";
import { PlanetTerrain } from "./terrain/planetTerrain";
import { RtsGroundCamera } from "./camera/rtsGroundCamera";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

/** Orbit radius below which we hand off to the fixed RTS ground camera. */
const ENTER_GROUND_RADIUS = PLANET_RADIUS * 1.06;
/**
 * Radius the orbit camera flies back out to when leaving ground mode. Kept comfortably above
 * ENTER_GROUND_RADIUS: the fly-back animates radius upward through that threshold, so without
 * this margin (and the `flying` guard below) the orbit-mode entry check would immediately
 * re-trigger ground mode mid-animation.
 */
const EXIT_ORBIT_RADIUS = PLANET_RADIUS * 1.25;

async function main() {
  const engine: AbstractEngine = await EngineFactory.CreateAsync(canvas, {});
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.01, 0.01, 0.02, 1);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.8, 0.3), scene);
  sun.intensity = 1.1;
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.15;

  const terrain = new PlanetTerrain(scene, PLANET_RADIUS, PLANET_SEED);

  const orbitCamera = new GeospatialCamera("geoCamera", scene, { planetRadius: PLANET_RADIUS });
  orbitCamera.limits.radiusMin = PLANET_RADIUS * 1.02;
  orbitCamera.limits.radiusMax = PLANET_RADIUS * 8;
  orbitCamera.radius = PLANET_RADIUS * 3.5;
  orbitCamera.pitch = 0.6;
  scene.activeCamera = orbitCamera;
  orbitCamera.attachControl(true);

  const groundCamera = new RtsGroundCamera(scene, canvas, terrain.heightfield);

  let mode: "orbit" | "ground" = "orbit";
  let flyingToOrbit = false;
  let escapePressed = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") escapePressed = true;
  });

  function enterGroundMode() {
    groundCamera.setAnchorFromWorldPoint(orbitCamera.center);
    orbitCamera.detachControl();
    scene.activeCamera = groundCamera.camera;
    groundCamera.attach();
    mode = "ground";
  }

  function exitToOrbitMode() {
    groundCamera.detach();
    // Any zoom momentum from the wheel scroll that carried us into ground mode is still
    // queued on the orbit camera (it only decays while the camera is actively rendered, so
    // it froze the moment we switched away) - without resetting it here it resumes the
    // instant we reattach, yanking the radius away from where we're about to fly it to.
    orbitCamera.movement.resetZoomVelocity();
    scene.activeCamera = orbitCamera;
    orbitCamera.attachControl(true);
    mode = "orbit";
    flyingToOrbit = true;
    // flyToAsync (rather than poking yaw/pitch/radius/center directly) explicitly targets
    // every orientation property, so it self-corrects any stale state left over from ground
    // mode instead of fighting it - and it doubles as the blended handoff back to orbit.
    void orbitCamera.flyToAsync(0, 0.6, EXIT_ORBIT_RADIUS, groundCamera.anchor.scale(PLANET_RADIUS), 600).then(() => {
      flyingToOrbit = false;
    });
  }

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;

    if (mode === "orbit") {
      terrain.update(orbitCamera.globalPosition);
      if (!flyingToOrbit && orbitCamera.radius < ENTER_GROUND_RADIUS) {
        enterGroundMode();
      }
    } else {
      groundCamera.update(dt, PLANET_RADIUS);
      terrain.update(groundCamera.camera.globalPosition);
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
