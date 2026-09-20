import { Router, Request, Response } from 'express';
import { prisma } from '../db/prisma';
import { GoogleOAuthClient } from '../services/integrations/providers/googleOAuthClient';
import { GoogleIntegrationRepository } from '../repositories/googleIntegrationRepository';
import { GoogleSearchConsoleProvider } from '../services/integrations/providers/googleSearchConsoleProvider';
import { GoogleAnalytics4Provider } from '../services/integrations/providers/googleAnalytics4Provider';
import { SyncQueueProducer } from '../queues/syncQueueProducer';
import { AnalyticsRepository } from '../repositories/analyticsRepository';
import { PeriodComparisonEngine } from '../services/analytics/periodComparisonEngine';
import { requireWebsiteAccess, requireWorkspaceAuth } from '../security/authMiddleware';
import { WebsiteRepository } from '../repositories/websiteRepository';
import { GoogleHealthService } from '../services/integrations/googleHealthService';

export const integrationRoutes = Router();

/**
 * Health endpoint for Google integrations, Database availability, and Encryption subsystem.
 * Returns { GSC: 'CONNECTED' | 'DISCONNECTED', GA4: 'CONNECTED' | 'DISCONNECTED', Database: 'READY' | 'ERROR', Encryption: 'READY' | 'ERROR' }
 */
integrationRoutes.get('/google/health', async (req: Request, res: Response) => {
  try {
    const websiteId = (req.query.websiteId as string) || undefined;
    const health = await GoogleHealthService.getHealth({ websiteId });
    return res.status(200).json(health);
  } catch (err: any) {
    return res.status(500).json({
      GSC: 'DISCONNECTED',
      GA4: 'DISCONNECTED',
      Database: 'ERROR',
      Encryption: 'ERROR',
      error: err?.message || String(err),
    });
  }
});


/**
 * Initiates the Google OAuth authorization flow.
 * Protected by workspace authorization; derives identity strictly from req.principal.
 */
integrationRoutes.get('/google/auth-url', requireWorkspaceAuth('VIEWER'), async (req: Request, res: Response) => {
  try {
    const principal = req.principal!;
    const websiteId = (req.query.websiteId as string) || undefined;
    const workspaceId = req.workspaceId || principal.workspaceMemberships[0]?.workspaceId || 'default-workspace';
    const userId = principal.userId;

    // If websiteId is specified, verify tenant membership has access to this website
    if (websiteId) {
      const website = await WebsiteRepository.findGlobalById(websiteId);
      if (!website || (website.workspaceId !== workspaceId && !principal.isSystemAdmin)) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: `Website with ID '${websiteId}' was not found in the active workspace.`,
        });
      }
    }

    if (!GoogleOAuthClient.isConfigured()) {
      return res.status(200).json({
        configured: false,
        status: 'NOT_CONFIGURED',
        error: 'GOOGLE_INTEGRATION_NOT_CONFIGURED',
        message: 'Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not configured in this environment.',
      });
    }

    const state = GoogleOAuthClient.generateState();
    const { codeVerifier, codeChallenge } = GoogleOAuthClient.generatePkce();
    const redirectUri = GoogleOAuthClient.getRedirectUri();

    await GoogleIntegrationRepository.createOAuthStateSession({
      state,
      codeVerifier,
      workspaceId,
      userId,
      websiteId,
      redirectUri,
      expiresInMinutes: 15,
    });

    const authUrl = GoogleOAuthClient.generateAuthUrl({
      state,
      codeChallenge,
      redirectUri,
    });

    return res.json({ configured: true, authUrl, state, redirectUri });
  } catch (err: any) {
    return res.status(500).json({ error: 'FAILED_TO_GENERATE_AUTH_URL', message: err.message });
  }
});

/**
 * Google OAuth 2.0 Callback handler.
 */
integrationRoutes.get('/google/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      return res.redirect(`/?authError=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'MISSING_CODE_OR_STATE', message: 'Missing authorization code or state.' });
    }

    // Consume state session safely (single-use, atomic)
    const session = await GoogleIntegrationRepository.consumeOAuthStateSession(state);

    // Exchange tokens
    const tokens = await GoogleOAuthClient.exchangeCodeForTokens({
      code,
      codeVerifier: session.codeVerifier || undefined,
      redirectUri: session.redirectUri,
    });

    // Verify token info & get email
    const tokenInfo = await GoogleOAuthClient.verifyTokenInfo(tokens.accessToken);

    if (session.websiteId) {
      await GoogleIntegrationRepository.saveGoogleConnection({
        websiteId: session.websiteId,
        tokens,
        accountEmail: tokenInfo.email,
        scopes: tokenInfo.scopes,
      });
      return res.redirect(`/settings?tab=integrations&status=connected&email=${encodeURIComponent(tokenInfo.email || '')}`);
    }

    return res.json({
      success: true,
      email: tokenInfo.email,
      scopes: tokenInfo.scopes,
      message: 'Google authorization succeeded.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: 'GOOGLE_AUTH_CALLBACK_FAILED', message: err.message });
  }
});

/**
 * Lists Search Console properties accessible for the connected website.
 */
integrationRoutes.get(
  '/websites/:websiteId/gsc/properties',
  requireWebsiteAccess('VIEWER'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const { accessToken } = await GoogleIntegrationRepository.getValidAccessToken(websiteId, 'GSC');

      const provider = new GoogleSearchConsoleProvider();
      const properties = await provider.listAccessibleProperties(accessToken);

      const currentBinding = await prisma.searchConsolePropertyBinding.findUnique({
        where: { websiteId },
      });

      return res.json({ properties, currentBinding });
    } catch (err: any) {
      return res.status(500).json({ error: 'GSC_PROPERTIES_FETCH_FAILED', message: err.message });
    }
  }
);

/**
 * Binds a selected GSC property to the website.
 */
integrationRoutes.post(
  '/websites/:websiteId/gsc/bind',
  requireWebsiteAccess('EDITOR'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const { propertyId, propertyType, permissionLevel } = req.body;

      if (!propertyId) {
        return res.status(400).json({ error: 'MISSING_PROPERTY_ID', message: 'propertyId is required.' });
      }

      const { accessToken } = await GoogleIntegrationRepository.getValidAccessToken(websiteId, 'GSC');
      const provider = new GoogleSearchConsoleProvider();

      const verification = await provider.verifyPropertyAccess(accessToken, propertyId);
      if (!verification.accessible) {
        return res.status(403).json({ error: 'PROPERTY_NOT_ACCESSIBLE', message: verification.error });
      }

      const binding = await GoogleIntegrationRepository.bindGscProperty({
        websiteId,
        providerPropertyId: propertyId,
        providerPropertyType: propertyType || (propertyId.startsWith('sc-domain:') ? 'DOMAIN' : 'URL_PREFIX'),
        permissionLevel: permissionLevel || verification.permissionLevel,
      });

      // Trigger background initial backfill via worker queue
      try {
        await SyncQueueProducer.enqueueSync({
          websiteId,
          provider: 'GSC',
          syncType: 'INITIAL_BACKFILL',
        });
      } catch (qErr: any) {
        console.warn('[SyncQueueProducer] Warning queuing initial GSC sync:', qErr.message);
      }

      return res.json({ success: true, binding });
    } catch (err: any) {
      return res.status(500).json({ error: 'GSC_BINDING_FAILED', message: err.message });
    }
  }
);

/**
 * Lists GA4 properties accessible for the connected website.
 */
integrationRoutes.get(
  '/websites/:websiteId/ga4/properties',
  requireWebsiteAccess('VIEWER'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const { accessToken } = await GoogleIntegrationRepository.getValidAccessToken(websiteId, 'GA4');

      const provider = new GoogleAnalytics4Provider();
      const result = await provider.listAccessibleAccountsAndProperties(accessToken);

      const currentBinding = await prisma.ga4PropertyBinding.findUnique({
        where: { websiteId },
      });

      return res.json({ ...result, currentBinding });
    } catch (err: any) {
      return res.status(500).json({ error: 'GA4_PROPERTIES_FETCH_FAILED', message: err.message });
    }
  }
);

/**
 * Binds a selected GA4 property to the website.
 */
integrationRoutes.post(
  '/websites/:websiteId/ga4/bind',
  requireWebsiteAccess('EDITOR'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const { propertyId, accountId, accountName, displayName, timeZone, currencyCode } = req.body;

      if (!propertyId) {
        return res.status(400).json({ error: 'MISSING_PROPERTY_ID', message: 'propertyId is required.' });
      }

      const { accessToken } = await GoogleIntegrationRepository.getValidAccessToken(websiteId, 'GA4');
      const provider = new GoogleAnalytics4Provider();

      const verification = await provider.verifyPropertyAccess(accessToken, propertyId);
      if (!verification.accessible) {
        return res.status(403).json({ error: 'GA4_PROPERTY_NOT_ACCESSIBLE', message: verification.error });
      }

      const binding = await GoogleIntegrationRepository.bindGa4Property({
        websiteId,
        providerPropertyId: propertyId,
        providerAccountId: accountId,
        providerAccountName: accountName,
        providerDisplayName: displayName,
        timeZone: timeZone || verification.timeZone || 'UTC',
        currencyCode: currencyCode || verification.currencyCode || 'USD',
      });

      // Trigger background initial GA4 backfill via worker queue
      try {
        await SyncQueueProducer.enqueueSync({
          websiteId,
          provider: 'GA4',
          syncType: 'INITIAL_BACKFILL',
        });
      } catch (qErr: any) {
        console.warn('[SyncQueueProducer] Warning queuing initial GA4 sync:', qErr.message);
      }

      return res.json({ success: true, binding });
    } catch (err: any) {
      return res.status(500).json({ error: 'GA4_BINDING_FAILED', message: err.message });
    }
  }
);

/**
 * Triggers an asynchronous sync job for GSC, GA4, or both via BullMQ background worker queue.
 */
integrationRoutes.post(
  '/websites/:websiteId/sync',
  requireWebsiteAccess('EDITOR'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const { provider = 'ALL', syncType = 'MANUAL_RESYNC', startDate, endDate, correlationId } = req.body;

      const jobId = await SyncQueueProducer.enqueueSync({
        websiteId,
        provider: provider as 'GSC' | 'GA4' | 'ALL',
        syncType,
        startDate,
        endDate,
        correlationId,
      });

      return res.status(202).json({
        success: true,
        queued: true,
        jobId,
        message: `Sync job for provider '${provider}' successfully queued.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'SYNC_TRIGGER_FAILED', message: err.message });
    }
  }
);

/**
 * Returns recent integration sync runs for the website.
 */
integrationRoutes.get(
  '/websites/:websiteId/sync-runs',
  requireWebsiteAccess('VIEWER'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const syncRuns = await prisma.integrationSyncRun.findMany({
        where: { websiteId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return res.json({ syncRuns });
    } catch (err: any) {
      return res.status(500).json({ error: 'SYNC_RUNS_FETCH_FAILED', message: err.message });
    }
  }
);

/**
 * Disconnects Google integration for the website.
 */
integrationRoutes.post(
  '/websites/:websiteId/google/disconnect',
  requireWebsiteAccess('EDITOR'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      await GoogleIntegrationRepository.disconnectGoogle(websiteId);
      return res.json({ success: true, message: 'Google integration successfully disconnected.' });
    } catch (err: any) {
      return res.status(500).json({ error: 'DISCONNECT_FAILED', message: err.message });
    }
  }
);

/**
 * Comprehensive Analytics & Performance Reporting Endpoint.
 */
integrationRoutes.get(
  '/websites/:websiteId/analytics/performance',
  requireWebsiteAccess('VIEWER'),
  async (req: Request, res: Response) => {
    try {
      const { websiteId } = req.params;
      const now = new Date();

      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date(now.getTime() - 86400000);
      const startDate = req.query.startDate
        ? new Date(req.query.startDate as string)
        : new Date(endDate.getTime() - 27 * 86400000);

      const [
        gscTotals,
        ga4Totals,
        timeSeries,
        topQueries,
        topPages,
        comparison,
      ] = await Promise.all([
        AnalyticsRepository.getGscTotals(websiteId, startDate, endDate),
        AnalyticsRepository.getGa4Totals(websiteId, startDate, endDate),
        AnalyticsRepository.getGscTimeSeries(websiteId, startDate, endDate),
        AnalyticsRepository.getTopQueries(websiteId, startDate, endDate, 50),
        AnalyticsRepository.getTopPages(websiteId, startDate, endDate, 50),
        PeriodComparisonEngine.comparePeriods({
          websiteId,
          currentStart: startDate,
          currentEnd: endDate,
        }),
      ]);

      const integration = await prisma.integration.findUnique({
        where: {
          websiteId_provider: {
            websiteId,
            provider: 'GSC',
          },
        },
        include: {
          gscBindings: true,
          ga4Bindings: true,
        },
      });

      return res.json({
        integrationStatus: integration?.status || 'NOT_CONFIGURED',
        connectedAccount: integration?.connectedAccount,
        gscBound: (integration?.gscBindings?.length || 0) > 0,
        ga4Bound: (integration?.ga4Bindings?.length || 0) > 0,
        window: {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
        },
        gscTotals,
        ga4Totals,
        timeSeries,
        topQueries,
        topPages,
        comparison,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'ANALYTICS_FETCH_FAILED', message: err.message });
    }
  }
);

/**
 * CSV export
 */
integrationRoutes.post('/export-csv', requireWorkspaceAuth('VIEWER'), async (req: Request, res: Response) => {
  try {
    const { items, type = 'tasks' } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array required' });
    }
    let csv = '';
    if (items.length > 0) {
      const headers = Object.keys(items[0]);
      csv = headers.join(',') + '\n';
      for (const item of items) {
        const row = headers.map((h) => `"${String(item[h] ?? '').replace(/"/g, '""')}"`).join(',');
        csv += row + '\n';
      }
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=seo-${type}-export.csv`);
    return res.send(csv);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * WordPress export
 */
integrationRoutes.post('/export-wordpress', requireWorkspaceAuth('EDITOR'), async (req: Request, res: Response) => {
  try {
    const { title, content, status = 'draft' } = req.body;
    return res.json({
      success: true,
      message: 'Draft staged for WordPress push.',
      payload: { title, status, length: content?.length || 0 },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default integrationRoutes;
