import { describe, it, expect, vi } from 'vitest';
import { GoogleSearchConsoleProvider } from '../server/services/integrations/providers/googleSearchConsoleProvider';

describe('Phase 3: GoogleSearchConsoleProvider Test Suite', () => {
  it('correctly maps property entries and classifies DOMAIN vs URL_PREFIX properties', async () => {
    const mockSitesData = {
      siteEntry: [
        { siteUrl: 'sc-domain:techscale.io', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://techscale.io/', permissionLevel: 'siteFullUser' },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockSitesData,
    } as any);

    const provider = new GoogleSearchConsoleProvider();
    const properties = await provider.listAccessibleProperties('mock-token');

    expect(properties).toHaveLength(2);
    expect(properties[0].siteUrl).toBe('sc-domain:techscale.io');
    expect(properties[0].propertyType).toBe('DOMAIN');
    expect(properties[0].permissionLevel).toBe('siteOwner');

    expect(properties[1].siteUrl).toBe('https://techscale.io/');
    expect(properties[1].propertyType).toBe('URL_PREFIX');
  });

  it('queries and parses Search Console searchAnalytics batch response', async () => {
    const mockQueryData = {
      responseAggregationType: 'byPage',
      rows: [
        {
          keys: ['https://techscale.io/pricing', 'techscale pricing', '2026-08-10', 'USA', 'DESKTOP'],
          clicks: 250,
          impressions: 1200,
          ctr: 0.2083,
          position: 1.8,
        },
        {
          keys: ['https://techscale.io/docs', 'workflow setup', '2026-08-10', 'GBR', 'MOBILE'],
          clicks: 45,
          impressions: 900,
          ctr: 0.05,
          position: 4.2,
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockQueryData,
    } as any);

    const provider = new GoogleSearchConsoleProvider();
    const result = await provider.querySearchAnalytics('mock-token', 'sc-domain:techscale.io', {
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      dimensions: ['page', 'query', 'date', 'country', 'device'],
    });

    expect(result.rows).toHaveLength(2);
    expect(result.dataState).toBe('FINALIZED');
    expect(result.provenance).toBe('GOOGLE_SEARCH_CONSOLE');

    const firstRow = result.rows[0];
    expect(firstRow.page).toBe('https://techscale.io/pricing');
    expect(firstRow.query).toBe('techscale pricing');
    expect(firstRow.clicks).toBe(250);
    expect(firstRow.impressions).toBe(1200);
    expect(firstRow.position).toBe(1.8);
  });

  it('handles rate limits (HTTP 429) gracefully with custom error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Quota exceeded for quota metric "Queries" and limit "Queries per minute"',
    } as any);

    const provider = new GoogleSearchConsoleProvider();
    await expect(
      provider.querySearchAnalytics('mock-token', 'sc-domain:techscale.io', {
        startDate: '2026-08-01',
        endDate: '2026-08-15',
      })
    ).rejects.toThrow('GSC_RATE_LIMITED');
  });
});
