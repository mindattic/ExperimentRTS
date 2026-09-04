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
  MeshBuilder,
  StandardMaterial,
} from "@babylonjs/core";
import { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";

import { PLANET_RADIUS } from "./config";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

async function main() {
  const engine: AbstractEngine = await EngineFactory.CreateAsync(canvas, {});
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.01, 0.01, 0.02, 1);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.8, 0.3), scene);
  sun.intensity = 1.1;
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.15;

  const planet = MeshBuilder.CreateSphere("planet", { diameter: PLANET_RADIUS * 2, segments: 64 }, scene);
  const planetMaterial = new StandardMaterial("planetMaterial", scene);
  planetMaterial.diffuseColor = new Color3(0.76, 0.62, 0.42);
  planetMaterial.specularColor = Color3.Black();
  planet.material = planetMaterial;

  const camera = new GeospatialCamera("geoCamera", scene, { planetRadius: PLANET_RADIUS });
  camera.limits.radiusMin = PLANET_RADIUS * 1.05;
  camera.limits.radiusMax = PLANET_RADIUS * 8;
  camera.radius = PLANET_RADIUS * 3.5;
  camera.pitch = 0.6;
  scene.activeCamera = camera;
  camera.attachControl(true);

  engine.runRenderLoop(() => {
    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

void main();
