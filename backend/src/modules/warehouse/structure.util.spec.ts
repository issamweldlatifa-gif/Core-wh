import { buildLocationCode, levelCodeFromNumber, normalizeCode } from './structure.util';

describe('structure.util', () => {
  describe('normalizeCode', () => {
    it('uppercases and trims', () => {
      expect(normalizeCode('  shoes ')).toBe('SHOES');
      expect(normalizeCode('a01')).toBe('A01');
    });
  });

  describe('levelCodeFromNumber (D-36)', () => {
    it('derives L-prefixed display codes from numeric order', () => {
      expect(levelCodeFromNumber(1)).toBe('L01');
      expect(levelCodeFromNumber(2)).toBe('L02');
      expect(levelCodeFromNumber(10)).toBe('L10');
      expect(levelCodeFromNumber(99)).toBe('L99');
      expect(levelCodeFromNumber(100)).toBe('L100');
    });
    it('clamps below 1 to L01', () => {
      expect(levelCodeFromNumber(0)).toBe('L01');
      expect(levelCodeFromNumber(-5)).toBe('L01');
    });
  });

  describe('buildLocationCode (D-30, LOCKED format)', () => {
    it('joins the parent chain uppercased with hyphens', () => {
      expect(buildLocationCode('TUN-MAIN', 'SHOES', 'A01', 'R02', 'L03')).toBe(
        'TUN-MAIN-SHOES-A01-R02-L03',
      );
    });
    it('normalizes mixed-case inputs', () => {
      expect(buildLocationCode('tun-main', 'shoes', 'a01', 'r02', 'l03')).toBe(
        'TUN-MAIN-SHOES-A01-R02-L03',
      );
    });
  });
});
