import { CrawlCoordinator, CrawlExecutionResult } from '../crawler/crawlCoordinator';
import { SeoScoringEngine, SiteHealthAuditResult } from '../scoring/seoScoringEngine';
import { AiSeoStrategistService, GeneratedSeoTask } from '../ai/aiSeoStrategistService';
import { KeywordIntelligenceEngine } from '../keywords/keywordIntelligenceEngine';
import { SeoExperimentLifecycleEngine, ExperimentLifecycleResult } from '../experiment/seoExperimentLifecycleEngine';
import { AutonomousSafetyGate, SafetyCheckResult } from '../action/autonomousSafetyGate';
import { CrawlCoverageReport } from '../crawler/crawlCoverageAnalyzer';
import { LearningLoopEngine } from '../decision/learningLoopEngine';
import { prisma } from '../../db/prisma';

export interface ProductionValidationResult {
  targetDomain: string;
  targetUrl: string;
  executionTimestamp: string;
  phase1_crawlCoverage: CrawlCoverageReport;
  phase2_healthScoring: SiteHealthAuditResult;
  phase3_strategyEngine: {
    totalTasksGenerated: number;
    tasks: GeneratedSeoTask[];
  };
  phase4_safetyEvaluation: {
    totalEvaluated: number;
    passedTasksCount: number;
    blockedTasksCount: number;
    evaluations: Array<{
      taskId: string;
      title: string;
      actionType: string;
      riskLevel: string;
      safetyCheck: SafetyCheckResult;
    }>;
  };
  phase5_experimentLifecycle?: ExperimentLifecycleResult;
  phase6_learningLoopSummary: {
    ruleKey: string;
    effectivenessRate: number;
    calibratedConfidence: number;
    totalExecutions: number;
    latestRecordId?: string;
  };
  conclusion: {
    provenAutonomousImprovement: boolean;
    crawlConfidenceMet: boolean;
    baselineScore: number;
    postExperimentScore: number;
    measuredScoreGain: number;
    auditLog: string[];
  };
}

export class ProductionValidationWorkflow {
  /**
   * Executes the complete autonomous SEO validation workflow against a real website (e.g. https://ahaninja.com).
   */
  public static async executeRealWebsiteValidation(options?: {
    websiteUrl?: string;
    maxPagesToCrawl?: number;
    forceSkipSafetyGate?: boolean;
  }): Promise<ProductionValidationResult> {
    const rawTargetUrl = options?.websiteUrl || 'https://ahaninja.com';
    const targetUrl = rawTargetUrl.startsWith('http') ? rawTargetUrl : `https://${rawTargetUrl}`;
    const urlObj = new URL(targetUrl);
    const domain = urlObj.hostname;
    const maxPages = options?.maxPagesToCrawl || 30;

    const auditLog: string[] = [];
    auditLog.push(`[INIT] Commencing autonomous SEO validation against real website: ${targetUrl}`);

    // Ensure a website record exists in database for this validation target
    let workspace = await prisma.workspace.findFirst();
    if (!workspace) {
      workspace = await prisma.workspace.create({
        data: {
          name: 'Production Validation Workspace',
          slug: 'prod-val-workspace',
        },
      });
    }

    let website = await prisma.website.findFirst({
      where: { domain },
    });

    if (!website) {
      website = await prisma.website.create({
        data: {
          workspaceId: workspace.id,
          domain,
          name: 'Ahaninja (آهن اینجا)',
          productionUrl: targetUrl,
          industry: 'Industrial & Metals E-Commerce',
        },
      });
    }

    // =========================================================================
    // STEP 1: Complete Crawl Coverage Analysis
    // =========================================================================
    auditLog.push(`[CRAWL] Starting deep live crawl on ${targetUrl} (maxPages: ${maxPages})`);
    const crawlResult = await CrawlCoordinator.executeCrawl({
      websiteId: website.id,
      seedUrl: targetUrl,
      maxUrls: maxPages,
      crawlSitemaps: true,
      respectRobots: true,
    });

    const coverageReport: CrawlCoverageReport = crawlResult.coverageReport;
    auditLog.push(
      `[COVERAGE] Discovered: ${coverageReport.discoveredUrls} URLs | Sitemap Coverage: ${coverageReport.sitemapCoverage.sitemapCoveragePercentage}% | Crawl Coverage: ${coverageReport.crawlCoveragePercentage}% | Analyzed: ${coverageReport.pagesAnalyzed} | Confidence: ${coverageReport.crawlConfidenceScore}`
    );

    // =========================================================================
    // STEP 2: Improved SEO Scoring Model with Credibility Adjustments
    // =========================================================================
    auditLog.push(`[SCORING] Calculating 6-pillar SEO health scores with sample credibility adjustments`);
    const healthAudit = SeoScoringEngine.calculateHealthScores({
      pages: crawlResult.crawledPages,
      issues: crawlResult.crawlIssues,
      coverageReport,
    });

    auditLog.push(
      `[SCORE] Health Score: ${healthAudit.overallScore}/100 (Raw: ${healthAudit.rawCompositeScore}, Credibility: ${(healthAudit.sampleCredibility.credibilityWeight * 100).toFixed(1)}%)`
    );

    // =========================================================================
    // STEP 3: Strengthened AI SEO Strategy Engine
    // =========================================================================
    auditLog.push(`[STRATEGY] Generating evidence-based strategic tasks with dynamic Bayesian confidence`);
    const keywords = KeywordIntelligenceEngine.discoverKeywordsFromPages(
      crawlResult.crawledPages,
      domain
    );

    const generatedTasks = await AiSeoStrategistService.generateStrategicTasks({
      websiteId: website.id,
      domain,
      pages: crawlResult.crawledPages,
      issues: crawlResult.crawlIssues,
      healthAudit,
      keywords,
    });

    auditLog.push(
      `[TASKS] Synthesized ${generatedTasks.length} prioritized tasks with live DOM evidence, affected URLs, and dynamic confidence`
    );

    // =========================================================================
    // STEP 4: Production Autonomous Safety Gate Evaluation
    // =========================================================================
    auditLog.push(`[SAFETY] Evaluating autonomous safety checks for all generated tasks`);
    const safetyEvaluations = generatedTasks.map((task) => {
      const safetyCheck = AutonomousSafetyGate.evaluateSafety({
        task,
        coverageReport,
        crawledPages: crawlResult.crawledPages,
        isRollbackSupported: true,
      });
      return {
        taskId: task.id,
        title: task.title,
        actionType: task.actionType,
        riskLevel: task.riskLevel,
        safetyCheck,
      };
    });

    const passedSafetyTasks = safetyEvaluations.filter((e) => e.safetyCheck.allowed);
    const blockedSafetyTasks = safetyEvaluations.filter((e) => !e.safetyCheck.allowed);

    auditLog.push(
      `[SAFETY RESULT] Allowed for autonomous execution: ${passedSafetyTasks.length} | Blocked: ${blockedSafetyTasks.length}`
    );

    // =========================================================================
    // STEP 5: Real SEO Experiment Lifecycle Execution
    // =========================================================================
    let experimentResult: ExperimentLifecycleResult | undefined;

    // Pick top safe task if any passed, or test safety gate enforcement
    const taskToExecute = generatedTasks.find((t) => t.riskLevel === 'LOW') || generatedTasks[0];

    if (taskToExecute) {
      auditLog.push(`[EXPERIMENT] Initiating 6-stage experiment lifecycle for: "${taskToExecute.title}"`);
      experimentResult = await SeoExperimentLifecycleEngine.runExperiment({
        websiteId: website.id,
        domain,
        task: taskToExecute,
        crawledPages: crawlResult.crawledPages,
        crawlIssues: crawlResult.crawlIssues,
        coverageReport,
        platform: 'WORDPRESS',
        forceSkipSafetyGate: options?.forceSkipSafetyGate ?? false,
      });

      auditLog.push(`[EXPERIMENT] Lifecycle finished with status: ${experimentResult.status}`);
      if (experimentResult.status === 'SUCCESS') {
        auditLog.push(
          `[VERIFICATION] DOM modification verified live on ${taskToExecute.targetUrl}. Score gain: +${experimentResult.impactMeasurement?.measuredDelta} points.`
        );
      } else if (experimentResult.status === 'SAFETY_BLOCKED') {
        auditLog.push(`[SAFETY BLOCK CONFIRMED] Execution safely prevented: ${experimentResult.safetyCheck.blockReason}`);
      }
    }

    // =========================================================================
    // STEP 6: Learning Loop Calibration Audit
    // =========================================================================
    const primaryRuleKey = taskToExecute ? `RULE_${taskToExecute.actionType}` : 'RULE_SET_META_TAGS';
    const profile = LearningLoopEngine.getRuleProfile(primaryRuleKey);
    const learningRecords = LearningLoopEngine.getLearningRecords(primaryRuleKey);
    const latestRecord = learningRecords[learningRecords.length - 1];

    const baselineScore = healthAudit.overallScore;
    const postExperimentScore =
      (experimentResult?.impactMeasurement as any)?.newScore ??
      experimentResult?.impactMeasurement?.newOverallScore ??
      baselineScore;
    const measuredScoreGain = (experimentResult?.impactMeasurement as any)?.delta ?? experimentResult?.impactMeasurement?.measuredDelta ?? 0;

    return {
      targetDomain: domain,
      targetUrl,
      executionTimestamp: new Date().toISOString(),
      phase1_crawlCoverage: coverageReport,
      phase2_healthScoring: healthAudit,
      phase3_strategyEngine: {
        totalTasksGenerated: generatedTasks.length,
        tasks: generatedTasks,
      },
      phase4_safetyEvaluation: {
        totalEvaluated: safetyEvaluations.length,
        passedTasksCount: passedSafetyTasks.length,
        blockedTasksCount: blockedSafetyTasks.length,
        evaluations: safetyEvaluations,
      },
      phase5_experimentLifecycle: experimentResult,
      phase6_learningLoopSummary: {
        ruleKey: primaryRuleKey,
        effectivenessRate: profile.effectivenessRate,
        calibratedConfidence: profile.calibratedConfidence,
        totalExecutions: profile.totalExecutions,
        latestRecordId: latestRecord?.id,
      },
      conclusion: {
        provenAutonomousImprovement: measuredScoreGain > 0 && experimentResult?.status === 'SUCCESS',
        crawlConfidenceMet: coverageReport.crawlConfidenceScore >= AutonomousSafetyGate.MINIMUM_CRAWL_CONFIDENCE,
        baselineScore,
        postExperimentScore,
        measuredScoreGain,
        auditLog,
      },
    };
  }
}
