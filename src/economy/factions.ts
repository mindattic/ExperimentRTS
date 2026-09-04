import { Color3 } from "@babylonjs/core";

export type FactionId = "solFederation" | "beltConsortium";

export interface FactionPalette {
  label: string;
  /** Base panel color for most of the hull. */
  hull: Color3;
  /** Cockpit glass / engine glow / trim color. */
  accent: Color3;
}

export const FACTION_PALETTES: Record<FactionId, FactionPalette> = {
  solFederation: { label: "Sol Federation", hull: new Color3(0.55, 0.6, 0.68), accent: new Color3(0.25, 0.7, 1.0) },
  beltConsortium: { label: "Belt Consortium", hull: new Color3(0.62, 0.48, 0.32), accent: new Color3(1.0, 0.55, 0.15) },
};
