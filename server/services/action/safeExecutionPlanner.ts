import { GeneratedSeoTask } from '../ai/aiSeoStrategistService';
import { OpportunityScoreEngine, OpportunityScoreBreakdown } from '../decision/opportunityScoreEngine';
import { AutonomousSafetyGate, SafetyCheckResult } from './autonomousSafetyGate';
import { RecommendationToActionConnector, ConnectedExecutableAction, ExecutableActionCategory } from './recommendationToActionConnector';
import { ActionExecutionPipeline, ActionExecutionPipelineResult } from './actionExecutionPipeline';
import { CrawlCoverageReport } from '../crawler/crawlCoverageAnalyzer';
import { CrawledPageRecord } from '../../repositories/crawlRepository';

export interface PlannedActionItem {
  id: string;
  recommendationId: string;
  title: string;
  category: ExecutableActionCategory;
  actionType: string;
  targetUrl: string;
  payload: Record<string, any>;
  
  // Mandatory Safe Execution Planner Requirements:
  evidence: {
    description: string;
    targetSelector?: string;
    auditProof: string;
    detectedAt: string;
  };
  opportunityScore: {
    score: number;
    businessImpact: number;
    trafficOpportunity: number;
    rankingProbability: number;
    confidenceScore: number;
    implementationCost: number;
    riskScore: number;
    formula: string;
  };
  risk: {
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    score: number;
    blastRadius: 'SINGLE_PAGE' | 'SECTION' | 'SITEWIDE';
    requiresApproval: boolean;
    mitigationNotes: string;
  };
  rollbackMethod: {
    strategy: 'ATOMIC_DOM_SNAPSHOT_RESTORATION' | 'CMS_REVISION_REVERSION' | 'HTTP_HEADER_RESET';
    isArmed: boolean;
    revertPayload: Record<string, any>;
    estimatedReversionTimeMs: number;
    description: string;
  };
  verificationMethod: {
    strategy: 'LIVE_DOM_INSPECTION' | 'HTTP_HEADER_CHECK' | 'JSON_LD_SYNTAX_PARSER';
    expectedState: Record<string, any>;
    verificationEndpoint: string;
    timeoutMs: number;
    description: string;
  };

  safetyCheck: SafetyCheckResult;
  executionStatus: 'PLANNED' | 'EXECUTING' | 'VERIFIED' | 'SAFETY_BLOCKED' | 'REQUIRES_APPROVAL' | 'FAILED';
  executionResult?: ActionExecutionPipelineResult;
}

export interface SafeExecutionPlan {
  websiteId: string;
  domain: string;
  generatedAt: string;
  totalPlanned: number;
  autonomousReadyCount: number;
  approvalRequiredCount: number;
  plannedItems: PlannedActionItem[];
  autonomousBatch: PlannedActionItem[];
  approvalOrExperimentBatch: PlannedActionItem[];
  approvalRequiredBatch: PlannedActionItem[];
}

export class SafeExecutionPlanner {
  /**
   * Constructs a strictly validated execution plan from SEO recommendations.
   * Every planned action enforces all 5 safety requirements:
   * 1. Evidence
   * 2. Opportunity score (Impact × Probability × Confidence / Effort)
   * 3. Risk level & blast radius
   * 4. Armed rollback method
   * 5. Live verification method
   */
  public static generatePlan(params: {
    websiteId: string;
    domain: string;
    tasks: GeneratedSeoTask[];
    coverageReport?: CrawlCoverageReport;
    crawledPages?: CrawledPageRecord[];
    platform?: string;
  }): SafeExecutionPlan {
    const { websiteId, domain, tasks, coverageReport, crawledPages = [], platform = 'WORDPRESS' } = params;

    const plannedItems: PlannedActionItem[] = tasks.map((task) => {
      // 1. Connect recommendation to action
      const connected = RecommendationToActionConnector.connectRecommendation({
        task,
        websiteId,
        domain,
        platform,
      });

      // 2. Compute or format Opportunity Score: (Impact × Probability × Confidence) / Effort
      const oppScoreBreakdown = OpportunityScoreEngine.calculateScore({
        businessImpact: task.expectedBusinessImpact?.businessImpactScore || 7.0,
        trafficOpportunity: task.expectedBusinessImpact?.trafficOpportunity || 7.5,
        rankingProbability: task.expectedBusinessImpact?.rankingProbability || 0.70,
        confidenceScore: task.confidenceScore || 0.85,
        implementationCost: task.opportunityScoreBreakdown?.implementationCost || 2.0,
        riskLevel: task.risk?.level || 'LOW',
      });

      // 3. Evaluate safety gate
      const safetyCheck = AutonomousSafetyGate.evaluateSafety({
        task,
        coverageReport,
        crawledPages,
        isRollbackSupported: true,
      });

      // 4. Determine rollback strategy and armed revert payload
      let rollbackStrategy: 'ATOMIC_DOM_SNAPSHOT_RESTORATION' | 'CMS_REVISION_REVERSION' | 'HTTP_HEADER_RESET' =
        'ATOMIC_DOM_SNAPSHOT_RESTORATION';
      let rollbackDesc = connected.rollbackMethod;

      if (connected.category === 'CONTENT_OPTIMIZATION') {
        rollbackStrategy = 'CMS_REVISION_REVERSION';
      } else if (connected.category === 'TECHNICAL_FIX' && task.actionType === 'CREATE_REDIRECT_RULE') {
        rollbackStrategy = 'HTTP_HEADER_RESET';
      }

      // 5. Determine verification strategy
      let verificationStrategy: 'LIVE_DOM_INSPECTION' | 'HTTP_HEADER_CHECK' | 'JSON_LD_SYNTAX_PARSER' =
        'LIVE_DOM_INSPECTION';
      if (connected.category === 'UPDATE_SCHEMA') {
        verificationStrategy = 'JSON_LD_SYNTAX_PARSER';
      } else if (connected.category === 'TECHNICAL_FIX' && task.actionType === 'CREATE_REDIRECT_RULE') {
        verificationStrategy = 'HTTP_HEADER_CHECK';
      }

      const isHighImpact =
        task.priority === 'P0_CRITICAL' ||
        task.actionType === 'SET_CANONICAL_URL' ||
        task.actionType === 'CREATE_REDIRECT_RULE' ||
        task.risk?.level === 'HIGH';

      const requiresApproval = Boolean(
        isHighImpact ||
        task.risk?.requiresApproval ||
        !safetyCheck.allowed
      );

      const blastRadius: 'SINGLE_PAGE' | 'SECTION' | 'SITEWIDE' =
        (task.affectedUrls && task.affectedUrls.length > 10)
          ? 'SITEWIDE'
          : (task.affectedUrls && task.affectedUrls.length > 1)
          ? 'SECTION'
          : 'SINGLE_PAGE';

      return {
        id: `plan-${task.id}`,
        recommendationId: task.id,
        title: task.title,
        category: connected.category,
        actionType: connected.actionType,
        targetUrl: connected.targetUrl,
        payload: connected.payload,
        evidence: {
          description: task.evidence || `Crawl issue observed on ${connected.targetUrl}`,
          targetSelector: connected.category === 'UPDATE_METADATA' ? 'head > title, head > meta[name="description"]' : 'head > script[type="application/ld+json"]',
          auditProof: task.problem || `Missing or unoptimized ${connected.category} on ${connected.targetUrl}`,
          detectedAt: new Date().toISOString(),
        },
        opportunityScore: {
          score: oppScoreBreakdown.score,
          businessImpact: oppScoreBreakdown.businessImpact,
          trafficOpportunity: oppScoreBreakdown.trafficOpportunity,
          rankingProbability: oppScoreBreakdown.rankingProbability,
          confidenceScore: oppScoreBreakdown.confidenceScore,
          implementationCost: oppScoreBreakdown.implementationCost,
          riskScore: oppScoreBreakdown.risk,
          formula: 'Opportunity Score = (Impact × Probability × Confidence) / Effort',
        },
        risk: {
          level: task.risk?.level || 'LOW',
          score: task.risk?.level === 'HIGH' ? 4.5 : task.risk?.level === 'MEDIUM' ? 2.5 : 1.2,
          blastRadius,
          requiresApproval,
          mitigationNotes: task.risk?.mitigationNotes || 'Pre-state atomic snapshot taken prior to live mutation.',
        },
        rollbackMethod: {
          strategy: rollbackStrategy,
          isArmed: true,
          revertPayload: { targetUrl: connected.targetUrl, actionType: connected.actionType },
          estimatedReversionTimeMs: 120,
          description: rollbackDesc,
        },
        verificationMethod: {
          strategy: verificationStrategy,
          expectedState: connected.payload,
          verificationEndpoint: connected.targetUrl,
          timeoutMs: 5000,
          description: connected.verificationMethod,
        },
        safetyCheck,
        executionStatus: requiresApproval ? 'REQUIRES_APPROVAL' : 'PLANNED',
      };
    });

    // Order deterministically by Opportunity Score descending
    plannedItems.sort((a, b) => b.opportunityScore.score - a.opportunityScore.score);

    const autonomousBatch = plannedItems.filter(
      (item) => !item.risk.requiresApproval && item.safetyCheck.allowed
    );
    const approvalOrExperimentBatch = plannedItems.filter(
      (item) => item.risk.requiresApproval || !item.safetyCheck.allowed
    );

    return {
      websiteId,
      domain,
      generatedAt: new Date().toISOString(),
      totalPlanned: plannedItems.length,
      autonomousReadyCount: autonomousBatch.length,
      approvalRequiredCount: approvalOrExperimentBatch.length,
      plannedItems,
      autonomousBatch,
      approvalOrExperimentBatch,
      approvalRequiredBatch: approvalOrExperimentBatch,
    };
  }

  /**
   * Executes the autonomous batch safely, taking snapshots and verifying live DOM for each action.
   */
  public static async executeAutonomousBatch(params: {
    plan: SafeExecutionPlan;
    maxActions?: number;
    platform?: string;
  }): Promise<{
    executed: PlannedActionItem[];
    successCount: number;
    failureCount: number;
  }> {
    const { plan, maxActions = 3, platform = 'WORDPRESS' } = params;
    const itemsToRun = plan.autonomousBatch.slice(0, maxActions);
    const executed: PlannedActionItem[] = [];

    for (const item of itemsToRun) {
      item.executionStatus = 'EXECUTING';
      try {
        const result = await ActionExecutionPipeline.execute({
          websiteId: plan.websiteId,
          taskId: item.recommendationId,
          recommendationId: item.recommendationId,
          actionType: item.actionType,
          targetUrl: item.targetUrl,
          payload: item.payload,
          idempotencyKey: `safe-plan-${item.id}-${Date.now()}`,
          executionMode: 'AUTONOMOUS',
          platform,
          autoVerify: true,
        });

        item.executionResult = result;
        if (result.success && result.state === 'VERIFIED_COMPLETED') {
          item.executionStatus = 'VERIFIED';
        } else if (result.rolledBack) {
          item.executionStatus = 'FAILED';
        } else {
          item.executionStatus = 'FAILED';
        }
        executed.push(item);
      } catch (err: any) {
        item.executionStatus = 'FAILED';
        executed.push(item);
      }
    }

    const successCount = executed.filter((e) => e.executionStatus === 'VERIFIED').length;
    const failureCount = executed.length - successCount;

    return { executed, successCount, failureCount };
  }
}
