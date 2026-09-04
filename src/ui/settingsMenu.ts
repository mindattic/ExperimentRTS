import { keybindings, ACTION_LABELS, type Action } from "../input/keybindings";
import { graphicsSettings, QUALITY_PRESETS, MIN_NIGHT_BRIGHTNESS, MAX_NIGHT_BRIGHTNESS } from "../settings/graphicsSettings";

/** Hamburger menu (Reorient / Free cam toggle / Settings) and the Settings modal (terrain quality, rebindable keys), both plain HTML overlays in the same pattern as SelectionUI's Focus list. */
export class SettingsMenu {
  private readonly menuButton = document.getElementById("menuButton") as HTMLButtonElement;
  private readonly menuDropdown = document.getElementById("menuDropdown") as HTMLElement;
  private readonly reorientMenuItem = document.getElementById("reorientMenuItem") as HTMLButtonElement;
  private readonly freeCamMenuItem = document.getElementById("freeCamMenuItem") as HTMLButtonElement;
  private readonly settingsMenuItem = document.getElementById("settingsMenuItem") as HTMLButtonElement;
  private readonly settingsModal = document.getElementById("settingsModal") as HTMLElement;
  private readonly settingsCloseButton = document.getElementById("settingsCloseButton") as HTMLButtonElement;
  private readonly terrainQualitySelect = document.getElementById("terrainQualitySelect") as HTMLSelectElement;
  private readonly nightBrightnessSlider = document.getElementById("nightBrightnessSlider") as HTMLInputElement;
  private readonly keybindList = document.getElementById("keybindList") as HTMLElement;
  private readonly resetBindingsButton = document.getElementById("resetBindingsButton") as HTMLButtonElement;
  private readonly invertSelectionAreaCheckbox = document.getElementById("invertSelectionAreaCheckbox") as HTMLInputElement;

  private listeningAction: Action | null = null;

  constructor(onReorient: () => void, onToggleFreeCam: () => void) {
    this.menuButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menuDropdown.hidden = !this.menuDropdown.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!this.menuDropdown.hidden && e.target !== this.menuButton && !this.menuDropdown.contains(e.target as Node)) {
        this.menuDropdown.hidden = true;
      }
    });

    this.reorientMenuItem.addEventListener("click", () => {
      onReorient();
      this.menuDropdown.hidden = true;
    });
    this.freeCamMenuItem.addEventListener("click", () => {
      onToggleFreeCam();
      this.menuDropdown.hidden = true;
    });
    this.settingsMenuItem.addEventListener("click", () => {
      this.openSettings();
      this.menuDropdown.hidden = true;
    });

    this.settingsCloseButton.addEventListener("click", () => this.closeSettings());
    this.settingsModal.addEventListener("click", (e) => {
      if (e.target === this.settingsModal) this.closeSettings();
    });

    this.populateQualitySelect();
    this.terrainQualitySelect.addEventListener("change", () => {
      graphicsSettings.setPresetIndex(this.terrainQualitySelect.selectedIndex);
    });

    this.nightBrightnessSlider.value = String(this.brightnessToSlider(graphicsSettings.nightBrightness));
    this.nightBrightnessSlider.addEventListener("input", () => {
      graphicsSettings.setNightBrightness(this.sliderToBrightness(Number(this.nightBrightnessSlider.value)));
    });

    this.populateKeybindList();
    this.resetBindingsButton.addEventListener("click", () => {
      keybindings.resetDefaults();
      this.populateKeybindList();
    });

    this.invertSelectionAreaCheckbox.checked = graphicsSettings.invertSelectionAreaResize;
    this.invertSelectionAreaCheckbox.addEventListener("change", () => {
      graphicsSettings.setInvertSelectionAreaResize(this.invertSelectionAreaCheckbox.checked);
    });

    window.addEventListener("keydown", (e) => this.onGlobalKeyDown(e));
  }

  private openSettings(): void {
    this.settingsModal.hidden = false;
  }

  private closeSettings(): void {
    this.settingsModal.hidden = true;
    this.listeningAction = null;
    this.populateKeybindList();
  }

  private brightnessToSlider(brightness: number): number {
    return Math.round(((brightness - MIN_NIGHT_BRIGHTNESS) / (MAX_NIGHT_BRIGHTNESS - MIN_NIGHT_BRIGHTNESS)) * 100);
  }

  private sliderToBrightness(value: number): number {
    return MIN_NIGHT_BRIGHTNESS + (value / 100) * (MAX_NIGHT_BRIGHTNESS - MIN_NIGHT_BRIGHTNESS);
  }

  private populateQualitySelect(): void {
    this.terrainQualitySelect.innerHTML = "";
    QUALITY_PRESETS.forEach((preset, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = preset.label;
      this.terrainQualitySelect.appendChild(option);
    });
    this.terrainQualitySelect.selectedIndex = graphicsSettings.presetIndex;
  }

  private populateKeybindList(): void {
    this.keybindList.innerHTML = "";
    for (const action of keybindings.actions()) {
      const row = document.createElement("div");
      row.className = "keybind-row";

      const label = document.createElement("span");
      label.textContent = ACTION_LABELS[action];

      const keyButton = document.createElement("button");
      keyButton.className = "keybind-key";
      keyButton.type = "button";
      keyButton.textContent = keybindings.label(action);
      keyButton.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startListening(action, keyButton);
      });

      row.appendChild(label);
      row.appendChild(keyButton);
      this.keybindList.appendChild(row);
    }
  }

  private startListening(action: Action, keyButton: HTMLButtonElement): void {
    this.listeningAction = action;
    keyButton.textContent = "Press a key…";
    keyButton.classList.add("is-listening");
  }

  private onGlobalKeyDown(e: KeyboardEvent): void {
    if (!this.listeningAction) return;
    e.preventDefault();
    e.stopPropagation();
    keybindings.set(this.listeningAction, e.code);
    this.listeningAction = null;
    this.populateKeybindList();
  }

  /** True while the settings modal is capturing the next keypress for a rebind - callers
   * should ignore their own hotkeys while this is true. */
  get isListeningForKey(): boolean {
    return this.listeningAction !== null;
  }
}
