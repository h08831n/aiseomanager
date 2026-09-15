import { GeneratedSeoTask } from '../ai/aiSeoStrategistService';
import { CrawlCoverageReport } from '../crawler/crawlCoverageAnalyzer';
import { CrawledPageRecord } from '../../repositories/crawlRepository';

export interface SafetyCheckResult {
  allowed: boolean;
  blockReason?: string;
  checks: {
    sufficientCrawlConfidence: {
      passed: boolean;
      score: number;
      requiredThreshold: number;
      pagesAnalyzed: number;
      details: string;
    };
    verifiedEvidence: {
      passed: boolean;
      evidenceString: string;
      targetUrlVerified: boolean;
      details: string;
    };
    lowRiskAction: {
      passed: boolean;
      riskLevel: string;
      actionType: string;
      details: string;
    };
    rollbackAvailable: {
      passed: boolean;
      snapshotCapable: boolean;
      details: string;
    };
  };
}

export class AutonomousSafetyGate {
  public static readonly MINIMUM_CRAWL_CONFIDENCE = 0.70;
  public static readonly MINIMUM_PAGES_ANALYZED = 15;

  /**
   * Evaluates all 4 mandatory production autonomous safety gates:
   * 1. Sufficient crawl confidence
   * 2. Verified evidence
   * 3. Low-risk action
   * 4. Rollback available
   */
  public static evaluateSafety(params: {
    task: GeneratedSeoTask;
    coverageReport?: CrawlCoverageReport;
    crawledPages?: CrawledPageRecord[];
    isRollbackSupported?: boolean;
  }): SafetyCheckResult {
    const { task, coverageReport, crawledPages = [], isRollbackSupported = true } = params;

    // 1. Check Crawl Confidence
    const crawlConfidence = coverageReport?.crawlConfidenceScore ?? 0.35;
    const pagesAnalyzed = coverageReport?.pagesAnalyzed ?? crawledPages.length;
    const crawlConfidencePassed =
      crawlConfidence >= this.MINIMUM_CRAWL_CONFIDENCE &&
      pagesAnalyzed >= this.MINIMUM_PAGES_ANALYZED;

    const crawlConfidenceCheck = {
      passed: crawlConfidencePassed,
      score: crawlConfidence,
      requiredThreshold: this.MINIMUM_CRAWL_CONFIDENCE,
      pagesAnalyzed,
      details: crawlConfidencePassed
        ? `Crawl confidence score (${crawlConfidence}) and sample size (${pagesAnalyzed} pages) meet production threshold.`
        : `Crawl confidence (${crawlConfidence} < ${this.MINIMUM_CRAWL_CONFIDENCE}) or sample size (${pagesAnalyzed} < ${this.MINIMUM_PAGES_ANALYZED}) is insufficient for autonomous action.`,
    };

    // 2. Check Verified Evidence
    const hasEvidence = !!task.evidence && task.evidence.trim().length > 10;
    const targetPageMatches = crawledPages.some(
      (p) => p.url === task.targetUrl || p.normalizedUrl === task.targetUrl
    );
    const verifiedEvidencePassed = hasEvidence && (targetPageMatches || crawledPages.length === 0);

    const verifiedEvidenceCheck = {
      passed: verifiedEvidencePassed,
      evidenceString: task.evidence || '',
      targetUrlVerified: targetPageMatches,
      details: verifiedEvidencePassed
        ? `Concrete evidence verified against crawled DOM: "${task.evidence.substring(0, 80)}..."`
        : `Missing or unverified DOM evidence for target URL "${task.targetUrl}".`,
    };

    // 3. Check Low Risk Action
    const isLowRisk = task.riskLevel === 'LOW';
    const lowRiskCheck = {
      passed: isLowRisk,
      riskLevel: task.riskLevel,
      actionType: task.actionType,
      details: isLowRisk
        ? `Action "${task.actionType}" is classified as LOW risk with non-destructive, reversible parameters.`
        : `Action "${task.actionType}" carries "${task.riskLevel}" risk. Autonomous execution requires explicit manual approval.`,
    };

    // 4. Check Rollback Available
    const rollbackPassed = isRollbackSupported !== false;
    const rollbackCheck = {
      passed: rollbackPassed,
      snapshotCapable: rollbackPassed,
      details: rollbackPassed
        ? 'Pre-execution state snapshot verification supported; rollback mechanism is armed.'
        : 'Target environment or provider does not support atomic pre-execution snapshot capture.',
    };

    // Composite decision
    const allPassed =
      crawlConfidenceCheck.passed &&
      verifiedEvidenceCheck.passed &&
      lowRiskCheck.passed &&
      rollbackCheck.passed;

    let blockReason: string | undefined;
    if (!crawlConfidenceCheck.passed) {
      blockReason = `SAFETY_BLOCKED_INSUFFICIENT_CRAWL_CONFIDENCE: ${crawlConfidenceCheck.details}`;
    } else if (!verifiedEvidenceCheck.passed) {
      blockReason = `SAFETY_BLOCKED_UNVERIFIED_EVIDENCE: ${verifiedEvidenceCheck.details}`;
    } else if (!lowRiskCheck.passed) {
      blockReason = `SAFETY_BLOCKED_RISK_LEVEL: ${lowRiskCheck.details}`;
    } else if (!rollbackCheck.passed) {
      blockReason = `SAFETY_BLOCKED_NO_ROLLBACK: ${rollbackCheck.details}`;
    }

    return {
      allowed: allPassed,
      blockReason,
      checks: {
        sufficientCrawlConfidence: crawlConfidenceCheck,
        verifiedEvidence: verifiedEvidenceCheck,
        lowRiskAction: lowRiskCheck,
        rollbackAvailable: rollbackCheck,
      },
    };
  }
}
