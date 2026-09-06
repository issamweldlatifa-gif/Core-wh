import { describe, it, expect } from 'vitest';
import { labelsHtml } from './print-label';

describe('Internal shipping label rendering (not carrier certification)', () => {
  it('renders the provided shipping/order/customer data rather than sample content', () => {
    const html = labelsHtml([{ kind: 'DISPATCH NOTE', code: 'OUT-TEST-001', bigLabel: 'CUSTOMER-TEST',
      lines: [{ k: 'ORDER', v: 'ORDER-TEST-001' }, { k: 'PIECES', v: '30' }] }]);
    expect(html).toContain('OUT-TEST-001');
    expect(html).toContain('CUSTOMER-TEST');
    expect(html).toContain('ORDER-TEST-001');
    expect(html).toContain('<svg');
    expect(html).toContain('30');
  });
  it('escapes user-controlled text before creating printable HTML', () => {
    const html = labelsHtml([{ kind: 'NOTE', code: 'OUT-TEST-002', bigLabel: '<script>alert(1)</script>',
      lines: [{ k: '<img>', v: 'A&B' }] }]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A&amp;B');
  });
});
