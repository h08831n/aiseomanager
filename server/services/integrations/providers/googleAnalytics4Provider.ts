import {
  AnalyticsProvider,
  Ga4Account,
  Ga4Property,
  Ga4ReportOptions,
  Ga4BatchResult,
  Ga4Row,
} from './analyticsProvider';

export class GoogleAnalytics4Provider implements AnalyticsProvider {
  private static readonly ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
  private static readonly DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        const res = await fetch(url, init);
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          if (attempt >= maxRetries) return res;
          const retryAfterHeader = res.headers.get('retry-after');
          const delayMs = retryAfterHeader
            ? parseInt(retryAfterHeader, 10) * 1000 || 2000
            : Math.min(10000, 1000 * Math.pow(2, attempt) + Math.random() * 500);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        return res;
      } catch (networkErr: any) {
        if (attempt >= maxRetries) throw networkErr;
        const delayMs = Math.min(10000, 1000 * Math.pow(2, attempt) + Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return fetch(url, init);
  }

  /**
   * Lists all Google Analytics 4 accounts and properties accessible to the authenticated user.
   * Follows pagination tokens to ensure exhaustive discovery.
   */
  public async listAccessibleAccountsAndProperties(
    accessToken: string
  ): Promise<{ accounts: Ga4Account[]; properties: Ga4Property[] }> {
    const accounts: Ga4Account[] = [];
    const properties: Ga4Property[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const url = `${GoogleAnalytics4Provider.ADMIN_API_BASE}/accountSummaries?pageSize=200${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
      }`;
      const res = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        if (res.status === 401) {
          throw new Error(`GA4_AUTH_REVOKED (401): Google Analytics access token invalid: ${err}`);
        }
        if (res.status === 403) {
          throw new Error(`GA4_INSUFFICIENT_SCOPE (403): User lacks analytics.readonly scope: ${err}`);
        }
        if (res.status === 429) {
          throw new Error(`GA4_RATE_LIMITED (429): Google Analytics Admin API quota exceeded: ${err}`);
        }
        throw new Error(`GA4_API_ERROR (${res.status}): Failed to list GA4 accounts and properties: ${err}`);
      }

      const data = (await res.json()) as any;
      const summaries = data.accountSummaries || [];

      for (const acc of summaries) {
        const accountName = acc.account || acc.name || '';
        const accountId = accountName.replace('accounts/', '');
        if (!accounts.some((a) => a.id === accountName)) {
          accounts.push({
            id: accountName,
            name: accountName,
            displayName: acc.displayName || `Account ${accountId}`,
          });
        }

        const propSummaries = acc.propertySummaries || [];
        for (const prop of propSummaries) {
          const fullPropName = prop.property || ''; // "properties/123456789"
          const cleanId = fullPropName.replace('properties/', '');
          if (!properties.some((p) => p.propertyId === cleanId)) {
            properties.push({
              id: fullPropName,
              propertyId: cleanId,
              displayName: prop.displayName || `Property ${cleanId}`,
              parentAccount: accountName,
              timeZone: 'UTC', // Default until metadata query
              currencyCode: 'USD',
              propertyType: prop.propertyType || 'PROPERTY_TYPE_ORDINARY',
            });
          }
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return { accounts, properties };
  }

  /**
   * Executes a GA4 Data API v1 runReport request.
   */
  public async runReport(
    accessToken: string,
    propertyId: string,
    options: Ga4ReportOptions
  ): Promise<Ga4BatchResult> {
    const cleanId = propertyId.replace(/^properties\//, '');
    const url = `${GoogleAnalytics4Provider.DATA_API_BASE}/properties/${cleanId}:runReport`;

    const limit = Math.min(options.limit || 10000, 100000);
    const offset = options.offset || 0;

    const payload: Record<string, any> = {
      dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
      dimensions: options.dimensions.map((name) => ({ name })),
      metrics: options.metrics.map((name) => ({ name })),
      limit,
      offset,
      keepEmptyRows: options.keepEmptyRows ?? false,
    };

    if (options.dimensionFilter) {
      payload.dimensionFilter = options.dimensionFilter;
    }
    if (options.metricFilter) {
      payload.metricFilter = options.metricFilter;
    }

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new Error(`GA4_AUTH_REVOKED (401): GA4 access token invalid: ${err}`);
      }
      if (res.status === 403) {
        throw new Error(`GA4_INSUFFICIENT_SCOPE (403): Permission denied for property ${propertyId}: ${err}`);
      }
      if (res.status === 404) {
        throw new Error(`GA4_PROPERTY_NOT_FOUND (404): GA4 property '${propertyId}' not found: ${err}`);
      }
      if (res.status === 429) {
        throw new Error(`GA4_RATE_LIMITED (429): GA4 Data API quota exceeded: ${err}`);
      }
      throw new Error(`GA4_REPORT_FAILED (${res.status}): GA4 runReport failed: ${err}`);
    }

    const data = (await res.json()) as any;
    const dimensionHeaders = data.dimensionHeaders || [];
    const metricHeaders = data.metricHeaders || [];
    const rawRows = data.rows || [];
    const totalRowsReported = data.rowCount || rawRows.length;
    const metadata = data.metadata || {};

    const rows: Ga4Row[] = rawRows.map((r: any) => ({
      dimensionValues: (r.dimensionValues || []).map((dv: any) => dv.value || ''),
      metricValues: (r.metricValues || []).map((mv: any) => parseFloat(mv.value || '0')),
    }));

    const hasMore = rows.length === limit && offset + rows.length < totalRowsReported;
    const nextOffset = hasMore ? offset + rows.length : undefined;

    return {
      dimensionHeaders,
      metricHeaders,
      rows,
      rowCount: rows.length,
      totalRowsReported,
      isComplete: !hasMore,
      hasMore,
      nextOffset,
      timeZone: metadata.timeZone || 'UTC',
      currencyCode: metadata.currencyCode || 'USD',
      retrievedAt: new Date().toISOString(),
      provenance: 'GOOGLE_ANALYTICS',
      samplingMetadata: metadata.samplingMetadatas,
      subjectToThresholding: metadata.subjectToThresholding || false,
      dataLossFromOtherRow: metadata.dataLossFromOtherRow || false,
    };
  }

  /**
   * Validates access to the specified GA4 property.
   */
  public async verifyPropertyAccess(
    accessToken: string,
    propertyId: string
  ): Promise<{ accessible: boolean; propertyName?: string; timeZone?: string; currencyCode?: string; error?: string }> {
    try {
      const cleanId = propertyId.replace(/^properties\//, '');
      const testReport = await this.runReport(accessToken, cleanId, {
        startDate: 'yesterday',
        endDate: 'yesterday',
        dimensions: ['date'],
        metrics: ['sessions'],
        limit: 1,
      });

      return {
        accessible: true,
        propertyName: `properties/${cleanId}`,
        timeZone: testReport.timeZone,
        currencyCode: testReport.currencyCode,
      };
    } catch (err: any) {
      return {
        accessible: false,
        error: err.message || 'Failed to access GA4 property.',
      };
    }
  }

  /**
   * Retrieves verified organic search performance metrics from GA4:
   * - organic sessions
   * - conversions (key events)
   * - revenue events (purchase revenue)
   */
  public async queryOrganicPerformance(
    accessToken: string,
    propertyId: string,
    options: {
      startDate: string;
      endDate: string;
      landingPageUrl?: string;
      limit?: number;
    }
  ): Promise<{
    organicSessions: number;
    conversions: number;
    revenueEvents: number;
    currencyCode: string;
    landingPages: {
      landingPageUrl: string;
      sessions: number;
      conversions: number;
      revenue: number;
    }[];
    provenance: 'GOOGLE_ANALYTICS';
    retrievedAt: string;
  }> {
    const cleanId = propertyId.replace(/^properties\//, '');

    const dimensionFilter = options.landingPageUrl
      ? {
          andGroup: {
            expressions: [
              {
                filter: {
                  fieldName: 'sessionDefaultChannelGroup',
                  stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
                },
              },
              {
                filter: {
                  fieldName: 'landingPagePlusQueryString',
                  stringFilter: { matchType: 'CONTAINS', value: options.landingPageUrl },
                },
              },
            ],
          },
        }
      : {
          filter: {
            fieldName: 'sessionDefaultChannelGroup',
            stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
          },
        };

    const report = await this.runReport(accessToken, cleanId, {
      startDate: options.startDate,
      endDate: options.endDate,
      dimensions: ['landingPagePlusQueryString'],
      metrics: ['sessions', 'conversions', 'purchaseRevenue'],
      dimensionFilter,
      limit: options.limit || 100,
    });

    let totalSessions = 0;
    let totalConversions = 0;
    let totalRevenue = 0;

    const landingPages = report.rows.map((row) => {
      const pageUrl = row.dimensionValues[0] || '';
      const sessions = row.metricValues[0] || 0;
      const conversions = row.metricValues[1] || 0;
      const revenue = row.metricValues[2] || 0;

      totalSessions += sessions;
      totalConversions += conversions;
      totalRevenue += revenue;

      return {
        landingPageUrl: pageUrl,
        sessions,
        conversions,
        revenue,
      };
    });

    return {
      organicSessions: totalSessions,
      conversions: totalConversions,
      revenueEvents: totalRevenue,
      currencyCode: report.currencyCode,
      landingPages,
      provenance: 'GOOGLE_ANALYTICS',
      retrievedAt: new Date().toISOString(),
    };
  }
}
