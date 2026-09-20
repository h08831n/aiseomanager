import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../server/db/prisma';
import { SecretVault } from '../server/security/secretVault';
import { TelemetryReadinessGate } from '../server/services/integrations/telemetryReadinessGate';
import { GoogleOAuthClient } from '../server/services/integrations/providers/googleOAuthClient';
import { SearchConsoleProvider } from '../server/services/integrations/providers/searchConsoleProvider';

function createMockGscProvider(overrides?: Partial<SearchConsoleProvider>): SearchConsoleProvider {
  return {
    listAccessibleProperties: vi.fn().mockResolvedValue([]),
    verifyPropertyAccess: vi.fn().mockResolvedValue({ accessible: true, permissionLevel: 'siteOwner' }),
    querySearchAnalytics: vi.fn().mockResolvedValue({
      rows: [],
      totalRows: 0,
      dataState: 'FINALIZED',
      isComplete: true,
      hasMore: false,
      retrievedAt: new Date().toISOString(),
      provenance: 'GOOGLE_SEARCH_CONSOLE',
    }),
    ...overrides,
  };
}

describe('Production Telemetry Readiness Gate', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
  });

  it('evaluates unregistered website as BLOCKED_EXTERNAL_CREDENTIALS with no synthetic pass', async () => {
    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: 'https://ahaninja.com',
    });

    expect(report.website).toBe('https://ahaninja.com');
    expect(report.readinessState).toBe('BLOCKED_EXTERNAL_CREDENTIALS');
    expect(report.isReadyForExperiment).toBe(false);
    expect(report.oauth.status).toBe('MISSING');
    expect(report.gsc.status).toBe('BLOCKED');
    expect(report.gsc.factCount).toBe(0);
    expect(report.gsc.provenance).toBe('NONE');
    expect(report.blockingReasons.length).toBeGreaterThan(0);
    expect(report.blockingReasons[0]).toContain('not registered in the database');
  });

  it('reports BLOCKED_EXTERNAL_CREDENTIALS when website exists but credentials are missing', async () => {
    const unique = Math.random().toString(36).slice(2);
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain: `unauthed-${unique}.com`,
        name: 'Unauthed Site',
        productionUrl: `https://unauthed-${unique}.com`,
      } as any,
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: website.productionUrl!,
    });

    expect(report.readinessState).toBe('BLOCKED_EXTERNAL_CREDENTIALS');
    expect(report.isReadyForExperiment).toBe(false);
    expect(report.oauth.status).toBe('MISSING');
    expect(report.blockingReasons.some((r) => r.includes('missing') || r.includes('credentials'))).toBe(true);
  });

  it('reports BLOCKED_EXTERNAL_CREDENTIALS when stored credentials cannot be decrypted', async () => {
    const unique = Math.random().toString(36).slice(2);
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain: `corrupt-tokens-${unique}.com`,
        name: 'Corrupt Tokens Site',
        productionUrl: `https://corrupt-tokens-${unique}.com`,
      } as any,
    });

    await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify({ iv: 'invalid', authTag: 'invalid', ciphertext: 'corrupt' }),
      } as any,
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: website.productionUrl!,
    });

    expect(report.readinessState).toBe('BLOCKED_EXTERNAL_CREDENTIALS');
    expect(report.oauth.status).toBe('DECRYPTION_ERROR');
    expect(report.blockingReasons.some((r) => r.includes('decrypt'))).toBe(true);
  });

  it('refreshes expiring token automatically and transitions OAuth status to REFRESHED', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `refresh-test-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain,
        name: 'Refresh Test Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const expiredPayload = JSON.stringify({
      accessToken: 'expiring-access-token-12345',
      refreshToken: 'valid-mock-refresh-token',
      expiresAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(), // 10 minutes ago
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      email: 'owner@refresh-test.org',
    });

    const encryptedCredentials = JSON.stringify(SecretVault.encrypt(expiredPayload));

    await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials,
        connectedAccount: 'owner@refresh-test.org',
        grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      } as any,
    });

    vi.spyOn(GoogleOAuthClient, 'refreshAccessToken').mockResolvedValueOnce({
      accessToken: 'brand-new-refreshed-access-token-67890',
      expiresIn: 3600,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      gscProvider: createMockGscProvider(),
      verifyLiveGoogleApi: false,
    });

    expect(report.oauth.status).toBe('REFRESHED');
    expect(report.oauth.email).toBe('owner@refresh-test.org');
    expect(report.oauth.hasGscScope).toBe(true);
  });

  it('reports CONFIGURED / CONNECTED when credentials exist but GSC property is not bound', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `nobinding-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain,
        name: 'No Binding Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const validPayload = JSON.stringify({
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      email: 'owner@nobinding.org',
    });

    await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify(SecretVault.encrypt(validPayload)),
        connectedAccount: 'owner@nobinding.org',
      } as any,
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      verifyLiveGoogleApi: false,
    });

    expect(report.gsc.status).toBe('NOT_BOUND');
    expect(report.readinessState).toBe('CONFIGURED');
    expect(report.isReadyForExperiment).toBe(false);
    expect(report.blockingReasons.some((r) => r.includes('property bound') || r.includes('NOT_BOUND'))).toBe(true);
  });

  it('reports BLOCKED_EXTERNAL_CREDENTIALS when GSC property access is denied by external provider', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `inaccessible-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain,
        name: 'Inaccessible Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const validPayload = JSON.stringify({
      accessToken: 'valid-access-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      email: 'owner@inaccessible.org',
    });

    const integration = await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify(SecretVault.encrypt(validPayload)),
        connectedAccount: 'owner@inaccessible.org',
      } as any,
    });

    await prisma.searchConsolePropertyBinding.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        providerPropertyId: `sc-domain:${domain}`,
        providerPropertyType: 'DOMAIN',
      } as any,
    });

    const mockGscProvider = createMockGscProvider({
      verifyPropertyAccess: vi.fn().mockResolvedValue({
        accessible: false,
        error: 'User does not have sufficient permissions for this Search Console property.',
      }),
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      gscProvider: mockGscProvider,
      verifyLiveGoogleApi: true,
    });

    expect(report.gsc.status).toBe('INACCESSIBLE');
    expect(report.readinessState).toBe('BLOCKED_EXTERNAL_CREDENTIALS');
    expect(report.isReadyForExperiment).toBe(false);
    expect(report.blockingReasons.some((r) => r.includes('inaccessible'))).toBe(true);
  });

  it('reports INSUFFICIENT_TELEMETRY when integration exists and is accessible, but zero facts are persisted', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `nofacts-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain,
        name: 'No Facts Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const validPayload = JSON.stringify({
      accessToken: 'valid-access-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      email: 'owner@nofacts.org',
    });

    const integration = await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify(SecretVault.encrypt(validPayload)),
        connectedAccount: 'owner@nofacts.org',
      } as any,
    });

    await prisma.searchConsolePropertyBinding.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        providerPropertyId: `sc-domain:${domain}`,
        providerPropertyType: 'DOMAIN',
      } as any,
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      gscProvider: createMockGscProvider(),
      verifyLiveGoogleApi: true,
    });

    expect(report.readinessState).toBe('INSUFFICIENT_TELEMETRY');
    expect(report.isReadyForExperiment).toBe(false);
    expect(report.gsc.factCount).toBe(0);
    expect(report.gsc.provenance).toBe('NONE');
    expect(report.blockingReasons.some((r) => r.includes('Zero persisted GSC facts'))).toBe(true);
  });

  it('reports INSUFFICIENT_TELEMETRY when persisted facts exist but are stale (> maxFreshnessDays)', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `stale-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain,
        name: 'Stale Facts Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const validPayload = JSON.stringify({
      accessToken: 'valid-access-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      email: 'owner@stale.org',
    });

    const integration = await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify(SecretVault.encrypt(validPayload)),
        connectedAccount: 'owner@stale.org',
      } as any,
    });

    await prisma.searchConsolePropertyBinding.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        providerPropertyId: `sc-domain:${domain}`,
        providerPropertyType: 'DOMAIN',
      } as any,
    });

    await prisma.integrationSyncRun.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        provider: 'GSC',
        dataset: 'SEARCH_ANALYTICS',
        requestedStartDate: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000),
        requestedEndDate: new Date(),
        status: 'COMPLETED',
        completedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000),
      } as any,
    });

    // Create 30-day old fact
    await prisma.gscSearchAnalyticsFact.create({
      data: {
        websiteId: website.id,
        grain: 'SITE_DAILY',
        date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        pageUrl: `https://${domain}`,
        clicks: 50,
        impressions: 1200,
        ctr: 0.041,
        position: 11.4,
        provenance: 'GOOGLE_SEARCH_CONSOLE',
      } as any,
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      maxFreshnessDays: 14,
      gscProvider: createMockGscProvider(),
      verifyLiveGoogleApi: true,
    });

    expect(report.readinessState).toBe('INSUFFICIENT_TELEMETRY');
    expect(report.gsc.isFresh).toBe(false);
    expect(report.gsc.freshnessDays).toBeGreaterThan(14);
    expect(report.blockingReasons.some((r) => r.includes('stale'))).toBe(true);
  });

  it('explicitly reports GA4 absence as NOT_CONFIGURED without synthesizing fake analytics', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `noga4-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-test',
        domain,
        name: 'No GA4 Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const validPayload = JSON.stringify({
      accessToken: 'valid-access-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      email: 'owner@noga4.org',
    });

    const integration = await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify(SecretVault.encrypt(validPayload)),
        connectedAccount: 'owner@noga4.org',
      } as any,
    });

    await prisma.searchConsolePropertyBinding.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        providerPropertyId: `sc-domain:${domain}`,
        providerPropertyType: 'DOMAIN',
      } as any,
    });

    await prisma.integrationSyncRun.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        provider: 'GSC',
        dataset: 'SEARCH_ANALYTICS',
        requestedStartDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        requestedEndDate: new Date(),
        status: 'COMPLETED',
        completedAt: new Date(),
      } as any,
    });

    await prisma.gscSearchAnalyticsFact.create({
      data: {
        websiteId: website.id,
        grain: 'SITE_DAILY',
        date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days old = fresh
        pageUrl: `https://${domain}`,
        clicks: 80,
        impressions: 2100,
        ctr: 0.038,
        position: 8.2,
        provenance: 'GOOGLE_SEARCH_CONSOLE',
      } as any,
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      gscProvider: createMockGscProvider(),
      verifyLiveGoogleApi: true,
    });

    expect(report.ga4.status).toBe('NOT_CONFIGURED');
    expect(report.ga4.isConfigured).toBe(false);
    expect(report.ga4.factCount).toBe(0);
    expect(report.ga4.provenance).toBe('NONE');
    expect(report.readinessState).toBe('LIVE_VERIFIED');
    expect(report.isReadyForExperiment).toBe(true);
  });

  it('achieves LIVE_VERIFIED when real GSC tokens, property, sync, and fresh facts exist', async () => {
    const unique = Math.random().toString(36).slice(2);
    const domain = `live-verified-${unique}.org`;
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-telemetry-live',
        domain,
        name: 'Live Verified Site',
        productionUrl: `https://${domain}`,
      } as any,
    });

    const validPayload = JSON.stringify({
      accessToken: 'valid-live-access-token',
      refreshToken: 'valid-live-refresh-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      scopes: [
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
      ],
      email: 'seo-ninja@live-verified.org',
    });

    const gscIntegration = await prisma.integration.create({
      data: {
        websiteId: website.id,
        provider: 'GSC',
        status: 'CONNECTED',
        encryptedCredentials: JSON.stringify(SecretVault.encrypt(validPayload)),
        connectedAccount: 'seo-ninja@live-verified.org',
        grantedScopes: [
          'https://www.googleapis.com/auth/webmasters.readonly',
          'https://www.googleapis.com/auth/analytics.readonly',
        ],
      } as any,
    });

    await prisma.searchConsolePropertyBinding.create({
      data: {
        websiteId: website.id,
        integrationId: gscIntegration.id,
        providerPropertyId: `sc-domain:${domain}`,
        providerPropertyType: 'DOMAIN',
        permissionLevel: 'siteOwner',
      } as any,
    });

    await prisma.integrationSyncRun.create({
      data: {
        websiteId: website.id,
        integrationId: gscIntegration.id,
        provider: 'GSC',
        dataset: 'SEARCH_ANALYTICS',
        requestedStartDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        requestedEndDate: new Date(),
        status: 'COMPLETED',
        completedAt: new Date(),
      } as any,
    });

    // Seed real GSC facts with GOOGLE_SEARCH_CONSOLE provenance
    await prisma.gscSearchAnalyticsFact.createMany({
      data: [
        {
          websiteId: website.id,
          grain: 'SITE_DAILY',
          date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day old
          pageUrl: `https://${domain}`,
          clicks: 120,
          impressions: 3400,
          ctr: 0.035,
          position: 7.8,
          provenance: 'GOOGLE_SEARCH_CONSOLE',
        },
        {
          websiteId: website.id,
          grain: 'SITE_DAILY',
          date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days old
          pageUrl: `https://${domain}`,
          clicks: 115,
          impressions: 3200,
          ctr: 0.036,
          position: 8.0,
          provenance: 'GOOGLE_SEARCH_CONSOLE',
        },
      ] as any,
    });

    const mockGscProvider = createMockGscProvider({
      listAccessibleProperties: vi.fn().mockResolvedValue([`sc-domain:${domain}`]),
      verifyPropertyAccess: vi.fn().mockResolvedValue({ accessible: true, permissionLevel: 'siteOwner' }),
    });

    const report = await TelemetryReadinessGate.evaluate({
      websiteUrl: `https://${domain}`,
      gscProvider: mockGscProvider,
      verifyLiveGoogleApi: true,
    });

    expect(report.readinessState).toBe('LIVE_VERIFIED');
    expect(report.isReadyForExperiment).toBe(true);
    expect(report.blockingReasons).toHaveLength(0);
    expect(report.gsc.status).toBe('LIVE_VERIFIED');
    expect(report.gsc.isFresh).toBe(true);
    expect(report.gsc.factCount).toBe(2);
    expect(report.gsc.provenance).toBe('GOOGLE_SEARCH_CONSOLE');
    expect(report.baseline.available).toBe(true);
    expect(report.baseline.provenance).toBe('GOOGLE_SEARCH_CONSOLE');
    expect(report.baseline.clicks).toBe(235);
    expect(report.baseline.impressions).toBe(6600);
  });
});
