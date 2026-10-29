import {
  allowedSources,
  decideSource,
  isContractInForce,
  moduleReadiness,
  visibleModules,
  type ContractRow,
  type IntegrationState,
} from '../access.js';

const now = new Date('2026-11-01T12:00:00Z');
const past = new Date('2026-01-01T00:00:00Z');
const future = new Date('2027-01-01T00:00:00Z');

const contract = (moduleKey: string, over: Partial<ContractRow> = {}): ContractRow => ({
  moduleKey,
  status: 'ACTIVE',
  startsAt: past,
  endsAt: null,
  ...over,
});
const ok = (kind: IntegrationState['kind'], hasBigQueryDataset = false): IntegrationState => ({
  kind,
  status: 'OK',
  hasBigQueryDataset,
});

describe('isContractInForce', () => {
  it('contract in force when active, started and not ended', () => {
    expect(isContractInForce(contract('overview'), now)).toBe(true);
  });
  it('contract ending exactly now is not in force', () => {
    expect(isContractInForce(contract('overview', { endsAt: now }), now)).toBe(false);
  });
  it('contract starting in the future is not in force', () => {
    expect(isContractInForce(contract('overview', { startsAt: future }), now)).toBe(false);
  });
  it('suspended contract is not in force', () => {
    expect(isContractInForce(contract('overview', { status: 'SUSPENDED' }), now)).toBe(false);
  });
});

describe('visibleModules', () => {
  it('suspended organization sees nothing', () => {
    expect(
      visibleModules({ organizationActive: false, role: 'ADMIN', contracts: [contract('overview')], grants: [], now }),
    ).toEqual([]);
  });
  it('admin sees every in-force contract in catalog order', () => {
    expect(
      visibleModules({
        organizationActive: true,
        role: 'ADMIN',
        contracts: [contract('sprint'), contract('overview')],
        grants: [],
        now,
      }),
    ).toEqual(['overview', 'sprint']);
  });
  it('member sees only granted modules that are in force', () => {
    expect(
      visibleModules({
        organizationActive: true,
        role: 'MEMBER',
        contracts: [contract('overview'), contract('products')],
        grants: ['products', 'quality'],
        now,
      }),
    ).toEqual(['products']);
  });
  it('unknown module keys in contracts are ignored', () => {
    expect(
      visibleModules({ organizationActive: true, role: 'ADMIN', contracts: [contract('billing')], grants: [], now }),
    ).toEqual([]);
  });
});

describe('allowedSources', () => {
  it('unions the module sources', () => {
    expect(allowedSources(['products', 'acquisition'])).toEqual(new Set(['commerce', 'ga4', 'behavior']));
    expect(allowedSources(['assistant']).size).toBe(0);
  });
});

describe('decideSource', () => {
  it('forbidden when no visible module grants the source', () => {
    expect(decideSource('ga4', ['overview'], [ok('WEB_ANALYTICS')])).toBe('forbidden');
  });
  it('pending when the integration exists but is not OK', () => {
    const pending: IntegrationState = { kind: 'COMMERCE', status: 'PENDING', hasBigQueryDataset: false };
    expect(decideSource('commerce', ['overview'], [pending])).toBe('pending');
  });
  it('allowed when the integration is OK', () => {
    expect(decideSource('commerce', ['overview'], [ok('COMMERCE')])).toBe('allowed');
  });
  it('quality is allowed with only APP_STORE OK', () => {
    expect(decideSource('quality', ['quality'], [ok('APP_STORE')])).toBe('allowed');
  });
  it('behavior is pending without BigQuery dataset', () => {
    expect(decideSource('behavior', ['acquisition'], [ok('WEB_ANALYTICS', false)])).toBe('pending');
    expect(decideSource('behavior', ['acquisition'], [ok('WEB_ANALYTICS', true)])).toBe('allowed');
  });
});

describe('moduleReadiness', () => {
  it('acquisition is ready without BigQuery dataset', () => {
    expect(moduleReadiness('acquisition', [ok('WEB_ANALYTICS', false), ok('COMMERCE')])).toBe('ready');
  });
  it('awaits setup when a required source is missing', () => {
    expect(moduleReadiness('acquisition', [ok('WEB_ANALYTICS')])).toBe('awaiting_setup');
  });
  it('assistant is always ready', () => {
    expect(moduleReadiness('assistant', [])).toBe('ready');
  });
});
