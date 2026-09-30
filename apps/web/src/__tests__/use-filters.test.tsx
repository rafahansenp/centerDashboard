import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { resolvePreset, useFilters } from '../hooks/use-filters.js';

function wrapperFor(route: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  };
}

const TODAY = '2026-03-15';

describe('resolvePreset', () => {
  it('today covers a single day', () => {
    expect(resolvePreset('today', TODAY)).toEqual({ from: TODAY, to: TODAY, granularity: 'day' });
  });

  it('last7 covers today and the six previous days', () => {
    expect(resolvePreset('last7', TODAY)).toEqual({ from: '2026-03-09', to: TODAY, granularity: 'day' });
  });

  it('last30 stays on day granularity', () => {
    expect(resolvePreset('last30', TODAY)).toEqual({ from: '2026-02-14', to: TODAY, granularity: 'day' });
  });

  it('last90 switches to week so the axis stays readable', () => {
    expect(resolvePreset('last90', TODAY)).toEqual({ from: '2025-12-16', to: TODAY, granularity: 'week' });
  });

  it('monthToDate starts on the first of the month', () => {
    expect(resolvePreset('monthToDate', TODAY)).toEqual({ from: '2026-03-01', to: TODAY, granularity: 'day' });
  });

  it('lastMonth covers the whole previous month', () => {
    expect(resolvePreset('lastMonth', TODAY)).toEqual({
      from: '2026-02-01', to: '2026-02-28', granularity: 'day',
    });
  });

  it('handles a January lastMonth crossing the year boundary', () => {
    expect(resolvePreset('lastMonth', '2026-01-10')).toEqual({
      from: '2025-12-01', to: '2025-12-31', granularity: 'day',
    });
  });

  it('handles February in a leap year', () => {
    expect(resolvePreset('lastMonth', '2024-03-10')).toEqual({
      from: '2024-02-01', to: '2024-02-29', granularity: 'day',
    });
  });
});

describe('useFilters', () => {
  it('defaults to the last 90 days when the URL has no params', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/') });
    expect(result.current.filters).toEqual({
      from: '2025-12-16', to: TODAY, granularity: 'week', sources: ['commerce', 'ga4'],
    });
  });

  it('reads the filters from the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?from=2026-01-01&to=2026-01-31&granularity=month&sources=commerce'),
    });
    expect(result.current.filters).toEqual({
      from: '2026-01-01', to: '2026-01-31', granularity: 'month', sources: ['commerce'],
    });
  });

  it('falls back to the default on an invalid granularity', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/?granularity=hour') });
    expect(result.current.filters.granularity).toBe('week');
  });

  it('ignores an unknown source in the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?sources=commerce,mixpanel'),
    });
    expect(result.current.filters.sources).toEqual(['commerce']);
  });

  it('writes a patch back to the URL without dropping the other filters', () => {
    const { result } = renderHook(() => useFilters(TODAY), {
      wrapper: wrapperFor('/?from=2026-01-01&to=2026-01-31&granularity=day'),
    });
    act(() => result.current.setFilters({ granularity: 'month' }));
    expect(result.current.filters).toMatchObject({
      from: '2026-01-01', to: '2026-01-31', granularity: 'month',
    });
  });

  it('applies a preset to the URL', () => {
    const { result } = renderHook(() => useFilters(TODAY), { wrapper: wrapperFor('/') });
    act(() => result.current.applyPreset('lastMonth'));
    expect(result.current.filters).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });
});
