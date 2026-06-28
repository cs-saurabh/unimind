// Live-tunable force-layout settings, surfaced in the Settings panel.

export interface ForceSettings {
  chargeStrength: number; // node repulsion (more negative = nodes push apart harder)
  chargeDistanceMax: number; // cap on repulsion range (smaller = tighter, less sprawl)
  linkDistance: number; // edge rest length
  gravityStrength: number; // pull toward center (higher = leaf nodes reeled in, bounded cloud)
  velocityDecay: number; // friction (higher = settles faster, less jiggle)
  nodeSizeMultiplier: number; // global visual scale applied on top of the computed node radii
}

export const DEFAULT_SETTINGS: ForceSettings = {
  chargeStrength: -365,
  chargeDistanceMax: 870,
  linkDistance: 126,
  gravityStrength: 0.01,
  velocityDecay: 0.3,
  nodeSizeMultiplier: 2,
};

// UI metadata for each slider: label, range, step, and a short hint.
export interface SettingField {
  key: keyof ForceSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

export const SETTING_FIELDS: SettingField[] = [
  {
    key: "chargeStrength",
    label: "Repulsion",
    min: -400,
    max: 0,
    step: 5,
    hint: "How hard nodes push each other apart",
  },
  {
    key: "chargeDistanceMax",
    label: "Repulsion range",
    min: 50,
    max: 1000,
    step: 10,
    hint: "Distance beyond which nodes stop repelling — lower keeps the cloud tight",
  },
  {
    key: "linkDistance",
    label: "Link length",
    min: 10,
    max: 200,
    step: 2,
    hint: "Resting length of each edge",
  },
  {
    key: "gravityStrength",
    label: "Center gravity",
    min: 0,
    max: 0.5,
    step: 0.01,
    hint: "Pull toward center — raise to reel in stray leaf nodes",
  },
  {
    key: "velocityDecay",
    label: "Friction",
    min: 0.1,
    max: 0.9,
    step: 0.05,
    hint: "Higher settles faster with less jiggle",
  },
  {
    key: "nodeSizeMultiplier",
    label: "Bubble size",
    min: 0.5,
    max: 2.5,
    step: 0.1,
    hint: "Scales all node bubbles while preserving the current relative sizing",
  },
];
