import { Color4, DynamicTexture, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";

/**
 * Streaking dust particles during interplanetary transit (Tab travel) - a "moving through
 * space" cue for the otherwise fairly static-feeling multi-second flight. Particles emit from
 * (and track, since `emitter` is the actual live Vector3 the transit code animates every
 * frame - not a snapshot) the traveling camera's position, stretched along their velocity via
 * Babylon's BILLBOARDMODE_STRETCHED so they read as motion streaks rather than round dots.
 */
export class StellarDust {
  private readonly particleSystem: ParticleSystem;

  constructor(scene: Scene, emitterPosition: Vector3) {
    const size = 32;
    const texture = new DynamicTexture("stellarDustTexture", size, scene, false);
    texture.hasAlpha = true;
    const ctx = texture.getContext();
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(220,230,255,0.7)");
    gradient.addColorStop(1, "rgba(200,220,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    texture.update(false);

    const ps = new ParticleSystem("stellarDust", 500, scene);
    ps.particleTexture = texture;
    ps.emitter = emitterPosition;
    // This scene's units run into the thousands/tens-of-thousands (planet radii ~2000+,
    // distances ~28000+) - a "normal" particle size of a few units would be imperceptibly
    // tiny even right next to the camera, so both the spawn volume and particle size are
    // scaled way up to actually read on screen at this scale.
    ps.minEmitBox = new Vector3(-400, -400, -400);
    ps.maxEmitBox = new Vector3(400, 400, 400);
    ps.color1 = new Color4(0.85, 0.9, 1, 1);
    ps.color2 = new Color4(1, 1, 1, 1);
    ps.colorDead = new Color4(0.7, 0.8, 1, 0);
    ps.minSize = 40;
    ps.maxSize = 90;
    ps.minLifeTime = 0.4;
    ps.maxLifeTime = 0.8;
    ps.minEmitPower = 2500;
    ps.maxEmitPower = 4000;
    ps.updateSpeed = 0.02;
    ps.emitRate = 0;
    ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.disposeOnStop = false;
    this.particleSystem = ps;
  }

  /** Starts streaming, with particles rushing past in the direction opposite `travelDirection`
   * (world space) - i.e. backward relative to travel, like passing stars during warp. */
  start(travelDirection: Vector3): void {
    const back = travelDirection.scale(-1);
    this.particleSystem.direction1 = back;
    this.particleSystem.direction2 = back;
    this.particleSystem.emitRate = 350;
    if (!this.particleSystem.isStarted()) this.particleSystem.start();
  }

  stop(): void {
    this.particleSystem.emitRate = 0;
    this.particleSystem.stop();
  }
}
