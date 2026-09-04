export type Action =
  | "orbitYawLeft"
  | "orbitYawRight"
  | "orbitPitchUp"
  | "orbitPitchDown"
  | "groundForward"
  | "groundBackward"
  | "groundLeft"
  | "groundRight"
  | "groundRotateLeft"
  | "groundRotateRight"
  | "reorient"
  | "freeCam"
  | "lockPlane"
  | "focusMenu"
  | "travel"
  | "exitGround";

export const ACTION_LABELS: Record<Action, string> = {
  orbitYawLeft: "Orbit: yaw left",
  orbitYawRight: "Orbit: yaw right",
  orbitPitchUp: "Orbit: pitch up",
  orbitPitchDown: "Orbit: pitch down",
  groundForward: "Ground: forward",
  groundBackward: "Ground: backward",
  groundLeft: "Ground: strafe left",
  groundRight: "Ground: strafe right",
  groundRotateLeft: "Ground: rotate left",
  groundRotateRight: "Ground: rotate right",
  reorient: "Reorient camera",
  freeCam: "Toggle free cam",
  lockPlane: "Lock orbit to solar plane",
  focusMenu: "Open focus list",
  travel: "Plot course (travel)",
  exitGround: "Exit ground mode",
};

const DEFAULTS: Record<Action, string> = {
  orbitYawLeft: "KeyA",
  orbitYawRight: "KeyD",
  orbitPitchUp: "KeyW",
  orbitPitchDown: "KeyS",
  groundForward: "KeyW",
  groundBackward: "KeyS",
  groundLeft: "KeyA",
  groundRight: "KeyD",
  groundRotateLeft: "KeyQ",
  groundRotateRight: "KeyE",
  reorient: "KeyR",
  freeCam: "KeyF",
  lockPlane: "KeyP",
  focusMenu: "Digit1",
  travel: "Tab",
  exitGround: "Escape",
};

const STORAGE_KEY = "experimentrts.keybindings";

function codeToLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Rebindable action -> key-code map, persisted to localStorage. Arrow keys always work as a
 * fixed alias for ground movement regardless of bindings - only the letter-key defaults here
 * are rebindable. */
class Keybindings {
  private bindings: Record<Action, string> = { ...DEFAULTS };

  constructor() {
    this.load();
  }

  get(action: Action): string {
    return this.bindings[action];
  }

  label(action: Action): string {
    return codeToLabel(this.bindings[action]);
  }

  set(action: Action, code: string): void {
    this.bindings[action] = code;
    this.save();
  }

  matches(action: Action, code: string): boolean {
    return this.bindings[action] === code;
  }

  actions(): Action[] {
    return Object.keys(DEFAULTS) as Action[];
  }

  resetDefaults(): void {
    this.bindings = { ...DEFAULTS };
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.bindings, JSON.parse(raw));
    } catch {
      // localStorage unavailable or corrupted - fall back to defaults silently.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch {
      // Best-effort persistence only.
    }
  }
}

export const keybindings = new Keybindings();
