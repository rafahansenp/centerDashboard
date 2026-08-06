import { RateLimiter } from '../rate-limiter.js';

function fakeClock() {
  let currentTime = 0;
  const sleeps: number[] = [];
  return {
    now: () => currentTime,
    sleep: async (ms: number) => { sleeps.push(ms); currentTime += ms; },
    advance: (ms: number) => { currentTime += ms; },
    sleeps,
  };
}

describe('RateLimiter', () => {
  it('lets the first N calls through without sleeping', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, clock.now, clock.sleep);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('sleeps until the oldest call leaves the window on the N+1th call', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, clock.now, clock.sleep);
    await limiter.acquire();
    clock.advance(10_000);
    await limiter.acquire();
    await limiter.acquire();

    await limiter.acquire();
    // A chamada mais antiga foi em t=0; a janela é 60s; estamos em t=10000.
    expect(clock.sleeps).toEqual([50_000]);
  });

  it('does not sleep once the window has rolled past every call', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, clock.now, clock.sleep);
    await limiter.acquire();
    await limiter.acquire();
    clock.advance(61_000);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('keeps admitting calls at a steady rate under sustained pressure', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, clock.now, clock.sleep);
    for (let i = 0; i < 6; i += 1) await limiter.acquire();
    // 6 chamadas com teto de 2/min: 4 esperas.
    expect(clock.sleeps).toHaveLength(4);
    expect(clock.sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it('rejects a non positive limit', () => {
    expect(() => new RateLimiter(0)).toThrow('maxPerMinute precisa ser positivo');
  });
});
