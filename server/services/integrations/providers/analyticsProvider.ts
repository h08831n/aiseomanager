export interface Ga4Account {
  id: string; // e.g. "accounts/123456"
  name: string; // e.g. "accounts/123456"
  displayName: string;
  regionCode?: string;
}

export interface Ga4Property {
  id: string; // e.g. "properties/987654321"
  propertyId: string; // "987654321"
  displayName: string;
  parentAccount: string; // "accounts/123456"
  timeZone: string; // e.g. "America/New_York", "UTC"
  currencyCode: string; // e.g. "USD", "EUR"
  propertyType?: string;
}

export interface Ga4DimensionHeader {
  name: string;
}

export interface Ga4MetricHeader {
  name: string;
  type: string;
}

export interface Ga4Row {
  dimensionValues: string[];
  metricValues: number[];
}

export interface Ga4ReportOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  dimensions: string[]; // e.g. ['date', 'landingPagePlusQueryString', 'sessionDefaultChannelGroup']
  metrics: string[]; // e.g. ['sessions', 'engagedSessions', 'activeUsers', 'newUsers', 'keyEvents', 'totalRevenue']
  dimensionFilter?: any;
  metricFilter?: any;
  offset?: number;
  limit?: number; // Default 10000, Max 100000
  keepEmptyRows?: boolean;
}

export interface Ga4BatchResult {
  dimensionHeaders: Ga4DimensionHeader[];
  metricHeaders: Ga4MetricHeader[];
  rows: Ga4Row[];
  rowCount: number;
  totalRowsReported: number;
  isComplete: boolean;
  hasMore: boolean;
  nextOffset?: number;
  timeZone: string;
  currencyCode: string;
  retrievedAt: string;
  provenance: 'GOOGLE_ANALYTICS';
  samplingMetadata?: any;
  subjectToThresholding?: boolean;
  dataLossFromOtherRow?: boolean;
}

export interface AnalyticsProvider {
  listAccessibleAccountsAndProperties(
    accessToken: string
  ): Promise<{ accounts: Ga4Account[]; properties: Ga4Property[] }>;
  runReport(
    accessToken: string,
    propertyId: string, // "properties/123456" or "123456"
    options: Ga4ReportOptions
  ): Promise<Ga4BatchResult>;
  verifyPropertyAccess(
    accessToken: string,
    propertyId: string
  ): Promise<{ accessible: boolean; propertyName?: string; timeZone?: string; currencyCode?: string; error?: string }>;
}
