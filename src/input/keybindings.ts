export type Action =
  | "orbitYawLeft"
  | "orbitYawRight"
  | "orbitPitchUp"
  | "orbitPitchDown"
  | "orbitRollLeft"
  | "orbitRollRight"
  | "groundForward"
  | "groundBackward"
  | "groundLeft"
  | "groundRight"
  | "groundRotateLeft"
  | "groundRotateRight"
  | "reorient"
  | "moveUp"
  | "moveDown"
  | "freeCam"
  | "lockPlane"
  | "focusMenu"
  | "selectTarget"
  | "travel"
  | "exitGround"
  | "toggleLabels"
  | "enterOrbit";

export const ACTION_LABELS: Record<Action, string> = {
  orbitYawLeft: "Orbit: yaw left",
  orbitYawRight: "Orbit: yaw right",
  orbitPitchUp: "Orbit: pitch up",
  orbitPitchDown: "Orbit: pitch down",
  orbitRollLeft: "Orbit: roll left",
  orbitRollRight: "Orbit: roll right",
  groundForward: "Ground: forward",
  groundBackward: "Ground: backward",
  groundLeft: "Ground: strafe left",
  groundRight: "Ground: strafe right",
  groundRotateLeft: "Ground: rotate left",
  groundRotateRight: "Ground: rotate right",
  reorient: "Reorient camera",
  moveUp: "Free cam: move up",
  moveDown: "Free cam: move down",
  freeCam: "Toggle free cam",
  lockPlane: "Lock orbit to solar plane",
  focusMenu: "Open focus list",
  selectTarget: "Select target",
  travel: "Plot course (travel)",
  exitGround: "Exit ground mode",
  toggleLabels: "Toggle info labels",
  enterOrbit: "Enter focus mode around selected target (free cam)",
};

const DEFAULTS: Record<Action, string> = {
  orbitYawLeft: "KeyA",
  orbitYawRight: "KeyD",
  orbitPitchUp: "KeyW",
  orbitPitchDown: "KeyS",
  // Shares KeyQ/KeyE with groundRotateLeft/groundRotateRight and moveDown/moveUp - safe because
  // orbit/ground/free-cam are mutually exclusive modes, same "one physical key, mode-gated
  // behaviors" pattern as Space above. Rolling doesn't change which point on the planet is
  // centered in view, just tumbles the camera's own up vector around that view axis.
  orbitRollLeft: "KeyQ",
  orbitRollRight: "KeyE",
  groundForward: "KeyW",
  groundBackward: "KeyS",
  groundLeft: "KeyA",
  groundRight: "KeyD",
  groundRotateLeft: "KeyQ",
  groundRotateRight: "KeyE",
  reorient: "KeyR",
  moveUp: "KeyE",
  moveDown: "KeyQ",
  freeCam: "KeyF",
  lockPlane: "KeyP",
  focusMenu: "Digit1",
  selectTarget: "Space",
  // Shares the Space default with selectTarget - safe because they're mode-exclusive (travel
  // only fires in orbit mode, selectTarget only while free cam is active - see main.ts).
  travel: "Space",
  exitGround: "Escape",
  toggleLabels: "KeyL",
  // Shares KeyF with freeCam - safe because freeCam's own toggle only fires when FREE_CAM_ONLY
  // is off (see main.ts), same "one physical key, mode-gated behaviors" pattern as above. Needs
  // a double-tap (not a single press) to fire - see main.ts's ENTER_FOCUS_DOUBLE_TAP_MS.
  enterOrbit: "KeyF",
};

const STORAGE_KEY = "experimentrts.keybindings";

const MODIFIER_LABELS: Partial<Record<string, string>> = {
  AltLeft: "Alt",
  AltRight: "Alt",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
};

function codeToLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return MODIFIER_LABELS[code] ?? code;
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
