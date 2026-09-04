import "./style.css";

import { EngineFactory, type AbstractEngine, Scene, Vector3, Color4, HemisphericLight, DirectionalLight } from "@babylonjs/core";
import { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";

import { PLANET_RADIUS, PLANET_SEED } from "./config";
import { PlanetTerrain } from "./terrain/planetTerrain";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

async function main() {
  const engine: AbstractEngine = await EngineFactory.CreateAsync(canvas, {});
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.01, 0.01, 0.02, 1);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.8, 0.3), scene);
  sun.intensity = 1.1;
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.15;

  const terrain = new PlanetTerrain(scene, PLANET_RADIUS, PLANET_SEED);

  const camera = new GeospatialCamera("geoCamera", scene, { planetRadius: PLANET_RADIUS });
  camera.limits.radiusMin = PLANET_RADIUS * 1.15;
  camera.limits.radiusMax = PLANET_RADIUS * 8;
  camera.radius = PLANET_RADIUS * 3.5;
  camera.pitch = 0.6;
  scene.activeCamera = camera;
  camera.attachControl(true);

  engine.runRenderLoop(() => {
    terrain.update(camera.globalPosition);
    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
