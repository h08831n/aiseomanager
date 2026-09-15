import {
  CrawlUrlResponse,
  CopilotResponse,
  EvidenceContext,
  ContentBriefRequest,
  ContentBriefResponse,
  ContentRefreshRequest,
  ContentRefreshResponse,
  CtrOptimizationRequest,
  CtrOptimizationResponse,
  SchemaGenerationRequest,
  SchemaGenerationResponse,
  WordPressPreviewRequest,
  WordPressPreviewResponse,
  IntegrationConnection,
} from '../shared/contracts';

// Current session storage for active workspace / auth token
let activeWorkspaceId = localStorage.getItem('aiseo_workspace_id') || 'ws-techscale-org';
let activeAuthToken = localStorage.getItem('aiseo_auth_token') || '';

export function setActiveWorkspaceId(workspaceId: string) {
  activeWorkspaceId = workspaceId;
  localStorage.setItem('aiseo_workspace_id', workspaceId);
}

export function getActiveWorkspaceId(): string {
  return activeWorkspaceId;
}

export function setAuthToken(token: string) {
  activeAuthToken = token;
  if (token) {
    localStorage.setItem('aiseo_auth_token', token);
  } else {
    localStorage.removeItem('aiseo_auth_token');
  }
}

export function getAuthToken(): string {
  return activeAuthToken;
}

function getHeaders(customHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-workspace-id': activeWorkspaceId,
  };
  if (activeAuthToken) {
    headers['Authorization'] = `Bearer ${activeAuthToken}`;
  }
  if (customHeaders) {
    Object.assign(headers, customHeaders);
  }
  return headers;
}

// -------------------------------------------------------------
// 0. Authentication & Session APIs
// -------------------------------------------------------------

export async function getAuthSession(): Promise<any> {
  const res = await fetch('/api/auth/session', { headers: getHeaders() });
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  if (data?.session?.token) {
    setAuthToken(data.session.token);
  }
  if (data?.session?.activeWorkspace?.id) {
    setActiveWorkspaceId(data.session.activeWorkspace.id);
  }
  return data.session;
}

export async function loginUser(email?: string): Promise<any> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error('Login failed');
  const data = await res.json();
  if (data?.session?.token) {
    setAuthToken(data.session.token);
  }
  if (data?.session?.activeWorkspace?.id) {
    setActiveWorkspaceId(data.session.activeWorkspace.id);
  }
  return data.session;
}

export async function signupUser(email: string, name?: string, workspaceName?: string): Promise<any> {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email, name, workspaceName }),
  });
  if (!res.ok) throw new Error('Signup failed');
  const data = await res.json();
  if (data?.session?.token) {
    setAuthToken(data.session.token);
  }
  if (data?.session?.activeWorkspace?.id) {
    setActiveWorkspaceId(data.session.activeWorkspace.id);
  }
  return data.session;
}

export async function switchWorkspace(workspaceId: string): Promise<any> {
  const res = await fetch('/api/auth/switch-workspace', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) throw new Error('Failed to switch workspace');
  const data = await res.json();
  setActiveWorkspaceId(workspaceId);
  if (data?.token) {
    setAuthToken(data.token);
  }
  return data;
}

// -------------------------------------------------------------
// 0.1. Dashboard Aggregation APIs
// -------------------------------------------------------------

export async function getDashboardOverview(websiteId?: string): Promise<any> {
  const q = websiteId ? `?websiteId=${websiteId}` : '';
  const res = await fetch(`/api/dashboard/overview${q}`, {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  if (!res.ok) {
    throw new Error('Failed to load dashboard overview');
  }
  return res.json();
}

// -------------------------------------------------------------
// 0.2. SEO Agents Swarm Runtime APIs
// -------------------------------------------------------------

export async function getAgentSwarmStatus(websiteId?: string): Promise<any[]> {
  const q = websiteId ? `?websiteId=${websiteId}` : '';
  const res = await fetch(`/api/agents${q}`, {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.agents || [];
}

export async function triggerAgentTask(websiteId: string, agentId: string, taskType?: string): Promise<any> {
  const res = await fetch(`/api/agents/${agentId}/task`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ websiteId, taskType }),
  });
  if (!res.ok) throw new Error('Agent task execution failed');
  return res.json();
}

export async function runAutonomousLoop(websiteId: string): Promise<any> {
  const res = await fetch('/api/agents/autonomous-loop', {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ websiteId }),
  });
  if (!res.ok) throw new Error('Autonomous loop execution failed');
  return res.json();
}

// -------------------------------------------------------------
// 1. Websites & Workspaces API
// -------------------------------------------------------------

export async function getWebsites(): Promise<{ websites: any[] }> {
  const res = await fetch('/api/websites', { headers: getHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch websites' }));
    throw new Error(err.message || err.error || 'Failed to fetch websites');
  }
  return res.json();
}

export async function createWebsite(data: {
  domain: string;
  name: string;
  productionUrl: string;
  sitemapUrl?: string;
  defaultLanguage?: string;
  industry?: string;
}): Promise<any> {
  const res = await fetch('/api/websites', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create website' }));
    throw new Error(err.message || err.error || 'Failed to create website');
  }
  return res.json();
}

export async function getWebsiteById(id: string): Promise<any> {
  const res = await fetch(`/api/websites/${id}`, { headers: getHeaders({ 'x-website-id': id }) });
  if (!res.ok) throw new Error('Website not found');
  return res.json();
}

export async function verifyDomainOwnership(websiteId: string): Promise<any> {
  const res = await fetch(`/api/websites/${websiteId}/verify-domain`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Domain verification failed' }));
    throw new Error(err.message || err.error || 'Domain verification failed');
  }
  return res.json();
}

export async function connectCmsIntegration(websiteId: string, platform: string, details?: any): Promise<any> {
  const res = await fetch(`/api/websites/${websiteId}/connect-cms`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ platform, ...details }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'CMS connection failed' }));
    throw new Error(err.message || err.error || 'CMS connection failed');
  }
  return res.json();
}

export async function getOnboardingStatus(websiteId: string): Promise<any> {
  const res = await fetch(`/api/websites/${websiteId}/onboarding-status`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) throw new Error('Failed to fetch onboarding status');
  return res.json();
}

// -------------------------------------------------------------
// 2. Crawler & SEO Health API
// -------------------------------------------------------------

export async function crawlUrl(url: string, websiteId?: string): Promise<CrawlUrlResponse> {
  const res = await fetch('/api/crawl/url', {
    method: 'POST',
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ message: 'Crawl request failed' }));
    throw new Error(errorData.message || errorData.error || 'Crawl failed');
  }
  return res.json();
}

export async function startFullCrawl(websiteId: string, options?: {
  seedUrl?: string;
  maxUrls?: number;
  maxDepth?: number;
  respectRobots?: boolean;
  crawlSitemaps?: boolean;
}): Promise<any> {
  const res = await fetch(`/api/websites/${websiteId}/crawls`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify(options || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to trigger crawl' }));
    throw new Error(err.message || err.error || 'Failed to trigger crawl');
  }
  return res.json();
}

export async function getCrawlRuns(websiteId?: string): Promise<{ runs: any[] }> {
  const url = websiteId ? `/api/websites/${websiteId}/crawls` : '/api/crawl/runs';
  const res = await fetch(url, { headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}) });
  if (!res.ok) {
    return { runs: [] };
  }
  return res.json();
}

export async function getCrawledPages(websiteId: string, crawlRunId: string, query?: { page?: number; limit?: number }): Promise<any> {
  const page = query?.page || 1;
  const limit = query?.limit || 50;
  const res = await fetch(`/api/websites/${websiteId}/crawls/${crawlRunId}/pages?page=${page}&limit=${limit}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) {
    return { total: 0, pages: [] };
  }
  return res.json();
}

export async function getCrawlIssues(websiteId: string, crawlRunId: string, query?: { page?: number; limit?: number }): Promise<any> {
  const page = query?.page || 1;
  const limit = query?.limit || 100;
  const res = await fetch(`/api/websites/${websiteId}/crawls/${crawlRunId}/issues?page=${page}&limit=${limit}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) {
    return { total: 0, issues: [] };
  }
  return res.json();
}

// -------------------------------------------------------------
// 3. AI Decisions, Rules & Recommendations
// -------------------------------------------------------------

export async function getRecommendations(websiteId?: string): Promise<{ recommendations: any[] }> {
  const res = await fetch('/api/tasks/recommendations', {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  if (!res.ok) return { recommendations: [] };
  return res.json();
}

export async function evaluateDecisions(websiteId: string, options?: {
  targetUrl?: string;
  targetKeyword?: string;
  cmsProvider?: string;
  pageArchetype?: string;
  async?: boolean;
}): Promise<any> {
  const isAsync = options?.async ? '?async=true' : '';
  const res = await fetch(`/api/decision/evaluate${isAsync}`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ websiteId, ...options }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Evaluation failed' }));
    throw new Error(err.message || err.error || 'Evaluation failed');
  }
  return res.json();
}

export async function getDiagnosisRules(websiteId?: string): Promise<{ rules: any[]; resolvedWeights?: Record<string, number> }> {
  const query = websiteId ? `?websiteId=${websiteId}` : '';
  const res = await fetch(`/api/decision/rules${query}`, {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  if (!res.ok) return { rules: [] };
  return res.json();
}

// -------------------------------------------------------------
// 4. Actions, Approval Queue & Verification Timeline
// -------------------------------------------------------------

export async function getActionExecutions(websiteId: string): Promise<{ executions: any[] }> {
  const res = await fetch(`/api/actions?websiteId=${websiteId}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) return { executions: [] };
  return res.json();
}

export async function executeAction(payload: {
  websiteId: string;
  actionType: string;
  targetUrl: string;
  payload: Record<string, any>;
  idempotencyKey: string;
  taskId?: string;
  recommendationId?: string;
  executionMode?: 'MANUAL' | 'AUTONOMOUS' | 'CANARY';
  isDryRun?: boolean;
  autoVerify?: boolean;
}): Promise<any> {
  const res = await fetch('/api/actions/execute', {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': payload.websiteId }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Execution failed' }));
    throw new Error(err.message || err.error || 'Action execution failed');
  }
  return res.json();
}

export async function rollbackAction(
  actionId: string,
  websiteId: string,
  reason = '1-Click User Rollback via SaaS Dashboard'
): Promise<any> {
  const res = await fetch(`/api/actions/${actionId}/rollback`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ websiteId, reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Rollback failed' }));
    throw new Error(err.message || err.error || 'Rollback failed');
  }
  return res.json();
}

export async function verifyAction(
  actionId: string,
  websiteId: string,
  stage: 'STAGE_1_SYNTHETIC_DOM' | 'STAGE_2_INDEX_SERP' | 'STAGE_3_TRAFFIC_CONVERSION',
  payload?: any
): Promise<any> {
  const res = await fetch(`/api/actions/${actionId}/verify?stage=${stage}`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ websiteId, ...(payload || {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Verification failed' }));
    throw new Error(err.message || err.error || 'Verification failed');
  }
  return res.json();
}

export async function getApprovalQueue(websiteId: string, state?: string): Promise<{ items: any[] }> {
  const query = state ? `?state=${state}` : '';
  const res = await fetch(`/api/actions/approval-center/queue${query}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) return { items: [] };
  return res.json();
}

export async function approveActionRequest(actionId: string, notes?: string): Promise<any> {
  const res = await fetch(`/api/actions/approval-center/${actionId}/approve`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Approval failed' }));
    throw new Error(err.message || err.error || 'Approval failed');
  }
  return res.json();
}

export async function rejectActionRequest(actionId: string, reason?: string): Promise<any> {
  const res = await fetch(`/api/actions/approval-center/${actionId}/reject`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Rejection failed' }));
    throw new Error(err.message || err.error || 'Rejection failed');
  }
  return res.json();
}

export async function getRollbackHistory(websiteId: string): Promise<{ history: any[] }> {
  const res = await fetch(`/api/actions/rollback-history?websiteId=${websiteId}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) return { history: [] };
  return res.json();
}

// -------------------------------------------------------------
// 5. Keywords, Rankings & SERP Universe
// -------------------------------------------------------------

export async function getKeywords(websiteId: string, params?: {
  trackingStatus?: string;
  searchIntent?: string;
  funnelStage?: string;
  moneyKeyword?: boolean;
  query?: string;
  limit?: number;
}): Promise<{ success: boolean; keywords: any[]; total: number }> {
  const q = new URLSearchParams();
  if (params?.trackingStatus) q.set('trackingStatus', params.trackingStatus);
  if (params?.searchIntent) q.set('searchIntent', params.searchIntent);
  if (params?.funnelStage) q.set('funnelStage', params.funnelStage);
  if (params?.moneyKeyword !== undefined) q.set('moneyKeyword', String(params.moneyKeyword));
  if (params?.query) q.set('query', params.query);
  if (params?.limit) q.set('limit', String(params.limit));

  const res = await fetch(`/api/keywords/websites/${websiteId}?${q.toString()}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) return { success: false, keywords: [], total: 0 };
  return res.json();
}

export async function createKeyword(websiteId: string, data: {
  keyword: string;
  targetUrl?: string;
  tags?: string[];
  searchIntent?: string;
}): Promise<any> {
  const res = await fetch(`/api/keywords/websites/${websiteId}`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to add keyword' }));
    throw new Error(err.message || err.error || 'Failed to add keyword');
  }
  return res.json();
}

export async function checkKeywordSerp(websiteId: string, keywordId: string, options?: { device?: 'DESKTOP' | 'MOBILE'; async?: boolean }): Promise<any> {
  const res = await fetch(`/api/serp/websites/${websiteId}/keywords/${keywordId}/check`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify(options || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'SERP check failed' }));
    throw new Error(err.message || err.error || 'SERP check failed');
  }
  return res.json();
}

// -------------------------------------------------------------
// 6. Analytics & Performance Intelligence
// -------------------------------------------------------------

export async function getAnalyticsPerformance(websiteId: string, startDate?: string, endDate?: string): Promise<any> {
  const q = new URLSearchParams();
  if (startDate) q.set('startDate', startDate);
  if (endDate) q.set('endDate', endDate);

  const res = await fetch(`/api/websites/${websiteId}/analytics/performance?${q.toString()}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Analytics fetch failed' }));
    throw new Error(err.message || err.error || 'Analytics fetch failed');
  }
  return res.json();
}

// -------------------------------------------------------------
// 7. Competitors
// -------------------------------------------------------------

export async function getCompetitors(websiteId: string, directOnly = false): Promise<{ competitors: any[] }> {
  const res = await fetch(`/api/competitors/websites/${websiteId}?directOnly=${directOnly}`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) return { competitors: [] };
  return res.json();
}

export async function refreshCompetitors(websiteId: string): Promise<any> {
  const res = await fetch(`/api/competitors/websites/${websiteId}/refresh`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Competitor refresh failed' }));
    throw new Error(err.message || err.error || 'Competitor refresh failed');
  }
  return res.json();
}

export async function setCompetitorExclusion(websiteId: string, domain: string, isExcluded = true, reason?: string): Promise<any> {
  const res = await fetch(`/api/competitors/websites/${websiteId}/exclusions`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ domain, isExcluded, reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Competitor override failed' }));
    throw new Error(err.message || err.error || 'Competitor override failed');
  }
  return res.json();
}

// -------------------------------------------------------------
// 8. Integrations & GSC/GA4 Property Bindings
// -------------------------------------------------------------

export async function getIntegrations(websiteId?: string): Promise<{ integrations: IntegrationConnection[] }> {
  const res = await fetch('/api/integrations', {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  if (!res.ok) return { integrations: [] };
  return res.json();
}

export async function getGoogleAuthUrl(websiteId?: string): Promise<{ authUrl?: string; configured: boolean; message?: string }> {
  const q = websiteId ? `?websiteId=${websiteId}` : '';
  const res = await fetch(`/api/integrations/google/auth-url${q}`, {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  return res.json();
}

export async function getGscProperties(websiteId: string): Promise<{ properties: any[]; currentBinding: any }> {
  const res = await fetch(`/api/integrations/websites/${websiteId}/gsc/properties`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) {
    return { properties: [], currentBinding: null };
  }
  return res.json();
}

export async function bindGscProperty(websiteId: string, propertyId: string, propertyType?: string): Promise<any> {
  const res = await fetch(`/api/integrations/websites/${websiteId}/gsc/bind`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ propertyId, propertyType }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'GSC binding failed' }));
    throw new Error(err.message || err.error || 'GSC binding failed');
  }
  return res.json();
}

export async function triggerIntegrationSync(websiteId: string, provider = 'ALL', syncType = 'MANUAL_RESYNC'): Promise<any> {
  const res = await fetch(`/api/integrations/websites/${websiteId}/sync`, {
    method: 'POST',
    headers: getHeaders({ 'x-website-id': websiteId }),
    body: JSON.stringify({ provider, syncType }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Sync failed' }));
    throw new Error(err.message || err.error || 'Sync trigger failed');
  }
  return res.json();
}

export async function getSyncRuns(websiteId: string): Promise<{ syncRuns: any[] }> {
  const res = await fetch(`/api/integrations/websites/${websiteId}/sync-runs`, {
    headers: getHeaders({ 'x-website-id': websiteId }),
  });
  if (!res.ok) return { syncRuns: [] };
  return res.json();
}

// -------------------------------------------------------------
// 9. AI Copilot
// -------------------------------------------------------------

export async function askCopilot(
  question: string,
  evidenceContext?: EvidenceContext
): Promise<CopilotResponse> {
  const res = await fetch('/api/copilot', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ question, evidenceContext }),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ reply: 'Copilot request failed' }));
    return {
      status: 'ERROR',
      reply: errorData.reply || errorData.message || 'Copilot server request failed.',
      source: 'SERVER_ERROR',
      reason: errorData.reason || 'HTTP_ERROR',
      provenance: 'DATA_UNAVAILABLE',
    };
  }
  return res.json();
}

// -------------------------------------------------------------
// 10. Observability, System Health & Tasks
// -------------------------------------------------------------

export async function getObservabilityStatus(): Promise<any> {
  const res = await fetch('/api/observability/status', { headers: getHeaders() });
  if (!res.ok) return { status: 'DEGRADED' };
  return res.json();
}

export async function getTasks(websiteId?: string): Promise<{ tasks: any[] }> {
  const res = await fetch('/api/tasks', {
    headers: getHeaders(websiteId ? { 'x-website-id': websiteId } : {}),
  });
  if (!res.ok) return { tasks: [] };
  return res.json();
}

export async function executeTask(taskId: string, idempotencyKey: string, isSimulation = false): Promise<any> {
  const res = await fetch(`/api/tasks/${taskId}/execute`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ idempotencyKey, isSimulation }),
  });
  if (!res.ok) throw new Error('Task execution request failed');
  return res.json();
}

// -------------------------------------------------------------
// 11. Content Studio & Generation Tools
// -------------------------------------------------------------

export async function generateBrief(req: ContentBriefRequest): Promise<ContentBriefResponse> {
  const res = await fetch('/api/content/brief', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error('Brief generation failed');
  return res.json();
}

export async function generateRefresh(req: ContentRefreshRequest): Promise<ContentRefreshResponse> {
  const res = await fetch('/api/content/refresh', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error('Refresh diagnosis failed');
  return res.json();
}

export async function optimizeCtr(
  reqOrTitle: CtrOptimizationRequest | string,
  meta?: string,
  keyword?: string,
  position?: number,
  ctr?: number,
  impressions?: number
): Promise<CtrOptimizationResponse> {
  const payload: CtrOptimizationRequest =
    typeof reqOrTitle === 'string'
      ? {
          keyword: keyword || 'target keyword',
          currentTitle: reqOrTitle,
          currentMetaDescription: meta || '',
          currentPosition: position || 1,
          currentCtr: ctr || 1,
        }
      : reqOrTitle;
  const res = await fetch('/api/content/ctr-optimize', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('CTR optimization failed');
  return res.json();
}

export async function generateSchema(
  typeOrReq: SchemaGenerationRequest | string,
  data?: Record<string, any>
): Promise<SchemaGenerationResponse> {
  const payload =
    typeof typeOrReq === 'string'
      ? { type: typeOrReq as any, data: data || {} }
      : typeOrReq;
  const res = await fetch('/api/content/schema-generate', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Schema generation failed');
  return res.json();
}

export async function exportToCsv(rows: any[], filename = 'seo_export.csv'): Promise<void> {
  const res = await fetch('/api/integrations/export-csv', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ filename, rows }),
  });
  if (!res.ok) throw new Error('CSV export failed');
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function exportToWordPress(payload: {
  title: string;
  content: string;
  slug?: string;
  status?: 'draft' | 'publish';
  categories?: string[];
  tags?: string[];
}): Promise<WordPressPreviewResponse> {
  const res = await fetch('/api/integrations/export-wordpress', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('WordPress request failed');
  return res.json();
}

export async function previewWordPressPayload(payload: WordPressPreviewRequest): Promise<WordPressPreviewResponse> {
  return exportToWordPress(payload);
}

// -------------------------------------------------------------
// 12. World-Class Autonomous SEO Optimization Engine APIs
// -------------------------------------------------------------

export async function getSeoHealthAudit(websiteId: string): Promise<any> {
  const res = await fetch(`/api/seo/audit/${websiteId}`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch SEO health audit');
  return res.json();
}

export async function getSeoKeywords(websiteId: string): Promise<any> {
  const res = await fetch(`/api/seo/keywords/${websiteId}`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch keyword intelligence');
  return res.json();
}

export async function getCompetitorReport(websiteId: string, competitor?: string): Promise<any> {
  const url = competitor
    ? `/api/seo/competitors/${websiteId}?competitor=${encodeURIComponent(competitor)}`
    : `/api/seo/competitors/${websiteId}`;
  const res = await fetch(url, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch competitor report');
  return res.json();
}

export async function analyzeCompetitorDomain(websiteId: string, competitorDomain: string): Promise<any> {
  const res = await fetch(`/api/seo/competitors/${websiteId}/analyze`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ competitorDomain }),
  });
  if (!res.ok) throw new Error('Failed to analyze competitor domain');
  return res.json();
}

export async function getStrategistTasks(websiteId: string): Promise<any> {
  const res = await fetch(`/api/seo/strategist/${websiteId}/tasks`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch AI SEO strategist tasks');
  return res.json();
}

export async function executeSeoAction(payload: {
  websiteId: string;
  taskId?: string;
  actionType: string;
  targetUrl: string;
  actionPayload: Record<string, any>;
  platform?: string;
}): Promise<any> {
  const res = await fetch('/api/seo/execute', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Action execution failed');
  }
  return res.json();
}

export async function runQuickOptimize(websiteId: string): Promise<any> {
  const res = await fetch(`/api/seo/quick-optimize/${websiteId}`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error('Failed to run autonomous quick optimize');
  return res.json();
}

