import { describe, expect, it } from 'vitest';
import {
  colorKeys,
  FALLBACK_STATE_COLOR,
  isColorKey,
  isStateMapped,
  normalizeStateName,
  resolveStateColor,
  type StateColorMap,
} from '../src/colors.js';

describe('isColorKey', () => {
  it('accepts every key the SDK ships and nothing else', () => {
    // The palette is fixed and known locally, which is the whole reason a bad colour is a
    // startup error while a bad state name is not (colors design §3).
    expect(colorKeys()).toHaveLength(20);
    for (const key of colorKeys()) {
      expect(isColorKey(key)).toBe(true);
    }
    expect(isColorKey('periwinkle')).toBe(false);
    expect(isColorKey('Blue')).toBe(false); // keys are lower_snake_case; no normalising here
    expect(isColorKey('')).toBe(false);
  });
});

describe('FALLBACK_STATE_COLOR', () => {
  it('is a real colour key', () => {
    // Narrowed from the SDK's loosely-typed `defaultColor.key` rather than asserted, so this
    // is the test that the narrowing did not silently fall through to its literal branch.
    expect(isColorKey(FALLBACK_STATE_COLOR)).toBe(true);
  });
});

describe('normalizeStateName', () => {
  it('trims and lowercases, so config need not match Linear capitalisation', () => {
    expect(normalizeStateName('  In Progress ')).toBe('in progress');
    expect(normalizeStateName('IN PROGRESS')).toBe('in progress');
  });
});

describe('resolveStateColor', () => {
  const map: StateColorMap = new Map([
    ['in progress', 'blue'],
    ['in review', 'grape'],
  ]);

  it('matches regardless of case or surrounding whitespace', () => {
    expect(resolveStateColor('In Progress', map, 'charcoal')).toBe('blue');
    expect(resolveStateColor('in progress', map, 'charcoal')).toBe('blue');
    expect(resolveStateColor('  IN PROGRESS  ', map, 'charcoal')).toBe('blue');
  });

  it('falls back to the default for a state it does not know', () => {
    expect(resolveStateColor('Blocked', map, 'charcoal')).toBe('charcoal');
  });

  it('falls back for an unresolvable state name', () => {
    // The client reports '' when Linear's state promise yields nothing, which must not
    // accidentally match a configured entry.
    expect(resolveStateColor('', map, 'charcoal')).toBe('charcoal');
  });

  it('cannot distinguish a configured default from an unmapped state, which is what isStateMapped is for', () => {
    // This is the reason the unmapped gauge reads `isStateMapped` and not the resolved colour:
    // a state explicitly configured as charcoal and an unmapped one resolve identically.
    const configuredCharcoal: StateColorMap = new Map([['blocked', 'charcoal']]);
    expect(resolveStateColor('Blocked', configuredCharcoal, 'charcoal')).toBe('charcoal');
    expect(resolveStateColor('Nowhere', configuredCharcoal, 'charcoal')).toBe('charcoal');
    expect(isStateMapped('Blocked', configuredCharcoal)).toBe(true);
    expect(isStateMapped('Nowhere', configuredCharcoal)).toBe(false);
  });
});

describe('isStateMapped', () => {
  it('normalises the same way resolveStateColor does', () => {
    const map: StateColorMap = new Map([['in progress', 'blue']]);
    expect(isStateMapped(' In Progress ', map)).toBe(true);
    expect(isStateMapped('Blocked', map)).toBe(false);
  });

  it('reports nothing mapped for an empty config', () => {
    expect(isStateMapped('In Progress', new Map())).toBe(false);
  });
});
