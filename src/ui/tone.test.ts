import { describe, it, expect } from 'vitest';
import { TONE_ACCENT, TONE_SURFACE, TONE_TEXT, type Tone } from './tone';

/**
 * Guards against the most likely way a design system rots: a tone is added to
 * the union and one of the lookup maps is forgotten, producing an element with
 * no colour at all rather than a visible failure.
 */
const ALL_TONES: Tone[] = [
  'neutral',
  'valid',
  'suspect',
  'faultline',
  'repaired',
  'uncertain',
  'danger',
];

describe('tone maps', () => {
  it.each([
    ['TONE_TEXT', TONE_TEXT],
    ['TONE_SURFACE', TONE_SURFACE],
    ['TONE_ACCENT', TONE_ACCENT],
  ])('%s covers every tone with a non-empty class', (_name, map) => {
    for (const tone of ALL_TONES) {
      expect(map[tone]).toBeTruthy();
    }
    expect(Object.keys(map).sort()).toEqual([...ALL_TONES].sort());
  });

  it('never resolves a tone to a raw colour value', () => {
    // Tones must map to semantic utility classes, not hex or oklch literals,
    // so the theme switch keeps working.
    const everyClass = [
      ...Object.values(TONE_TEXT),
      ...Object.values(TONE_SURFACE),
      ...Object.values(TONE_ACCENT),
    ].join(' ');
    expect(everyClass).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(everyClass).not.toMatch(/oklch\(/i);
  });
});
