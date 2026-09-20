import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createApp } from '../server/app';
import { prisma } from '../server/db/prisma';
import { IntegrationProvider, IntegrationStatus } from '@prisma/client';

describe('Google Integration & Subsystem Health Endpoint', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns the exact health status structure for GSC, GA4, Database, and Encryption', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/google/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('GSC');
    expect(['CONNECTED', 'DISCONNECTED']).toContain(body.GSC);

    expect(body).toHaveProperty('GA4');
    expect(['CONNECTED', 'DISCONNECTED']).toContain(body.GA4);

    expect(body).toHaveProperty('Database');
    expect(['READY', 'ERROR']).toContain(body.Database);

    expect(body).toHaveProperty('Encryption');
    expect(['READY', 'ERROR']).toContain(body.Encryption);
  });

  it('reflects CONNECTED status when a valid GSC integration is registered', async () => {
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-health-test',
        domain: 'gsc-test.org',
        name: 'GSC Health Test',
        productionUrl: 'https://gsc-test.org',
      } as any,
    });

    await prisma.integration.create({
      data: {
        workspaceId: 'ws-health-test',
        websiteId: website.id,
        provider: IntegrationProvider.GSC,
        status: IntegrationStatus.CONNECTED,
        accountIdentifier: 'seo-lead@gsc-test.org',
        connectedAccount: 'seo-lead@gsc-test.org',
      } as any,
    });

    const res = await fetch(`${baseUrl}/api/integrations/google/health?websiteId=${website.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.GSC).toBe('CONNECTED');
    expect(body.details.gsc.accountEmail).toBe('seo-lead@gsc-test.org');
  });

  it('reflects CONNECTED status when a valid GA4 integration is registered', async () => {
    const website = await prisma.website.create({
      data: {
        workspaceId: 'ws-health-ga4',
        domain: 'ga4-test.org',
        name: 'GA4 Health Test',
        productionUrl: 'https://ga4-test.org',
      } as any,
    });

    const integration = await prisma.integration.create({
      data: {
        workspaceId: 'ws-health-ga4',
        websiteId: website.id,
        provider: IntegrationProvider.GA4,
        status: IntegrationStatus.CONNECTED,
        accountIdentifier: 'analytics-lead@ga4-test.org',
      } as any,
    });

    await prisma.ga4PropertyBinding.create({
      data: {
        websiteId: website.id,
        integrationId: integration.id,
        providerPropertyId: 'properties/987654321',
        providerAccountId: 'accounts/12345',
        providerAccountName: 'Test Account',
        providerDisplayName: 'Test Property',
        timeZone: 'UTC',
        currencyCode: 'USD',
      } as any,
    });

    const res = await fetch(`${baseUrl}/api/integrations/google/health?websiteId=${website.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.GA4).toBe('CONNECTED');
    expect(body.details.ga4.propertyId).toBe('properties/987654321');
  });


  it('exposes alias routes consistently at /api/health/google and /api/integrations/health', async () => {
    const res1 = await fetch(`${baseUrl}/api/health/google`);
    const res2 = await fetch(`${baseUrl}/api/integrations/health`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const data1 = await res1.json();
    const data2 = await res2.json();

    expect(data1).toHaveProperty('GSC');
    expect(data1).toHaveProperty('GA4');
    expect(data1).toHaveProperty('Database');
    expect(data1).toHaveProperty('Encryption');

    expect(data2).toHaveProperty('GSC');
    expect(data2).toHaveProperty('GA4');
    expect(data2).toHaveProperty('Database');
    expect(data2).toHaveProperty('Encryption');
  });
});
