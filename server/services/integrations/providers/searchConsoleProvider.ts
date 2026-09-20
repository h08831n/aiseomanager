import { MetricProvenanceSource } from '../../provenance/provenanceTypes';

export interface SearchConsoleProperty {
  siteUrl: string; // e.g. "sc-domain:example.com" or "https://example.com/"
  permissionLevel: 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser' | string;
  propertyType: 'DOMAIN' | 'URL_PREFIX';
}

export type GscDimension = 'date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance';
export type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
export type GscDataState = 'all' | 'final' | 'hourly';
export type GscAggregationType = 'auto' | 'byPage' | 'byProperty';

export interface SearchAnalyticsQueryOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  dimensions?: GscDimension[];
  searchType?: GscSearchType;
  dataState?: GscDataState;
  aggregationType?: GscAggregationType;
  rowLimit?: number; // Max 25,000 per request
  startRow?: number; // 0-indexed offset
  dimensionFilterGroups?: Array<{
    groupType?: string;
    filters: Array<{
      dimension: GscDimension;
      operator: 'contains' | 'equals' | 'notContains' | 'notEquals' | 'includingRegex' | 'excludingRegex';
      expression: string;
    }>;
  }>;
}

export interface SearchAnalyticsRow {
  keys: string[]; // Dimension values matching dimensions order
  date?: string;
  query?: string;
  page?: string;
  country?: string;
  device?: string;
  searchAppearance?: string;
  clicks: number;
  impressions: number;
  ctr: number; // Provider returned decimal (e.g. 0.05 for 5%)
  position: number; // Average rank position
}

export interface SearchAnalyticsBatchResult {
  rows: SearchAnalyticsRow[];
  totalRows: number;
  responseAggregationType?: string;
  dataState: 'FINALIZED' | 'FRESH' | 'HOURLY_PARTIAL';
  isComplete: boolean;
  completenessStatus?: 'AUTHORITATIVE_AGGREGATE' | 'PAGINATION_EXHAUSTED' | 'TOP_ROWS_PROVIDER_LIMITED' | 'UNKNOWN_COMPLETENESS';
  hasMore: boolean;
  nextStartRow?: number;
  retrievedAt: string;
  provenance: 'GOOGLE_SEARCH_CONSOLE';
}

export interface SearchConsoleProvider {
  listAccessibleProperties(accessToken: string): Promise<SearchConsoleProperty[]>;
  querySearchAnalytics(
    accessToken: string,
    propertyId: string,
    options: SearchAnalyticsQueryOptions
  ): Promise<SearchAnalyticsBatchResult>;
  verifyPropertyAccess(
    accessToken: string,
    propertyId: string
  ): Promise<{ accessible: boolean; permissionLevel?: string; propertyType?: string; error?: string }>;
}
