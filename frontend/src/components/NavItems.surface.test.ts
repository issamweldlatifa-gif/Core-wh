import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, filterNavItems } from './NavItems';

/**
 * Order #3 application-surface nav filter (AYROVI ADMIN_WEB/WORKER endpoint
 * conflict regression). Worker workspace links point at /terminal/* whose API
 * is reserved for WORKER_NATIVE sessions — they must never be offered to an
 * ADMIN_WEB session, even when that session holds the execute permission.
 */
describe('filterNavItems (application surface)', () => {
  const all = () => true;

  it('hides worker workspace items from an ADMIN_WEB session holding execute permissions', () => {
    const visible = filterNavItems(NAV_ITEMS, all, 'ADMIN_WEB').map((i) => i.key);
    expect(visible).not.toContain('receiving');
    expect(visible).not.toContain('putaway');
    // Shared items stay available.
    expect(visible).toContain('dashboard');
    expect(visible).toContain('admin');
    expect(visible).toContain('profile');
  });

  it('shows worker workspace items to a WORKER_NATIVE session holding execute permissions', () => {
    const visible = filterNavItems(NAV_ITEMS, all, 'WORKER_NATIVE').map((i) => i.key);
    expect(visible).toContain('receiving');
    expect(visible).toContain('putaway');
  });

  it('still filters by permission inside the right surface', () => {
    const none = () => false;
    const visible = filterNavItems(NAV_ITEMS, none, 'WORKER_NATIVE').map((i) => i.key);
    expect(visible).toEqual(['dashboard', 'profile']);
  });

  it('keeps legacy behaviour (permission-only) when the surface is unknown', () => {
    const visible = filterNavItems(NAV_ITEMS, all, undefined).map((i) => i.key);
    expect(visible).toContain('receiving');
  });
});
