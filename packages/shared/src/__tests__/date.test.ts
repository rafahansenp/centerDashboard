import { bucketStart, eachBucket } from '../date.js';

describe('bucketStart', () => {
  it('returns the same date for day granularity', () => {
    expect(bucketStart('2026-03-17', 'day')).toBe('2026-03-17');
  });

  it('snaps to the Monday of the ISO week', () => {
    expect(bucketStart('2026-03-17', 'week')).toBe('2026-03-16');
    expect(bucketStart('2026-03-16', 'week')).toBe('2026-03-16');
    expect(bucketStart('2026-03-22', 'week')).toBe('2026-03-16');
  });

  it('snaps to the first day of the month', () => {
    expect(bucketStart('2026-03-17', 'month')).toBe('2026-03-01');
  });

  it('rejects a malformed date', () => {
    expect(() => bucketStart('17/03/2026', 'day')).toThrow('data inválida');
  });
});

describe('eachBucket', () => {
  it('enumerates every day inclusive of both ends', () => {
    expect(eachBucket('2026-03-01', '2026-03-04', 'day')).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04',
    ]);
  });

  it('enumerates month buckets across a year boundary', () => {
    expect(eachBucket('2025-11-15', '2026-01-02', 'month')).toEqual([
      '2025-11-01', '2025-12-01', '2026-01-01',
    ]);
  });

  it('returns a single bucket when from equals to', () => {
    expect(eachBucket('2026-03-01', '2026-03-01', 'day')).toEqual(['2026-03-01']);
  });

  it('throws when the range is inverted', () => {
    expect(() => eachBucket('2026-03-05', '2026-03-01', 'day')).toThrow('range inválido');
  });
});
