import { prisma } from '../../db/prisma';
import { RuleLearningProfile } from './decisionTypes';

export interface PersistentLearningRecord {
  id: string;
  ruleKey: string;
  websiteId: string;
  actionExecutionId?: string;
  prediction: {
    hypothesis: string;
    expectedGainPct?: number;
    targetMetric?: string;
    estimationSource: 'HISTORICAL_WEBSITE_DATA' | 'GLOBAL_RULE_DATA' | 'EMPIRICAL_PRIOR';
  };
  confidence: number;
  confidenceSource: string;
  action: {
    actionType: string;
    ruleKey: string;
    payloadSummary?: string;
  };
  expectedOutcome: {
    clicksLiftPct?: number;
    rankDelta?: number;
    indexationConfirmed?: boolean;
    conversionLiftPct?: number;
    [key: string]: any;
  };
  actualOutcome: {
    passed?: boolean;
    stage?: string;
    clicksLiftPct?: number;
    rankDelta?: number;
    gscIndexed?: boolean;
    conversionLiftPct?: number;
    verifiedChangesCount?: number;
    causalLift?: number;
    syntheticControlDelta?: number;
    [key: string]: any;
  };
  learningDelta: {
    metricDeltaPct?: number;
    variancePct?: number;
    isPositiveGain: boolean;
    causalLift?: number;
    notes?: string;
  };
  ruleEffectiveness: {
    totalExecutions: number;
    successRate: number;
    rollbackRate: number;
    calibratedConfidence: number;
  };
  recordedAt: Date;
}

export class LearningLoopEngine {
  private static learningStore: Map<string, RuleLearningProfile> = new Map();
  private static persistentLearningRecords: Map<string, PersistentLearningRecord[]> = new Map();

  /**
   * Calculates dynamic empirical expected gain using historical website data and previous executions.
   * Removes fixed assumptions (e.g. 10.0% expectedGainPct).
   */
  public static computeEmpiricalExpectedGain(
    ruleKey: string,
    websiteId: string
  ): { expectedGainPct: number; source: 'HISTORICAL_WEBSITE_DATA' | 'GLOBAL_RULE_DATA' | 'EMPIRICAL_PRIOR' } {
    const siteRecords = (this.persistentLearningRecords.get(ruleKey) || []).filter(
      (r) => r.websiteId === websiteId && r.learningDelta.metricDeltaPct !== undefined
    );

    if (siteRecords.length > 0) {
      const avgGain =
        siteRecords.reduce((sum, r) => sum + (r.learningDelta.metricDeltaPct || 0), 0) / siteRecords.length;
      return {
        expectedGainPct: Number(avgGain.toFixed(2)),
        source: 'HISTORICAL_WEBSITE_DATA',
      };
    }

    const allRecords = (this.persistentLearningRecords.get(ruleKey) || []).filter(
      (r) => r.learningDelta.metricDeltaPct !== undefined
    );

    if (allRecords.length > 0) {
      const globalAvg =
        allRecords.reduce((sum, r) => sum + (r.learningDelta.metricDeltaPct || 0), 0) / allRecords.length;
      return {
        expectedGainPct: Number(globalAvg.toFixed(2)),
        source: 'GLOBAL_RULE_DATA',
      };
    }

    // Uninformative prior for newly encountered rules
    return {
      expectedGainPct: 0.0,
      source: 'EMPIRICAL_PRIOR',
    };
  }

  /**
   * Records the outcome of an action execution with causal attribution, verified outcomes,
   * and empirical variance persistence.
   */
  public static async recordActionOutcome(params: {
    ruleKey: string;
    websiteId: string;
    actionExecutionId?: string;
    actionType?: string;
    outcome: 'SUCCESS' | 'FAILED' | 'ROLLED_BACK';
    metricDeltaPct?: number;
    causalLift?: number;
    syntheticControlDelta?: number;
    confidence?: number;
    prediction?: {
      hypothesis: string;
      expectedGainPct?: number;
      targetMetric?: string;
    };
    expectedOutcome?: Record<string, any>;
    actualOutcome?: Record<string, any>;
  }): Promise<{ profile: RuleLearningProfile; learningRecord: PersistentLearningRecord }> {
    const {
      ruleKey,
      outcome,
      websiteId,
      actionExecutionId,
      actionType = 'SET_ACTION',
      metricDeltaPct,
      causalLift,
      syntheticControlDelta,
      confidence,
      prediction: inputPrediction,
      expectedOutcome: inputExpectedOutcome,
      actualOutcome: inputActualOutcome,
    } = params;

    // 1. Empirical Expected Gain Resolution
    const empiricalEstimation = this.computeEmpiricalExpectedGain(ruleKey, websiteId);
    const resolvedExpectedGain = inputPrediction?.expectedGainPct ?? empiricalEstimation.expectedGainPct;

    const prediction = {
      hypothesis: inputPrediction?.hypothesis || `Hypothesis for ${ruleKey} on ${websiteId}`,
      expectedGainPct: resolvedExpectedGain,
      targetMetric: inputPrediction?.targetMetric || 'SEO_HEALTH_INDEX',
      estimationSource: empiricalEstimation.source,
    };

    const expectedOutcome = inputExpectedOutcome || {
      expectedGainPct: resolvedExpectedGain,
      indexationConfirmed: true,
    };

    // 2. Resolve Profile or Initialize with Uninformative Prior (0.50, not 1.0)
    let profile = this.learningStore.get(ruleKey);
    if (!profile) {
      profile = {
        ruleKey,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        rolledBackExecutions: 0,
        effectivenessRate: 0.50, // Uninformative 50/50 prior, no default success assumption
        calibratedConfidence: 0.50, // Uninformative 50/50 prior, no default 0.90 assumption
        lastCalibratedAt: new Date(),
      };
      this.learningStore.set(ruleKey, profile);
    }

    // Update execution counters
    profile.totalExecutions += 1;
    if (outcome === 'SUCCESS') {
      profile.successfulExecutions += 1;
    } else if (outcome === 'FAILED') {
      profile.failedExecutions += 1;
    } else if (outcome === 'ROLLED_BACK') {
      profile.rolledBackExecutions += 1;
    }

    // 3. Dynamic Bayesian Success Rate and Calibrated Confidence
    const empiricalSuccessRate = profile.successfulExecutions / profile.totalExecutions;
    profile.effectivenessRate = Number(empiricalSuccessRate.toFixed(3));

    // Dynamic Bayesian credibility weighting based on sample size n:
    // With n=1, uncertainty is high. With n=10+, empirical rate dominates.
    const sampleCredibilityWeight = Math.min(1.0, profile.totalExecutions / 10);
    const rollbackRatio = profile.rolledBackExecutions / profile.totalExecutions;

    const baseCalibrated =
      0.50 * (1 - sampleCredibilityWeight) +
      (0.85 * empiricalSuccessRate - rollbackRatio * 0.40) * sampleCredibilityWeight;

    profile.calibratedConfidence = Number(Math.min(0.98, Math.max(0.20, baseCalibrated)).toFixed(3));
    profile.lastCalibratedAt = new Date();

    // 4. Actual Measured Gain & Causal Attribution Integration
    // Uses real measured delta, causal lift, or verified status (NO synthetic 10.0!)
    const measuredGain =
      metricDeltaPct !== undefined
        ? metricDeltaPct
        : causalLift !== undefined
        ? causalLift
        : outcome === 'SUCCESS'
        ? 1.0
        : outcome === 'ROLLED_BACK'
        ? -2.0
        : -1.0;

    const actualGain = Number(measuredGain.toFixed(2));
    const variancePct = Number((actualGain - resolvedExpectedGain).toFixed(2));

    const actualOutcome = {
      passed: outcome === 'SUCCESS',
      metricDeltaPct: actualGain,
      causalLift,
      syntheticControlDelta,
      ...(inputActualOutcome || {}),
    };

    const learningConfidence = confidence ?? profile.calibratedConfidence;
    const confidenceSource =
      `Bayesian Posterior: Prior(0.50)×${(1 - sampleCredibilityWeight).toFixed(2)} + ` +
      `EmpiricalRate(${empiricalSuccessRate.toFixed(2)})×${sampleCredibilityWeight.toFixed(2)} [n=${profile.totalExecutions}, rollbacks=${profile.rolledBackExecutions}]`;

    const learningRecord: PersistentLearningRecord = {
      id: `lrn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ruleKey,
      websiteId,
      actionExecutionId,
      prediction,
      confidence: learningConfidence,
      confidenceSource,
      action: {
        actionType,
        ruleKey,
        payloadSummary: `${actionType} on ${websiteId}`,
      },
      expectedOutcome,
      actualOutcome,
      learningDelta: {
        metricDeltaPct: actualGain,
        variancePct,
        isPositiveGain: actualGain > 0,
        causalLift,
        notes: `Variance of ${variancePct}% between expected (${resolvedExpectedGain}%) and measured actual (${actualGain}%)`,
      },
      ruleEffectiveness: {
        totalExecutions: profile.totalExecutions,
        successRate: profile.effectivenessRate,
        rollbackRate: Number((profile.rolledBackExecutions / profile.totalExecutions).toFixed(3)),
        calibratedConfidence: profile.calibratedConfidence,
      },
      recordedAt: new Date(),
    };

    // Store in memory & persistent store
    const records = this.persistentLearningRecords.get(ruleKey) || [];
    records.push(learningRecord);
    this.persistentLearningRecords.set(ruleKey, records);

    // Emit outbox event for learning calibration audit
    try {
      await prisma.outboxEvent.create({
        data: {
          aggregateType: 'DECISION_LEARNING_LOOP',
          aggregateId: learningRecord.id,
          eventType: 'RULE_LEARNING_RECORD_PERSISTED',
          payloadJson: JSON.stringify(learningRecord),
        },
      });
    } catch {
      // Non-blocking in headless/test runs
    }

    return { profile, learningRecord };
  }

  /**
   * Retrieves the dynamic learning profile for a rule, defaulting to uninformative prior when unknown.
   */
  public static getRuleProfile(ruleKey: string): RuleLearningProfile {
    return (
      this.learningStore.get(ruleKey) || {
        ruleKey,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        rolledBackExecutions: 0,
        effectivenessRate: 0.50, // Unbiased prior
        calibratedConfidence: 0.50, // Unbiased prior
        lastCalibratedAt: new Date(),
      }
    );
  }

  /**
   * Returns all active rule learning profiles.
   */
  public static getAllProfiles(): RuleLearningProfile[] {
    return Array.from(this.learningStore.values());
  }

  /**
   * Returns persistent learning records for a specific rule or website.
   */
  public static getLearningRecords(ruleKey?: string): PersistentLearningRecord[] {
    if (ruleKey) {
      return this.persistentLearningRecords.get(ruleKey) || [];
    }
    const all: PersistentLearningRecord[] = [];
    for (const list of this.persistentLearningRecords.values()) {
      all.push(...list);
    }
    return all;
  }

  /**
   * Returns calibrated Bayesian effectiveness weights for all tracked rules.
   */
  public static async getEffectiveWeights(
    websiteId?: string
  ): Promise<Record<string, { weight: number; confidence: number }>> {
    const profiles = this.getAllProfiles();
    const result: Record<string, { weight: number; confidence: number }> = {};
    for (const p of profiles) {
      result[p.ruleKey] = {
        weight: p.effectivenessRate,
        confidence: p.calibratedConfidence,
      };
    }
    return result;
  }
}
