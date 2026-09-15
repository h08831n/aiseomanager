import {
  ActionStatus,
  AutomationRiskLevel,
  IssueSeverity,
  SearchIntent,
  BusinessValueTier,
} from '@prisma/client';

export type SignalSource = 'CRAWL' | 'GSC' | 'GA4' | 'SERP' | 'KEYWORD' | 'COMPETITOR';

export interface RawSignal {
  id: string;
  websiteId: string;
  source: SignalSource;
  sourceId?: string;
  url?: string;
  keyword?: string;
  severity?: IssueSeverity;
  metricName?: string;
  previousValue?: number;
  currentValue?: number;
  deltaPercent?: number;
  metadata?: Record<string, any>;
  detectedAt: Date;
}

export interface ProblemContext {
  websiteId: string;
  targetDomain: string;
  url?: string;
  urlIdentityId?: string;
  keyword?: string;
  keywordId?: string;
  signals: RawSignal[];
  crawlIssues?: Array<{
    issueType: string;
    severity: IssueSeverity;
    pageUrl: string;
    detailsJson?: string;
  }>;
  gscMetrics?: {
    clicks: number;
    impressions: number;
    ctr: number;
    avgPosition: number;
    clicksDelta30dPct?: number;
  };
  ga4Metrics?: {
    sessions: number;
    conversions: number;
    revenue: number;
  };
  serpContext?: {
    rank?: number | null;
    previousRank?: number | null;
    visibilityScore?: number;
    featuresPresent?: string[];
    aiOverviewCited?: boolean;
  };
  keywordContext?: {
    searchVolume?: number;
    searchIntent?: SearchIntent;
    businessValue?: BusinessValueTier;
    moneyKeyword?: boolean;
  };
}

export type DiagnosisCategory =
  | 'TECHNICAL'
  | 'METADATA'
  | 'CONTENT'
  | 'ARCHITECTURE'
  | 'INDEXABILITY'
  | 'SERP_DISPLACEMENT'
  | 'SCHEMA';

export interface DiagnosisResult {
  ruleKey: string;
  ruleVersion: string;
  category: DiagnosisCategory;
  title: string;
  rootCause: string;
  evidence: string;
  recommendedActionType: string;
  actionPayload: Record<string, any>;
  beforeState: Record<string, any>;
  afterState: Record<string, any>;
  confidence: number; // 0.0 to 1.0
  suggestedAutomationLevel: AutomationRiskLevel;
  baseEffort: number; // 1 to 5
  baseRisk: number; // 1 to 5
  potentialTrafficGain: number; // 1.0 to 10.0
}

export interface OpportunityScoreBreakdown {
  score: number; // 0 to 100
  priority: 'P0_CRITICAL' | 'P1_HIGH' | 'P2_MEDIUM' | 'P3_LOW';
  businessImpact: number; // 1.0 to 10.0
  trafficOpportunity: number; // 1.0 to 10.0
  rankingProbability: number; // 0.05 to 1.0
  implementationCost: number; // 1.0 to 5.0 (Effort)
  risk: number; // 1.0 to 5.0
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  confidenceScore: number; // 0.1 to 1.0
  effortWeight: number;
  riskWeight: number;
  potentialTrafficGain: number;
  businessValueWeight: number;
  ruleWeight?: number;
  formulaDetails: string;
}

export interface ScoredOpportunity {
  id: string;
  websiteId: string;
  diagnosis: DiagnosisResult;
  scoring: OpportunityScoreBreakdown;
  targetUrl?: string;
  targetKeyword?: string;
  automationLevel: AutomationRiskLevel;
  status: ActionStatus;
  evidenceBundle: Record<string, any>;
  createdAt: Date;
}

export interface RuleLearningProfile {
  ruleKey: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  rolledBackExecutions: number;
  effectivenessRate: number; // 0.0 to 1.0 (execution success)
  performanceSuccessRate: number; // 0.0 to 1.0 (verified GSC lift)
  observedPerformanceTrials: number; // Count of completed post-window trials
  performanceVariance: number; // Variance across observed performance trials
  hasCausalEvidence: boolean; // Confirmed causal lift vs synthetic control
  calibratedConfidence: number; // dynamic Bayesian confidence weight
  isConfidenceScaleUpAllowed: boolean; // Requires >= 3 observations + low variance + causal proof
  lastCalibratedAt: Date;
}
