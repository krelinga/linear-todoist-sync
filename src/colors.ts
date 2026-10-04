import { colors, defaultColor, type ColorKey } from '@doist/todoist-sdk';

/**
 * Mapping from a Linear workflow state to the Todoist project color it should produce
 * (colors design §3).
 *
 * Keyed by **normalized** state name, not by the name as written in config or as Linear
 * spells it - see `normalizeStateName`. A state id would be exact but is an opaque per-team
 * UUID, so an id-keyed mapping would be unreadable in config and would need re-deriving for
 * every team; keying by name also means two teams that both call a state `In Progress` share
 * one entry, which is intended rather than a compromise.
 */
export type StateColorMap = ReadonlyMap<string, ColorKey>;

/**
 * Todoist's palette is a fixed list of 20 keys that ships with the SDK, so a bad color key is
 * a *local* mistake and is caught at startup without asking Todoist anything (§3). Contrast
 * state names, which only Linear knows and which are therefore never validated at startup
 * (§8) - the unmapped gauge is what surfaces those instead.
 */
const COLOR_KEYS: ReadonlySet<string> = new Set(colors.map((color) => color.key));

export function isColorKey(value: string): value is ColorKey {
  return COLOR_KEYS.has(value);
}

/**
 * Todoist's own default, used when `LINEAR_STATE_COLOR_DEFAULT` is unset (§4).
 *
 * Taken from the SDK rather than hardcoded so it tracks whatever Todoist considers default, but
 * narrowed through `isColorKey` rather than asserted: the SDK types `defaultColor.key` as plain
 * `string`, and a cast here would be the one place in this module claiming something about the
 * palette without checking it.
 */
export const FALLBACK_STATE_COLOR: ColorKey = isColorKey(defaultColor.key)
  ? defaultColor.key
  : 'charcoal';

/** Every valid key, for the error message of a `ConfigError` that rejected one. */
export function colorKeys(): string[] {
  return colors.map((color) => color.key);
}

/**
 * Case-insensitive and whitespace-trimmed (§3), because the config is hand-written and Linear's
 * own capitalization of a state name is not something the operator should have to match
 * exactly. Applied to both sides - the config key and the name Linear reports - so the two
 * cannot disagree about normalization.
 */
export function normalizeStateName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The color a started issue's project should have.
 *
 * Returns the default for any state the map does not mention, which is the behavior §5 chose
 * over leaving the project's current color alone: leaving it alone never overwrites anything
 * but makes a forgotten state indistinguishable from a configured one. `isStateMapped` is how
 * callers tell the two apart for metrics and logging, since the color alone cannot - a state
 * explicitly configured as `charcoal` and an unmapped one both resolve here to `charcoal`.
 */
export function resolveStateColor(
  stateName: string,
  stateColors: StateColorMap,
  defaultColorKey: ColorKey,
): ColorKey {
  return stateColors.get(normalizeStateName(stateName)) ?? defaultColorKey;
}

export function isStateMapped(stateName: string, stateColors: StateColorMap): boolean {
  return stateColors.has(normalizeStateName(stateName));
}

export type { ColorKey };
