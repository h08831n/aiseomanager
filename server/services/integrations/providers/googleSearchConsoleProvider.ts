import {
  SearchConsoleProvider,
  SearchConsoleProperty,
  SearchAnalyticsQueryOptions,
  SearchAnalyticsBatchResult,
  SearchAnalyticsRow,
} from './searchConsoleProvider';

export class GoogleSearchConsoleProvider implements SearchConsoleProvider {
  private static readonly API_BASE = 'https://www.googleapis.com/webmasters/v3';

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        const res = await fetch(url, init);
        // Only retry on server errors (500, 502, 503, 504)
        if (res.status >= 500 && res.status <= 599 && attempt < maxRetries) {
          const delayMs = Math.min(2000, 200 * Math.pow(2, attempt));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        return res;
      } catch (networkErr: any) {
        if (attempt >= maxRetries) throw networkErr;
        const delayMs = Math.min(2000, 200 * Math.pow(2, attempt));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return fetch(url, init);
  }

  /**
   * Discovers all Search Console sites/properties accessible by the user.
   */
  public async listAccessibleProperties(accessToken: string): Promise<SearchConsoleProperty[]> {
    const url = `${GoogleSearchConsoleProvider.API_BASE}/sites`;
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
        throw new Error(`GSC_AUTH_REVOKED (401): Access token invalid or expired: ${err}`);
      }
      if (res.status === 403) {
        throw new Error(`GSC_INSUFFICIENT_SCOPE (403): User lacks required Search Console permissions: ${err}`);
      }
      if (res.status === 429) {
        throw new Error(`GSC_RATE_LIMITED (429): Search Console API quota exceeded: ${err}`);
      }
      throw new Error(`GSC_API_ERROR (${res.status}): Failed to list Search Console properties: ${err}`);
    }

    const data = (await res.json()) as any;
    const siteEntries = data.siteEntry || [];

    return siteEntries.map((entry: any) => {
      const siteUrl = entry.siteUrl || '';
      const isDomain = siteUrl.startsWith('sc-domain:');
      return {
        siteUrl,
        permissionLevel: entry.permissionLevel || 'siteRestrictedUser',
        propertyType: isDomain ? 'DOMAIN' : 'URL_PREFIX',
      };
    });
  }

  /**
   * Queries search performance analytics from the Google Search Console API.
   */
  public async querySearchAnalytics(
    accessToken: string,
    propertyId: string,
    options: SearchAnalyticsQueryOptions
  ): Promise<SearchAnalyticsBatchResult> {
    const encodedProperty = encodeURIComponent(propertyId);
    const url = `${GoogleSearchConsoleProvider.API_BASE}/sites/${encodedProperty}/searchAnalytics/query`;

    const rowLimit = Math.min(options.rowLimit || 25000, 25000);
    const startRow = options.startRow || 0;

    const payload: Record<string, any> = {
      startDate: options.startDate,
      endDate: options.endDate,
      rowLimit,
      startRow,
    };

    if (options.dimensions && options.dimensions.length > 0) {
      payload.dimensions = options.dimensions;
    }

    if (options.searchType) {
      payload.type = options.searchType;
    }

    if (options.dataState) {
      if (options.dataState === 'hourly') {
        payload.dataState = 'hourly_all';
      } else {
        payload.dataState = options.dataState;
      }
    }

    if (options.aggregationType) {
      payload.aggregationType = options.aggregationType;
    }

    if (options.dimensionFilterGroups && options.dimensionFilterGroups.length > 0) {
      payload.dimensionFilterGroups = options.dimensionFilterGroups;
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
        throw new Error(`GSC_AUTH_REVOKED (401): Search Console access token invalid: ${err}`);
      }
      if (res.status === 403) {
        throw new Error(`GSC_INSUFFICIENT_SCOPE (403): Search Console permission denied for property ${propertyId}: ${err}`);
      }
      if (res.status === 404) {
        throw new Error(`GSC_PROPERTY_NOT_FOUND (404): Search Console property '${propertyId}' not found: ${err}`);
      }
      if (res.status === 429) {
        throw new Error(`GSC_RATE_LIMITED (429): Search Console API quota exceeded: ${err}`);
      }
      throw new Error(`GSC_QUERY_FAILED (${res.status}): Search Console searchAnalytics query failed: ${err}`);
    }

    const data = (await res.json()) as any;
    const rawRows = data.rows || [];
    const responseAggregationType = data.responseAggregationType;

    const parsedRows: SearchAnalyticsRow[] = rawRows.map((r: any) => {
      const keys: string[] = r.keys || [];
      const rowObj: SearchAnalyticsRow = {
        keys,
        clicks: Math.round(r.clicks || 0),
        impressions: Math.round(r.impressions || 0),
        ctr: typeof r.ctr === 'number' ? r.ctr : 0,
        position: typeof r.position === 'number' ? r.position : 0,
      };

      if (options.dimensions) {
        options.dimensions.forEach((dim, idx) => {
          const val = keys[idx] || '';
          if (dim === 'date') rowObj.date = val;
          else if (dim === 'query') rowObj.query = val;
          else if (dim === 'page') rowObj.page = val;
          else if (dim === 'country') rowObj.country = val;
          else if (dim === 'device') rowObj.device = val;
          else if (dim === 'searchAppearance') rowObj.searchAppearance = val;
        });
      }

      return rowObj;
    });

    const hasMore = parsedRows.length === rowLimit;
    const nextStartRow = hasMore ? startRow + parsedRows.length : undefined;

    let dataStateResult: 'FINALIZED' | 'FRESH' | 'HOURLY_PARTIAL' = 'FINALIZED';
    if (options.dataState === 'all') {
      dataStateResult = 'FRESH';
    } else if (options.dataState === 'hourly' || payload.dataState === 'hourly_all') {
      dataStateResult = 'HOURLY_PARTIAL';
    }

    const isSiteAggregateOnly = !options.dimensions || (options.dimensions.length === 1 && options.dimensions[0] === 'date');

    return {
      rows: parsedRows,
      totalRows: parsedRows.length,
      responseAggregationType,
      dataState: dataStateResult,
      isComplete: isSiteAggregateOnly ? true : !hasMore,
      completenessStatus: isSiteAggregateOnly
        ? 'AUTHORITATIVE_AGGREGATE'
        : !hasMore
        ? 'PAGINATION_EXHAUSTED'
        : 'TOP_ROWS_PROVIDER_LIMITED',
      hasMore,
      nextStartRow,
      retrievedAt: new Date().toISOString(),
      provenance: 'MEASURED_PROVIDER',
    };
  }

  /**
   * Verifies that the given property is accessible by the credentials.
   */
  public async verifyPropertyAccess(
    accessToken: string,
    propertyId: string
  ): Promise<{ accessible: boolean; permissionLevel?: string; propertyType?: string; error?: string }> {
    try {
      const properties = await this.listAccessibleProperties(accessToken);
      const cleanTarget = propertyId.toLowerCase().trim();
      const matched = properties.find(
        (p) =>
          p.siteUrl.toLowerCase() === cleanTarget ||
          p.siteUrl.toLowerCase() === `sc-domain:${cleanTarget}` ||
          cleanTarget === `sc-domain:${p.siteUrl.toLowerCase()}`
      );

      if (!matched) {
        return {
          accessible: false,
          error: `Property '${propertyId}' was not found in the accessible properties for this Google account.`,
        };
      }

      return {
        accessible: true,
        permissionLevel: matched.permissionLevel,
        propertyType: matched.propertyType,
      };
    } catch (err: any) {
      return {
        accessible: false,
        error: err.message || 'Failed to verify property access.',
      };
    }
  }

  /**
   * High-level query retrieving all 6 core GSC search performance metrics:
   * queries, pages, clicks, impressions, CTR, and average position.
   */
  public async querySearchPerformanceMetrics(
    accessToken: string,
    propertyId: string,
    options: {
      startDate: string;
      endDate: string;
      pageUrl?: string;
      query?: string;
      dimensions?: ('query' | 'page' | 'date' | 'country' | 'device')[];
      rowLimit?: number;
    }
  ): Promise<{
    rows: {
      query?: string;
      page?: string;
      date?: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }[];
    totals: {
      clicks: number;
      impressions: number;
      ctr: number;
      averagePosition: number;
      totalQueries: number;
      totalPages: number;
    };
    provenance: 'GOOGLE_SEARCH_CONSOLE';
    retrievedAt: string;
  }> {
    const dimensionFilterGroups: any[] = [];
    if (options.pageUrl) {
      dimensionFilterGroups.push({
        filters: [
          {
            dimension: 'page',
            operator: 'contains',
            expression: options.pageUrl,
          },
        ],
      });
    }
    if (options.query) {
      dimensionFilterGroups.push({
        filters: [
          {
            dimension: 'query',
            operator: 'contains',
            expression: options.query,
          },
        ],
      });
    }

    const dimensions = options.dimensions || ['query', 'page', 'date'];

    const result = await this.querySearchAnalytics(accessToken, propertyId, {
      startDate: options.startDate,
      endDate: options.endDate,
      dimensions,
      dimensionFilterGroups: dimensionFilterGroups.length > 0 ? dimensionFilterGroups : undefined,
      rowLimit: options.rowLimit || 1000,
    });

    let totalClicks = 0;
    let totalImpressions = 0;
    let weightedPositionSum = 0;
    const uniqueQueries = new Set<string>();
    const uniquePages = new Set<string>();

    const rows = result.rows.map((r) => {
      totalClicks += r.clicks;
      totalImpressions += r.impressions;
      weightedPositionSum += r.position * r.impressions;

      if (r.query) uniqueQueries.add(r.query);
      if (r.page) uniquePages.add(r.page);

      return {
        query: r.query,
        page: r.page,
        date: r.date,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      };
    });

    const averagePosition =
      totalImpressions > 0
        ? Number((weightedPositionSum / totalImpressions).toFixed(2))
        : rows.length > 0
        ? Number((rows.reduce((acc, r) => acc + r.position, 0) / rows.length).toFixed(2))
        : 0;

    const overallCtr =
      totalImpressions > 0 ? Number(((totalClicks / totalImpressions) * 100).toFixed(2)) : 0;

    return {
      rows,
      totals: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: overallCtr,
        averagePosition,
        totalQueries: uniqueQueries.size,
        totalPages: uniquePages.size,
      },
      provenance: 'GOOGLE_SEARCH_CONSOLE',
      retrievedAt: new Date().toISOString(),
    };
  }
}
