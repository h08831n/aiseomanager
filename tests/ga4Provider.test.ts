import { describe, it, expect, vi } from 'vitest';
import { GoogleAnalytics4Provider } from '../server/services/integrations/providers/googleAnalytics4Provider';

describe('Phase 3: GoogleAnalytics4Provider Test Suite', () => {
  it('correctly requests and parses GA4 runReport response', async () => {
    const mockReportData = {
      dimensionHeaders: [
        { name: 'date' },
        { name: 'landingPagePlusQueryString' },
        { name: 'sessionDefaultChannelGroup' },
      ],
      metricHeaders: [
        { name: 'sessions', type: 'TYPE_INTEGER' },
        { name: 'engagedSessions', type: 'TYPE_INTEGER' },
        { name: 'activeUsers', type: 'TYPE_INTEGER' },
        { name: 'newUsers', type: 'TYPE_INTEGER' },
        { name: 'keyEvents', type: 'TYPE_INTEGER' },
        { name: 'totalRevenue', type: 'TYPE_FLOAT' },
      ],
      rows: [
        {
          dimensionValues: [{ value: '20260810' }, { value: '/pricing' }, { value: 'Organic Search' }],
          metricValues: [
            { value: '1420' },
            { value: '1100' },
            { value: '1350' },
            { value: '890' },
            { value: '142' },
            { value: '28400.00' },
          ],
        },
      ],
      rowCount: 1,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockReportData,
    } as any);

    const provider = new GoogleAnalytics4Provider();
    const result = await provider.runReport('mock-token', 'properties/12345678', {
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      dimensions: ['date', 'landingPagePlusQueryString', 'sessionDefaultChannelGroup'],
      metrics: ['sessions', 'engagedSessions', 'activeUsers', 'newUsers', 'keyEvents', 'totalRevenue'],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rowCount).toBe(1);
    expect(result.provenance).toBe('GOOGLE_ANALYTICS');

    const row = result.rows[0];
    expect(row.dimensionValues[0]).toBe('20260810');
    expect(row.dimensionValues[1]).toBe('/pricing');
    expect(row.metricValues[0]).toBe(1420);
    expect(row.metricValues[1]).toBe(1100);
    expect(row.metricValues[4]).toBe(142);
    expect(row.metricValues[5]).toBe(28400.0);
  });

  it('lists accessible GA4 accounts and property summaries', async () => {
    const mockSummaries = {
      accountSummaries: [
        {
          name: 'accountSummaries/111',
          account: 'accounts/111',
          displayName: 'TechScale Corp',
          propertySummaries: [
            {
              property: 'properties/999888',
              displayName: 'TechScale Production Web',
              propertyType: 'PROPERTY_TYPE_ORDINARY',
            },
          ],
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockSummaries,
    } as any);

    const provider = new GoogleAnalytics4Provider();
    const result = await provider.listAccessibleAccountsAndProperties('mock-token');

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].displayName).toBe('TechScale Corp');
    expect(result.properties).toHaveLength(1);
    expect(result.properties[0].propertyId).toBe('999888');
    expect(result.properties[0].displayName).toBe('TechScale Production Web');
  });
});
