import { prisma } from '../../db/prisma';
import { RuleLearningProfile } from './decisionTypes';

export interface PersistentLearningRecord {
  id: string;
  ruleKey: string;
  websiteId: string;
  actionExecutionId?: string;
  evaluationStage: 'STAGE_3_VERIFIED_EXECUTION' | 'STAGE_6_POST_OBSERVATION_PERFORMANCE';
  executionSuccess: boolean;
  performanceSuccess: boolean | 'PENDING_OBSERVATION_WINDOW';
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
    observedPerformanceTrials: number;
    performanceSuccessRate: number;
    isConfidenceScaleUpAllowed: boolean;
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
    isPostObservationPerformance?: boolean;
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
      isPostObservationPerformance = false,
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
        effectivenessRate: 0.50, // Execution effectiveness
        performanceSuccessRate: 0.50, // Search performance effectiveness
        observedPerformanceTrials: 0,
        performanceVariance: 0.0,
        hasCausalEvidence: false,
        calibratedConfidence: 0.50, // Uninformative 50/50 prior, no default 0.90 assumption
        isConfidenceScaleUpAllowed: false,
        lastCalibratedAt: new Date(),
      };
      this.learningStore.set(ruleKey, profile);
    }

    // Update execution counters
    const isExecutionSuccess = outcome === 'SUCCESS';
    profile.totalExecutions += 1;
    if (outcome === 'SUCCESS') {
      profile.successfulExecutions += 1;
    } else if (outcome === 'FAILED') {
      profile.failedExecutions += 1;
    } else if (outcome === 'ROLLED_BACK') {
      profile.rolledBackExecutions += 1;
    }

    // Execution rate tracks technical deployment reliability
    profile.effectivenessRate = Number((profile.successfulExecutions / profile.totalExecutions).toFixed(3));

    // 3. Post-Observation Performance Evaluation vs Technical Execution Success
    const evaluationStage: 'STAGE_3_VERIFIED_EXECUTION' | 'STAGE_6_POST_OBSERVATION_PERFORMANCE' =
      isPostObservationPerformance ? 'STAGE_6_POST_OBSERVATION_PERFORMANCE' : 'STAGE_3_VERIFIED_EXECUTION';

    let performanceSuccess: boolean | 'PENDING_OBSERVATION_WINDOW' = 'PENDING_OBSERVATION_WINDOW';

    if (isPostObservationPerformance) {
      profile.observedPerformanceTrials += 1;
      const isPositiveLift =
        (metricDeltaPct !== undefined && metricDeltaPct > 0) || (causalLift !== undefined && causalLift > 0);
      performanceSuccess = isPositiveLift;

      // Compute performance variance across recorded trials
      const existingRecords = (this.persistentLearningRecords.get(ruleKey) || []).filter(
        (r) => r.evaluationStage === 'STAGE_6_POST_OBSERVATION_PERFORMANCE' && r.learningDelta.metricDeltaPct !== undefined
      );
      const deltas = [...existingRecords.map((r) => r.learningDelta.metricDeltaPct || 0), metricDeltaPct || 0];

      if (deltas.length >= 2) {
        const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const variance = deltas.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / deltas.length;
        profile.performanceVariance = Number(variance.toFixed(4));
      } else {
        profile.performanceVariance = 0.0;
      }

      // Check causal evidence: causal lift must exceed synthetic control delta
      const confirmedCausalLift = causalLift !== undefined && causalLift > (syntheticControlDelta || 0);
      if (confirmedCausalLift) {
        profile.hasCausalEvidence = true;
      }

      const successfulTrials = deltas.filter((d) => d > 0).length;
      profile.performanceSuccessRate = Number((successfulTrials / profile.observedPerformanceTrials).toFixed(3));
    }

    // SAFETY RULE ENFORCEMENT:
    // Do NOT increase rule confidence from a single experiment.
    // Require:
    // 1. Multiple successful observations (>= 3)
    // 2. Consistent results (variance <= 0.35)
    // 3. Causal evidence
    const hasMultipleObservations = profile.observedPerformanceTrials >= 3;
    const hasConsistentResults = profile.performanceVariance <= 0.35;
    const hasCausalEvidence = profile.hasCausalEvidence;

    profile.isConfidenceScaleUpAllowed = hasMultipleObservations && hasConsistentResults && hasCausalEvidence;

    if (profile.isConfidenceScaleUpAllowed) {
      // Scale up confidence smoothly based on empirical success rate and sample size
      const sampleWeight = Math.min(1.0, profile.observedPerformanceTrials / 10);
      const scaled = 0.50 * (1 - sampleWeight) + profile.performanceSuccessRate * 0.90 * sampleWeight;
      profile.calibratedConfidence = Number(Math.min(0.96, Math.max(0.50, scaled)).toFixed(3));
    } else {
      // Confidence CANNOT increase above baseline prior (0.50) without multiple observations + consistency + causal evidence.
      // If there are failures or rollbacks, confidence scales DOWN safely.
      const failurePenalty = (profile.failedExecutions + profile.rolledBackExecutions * 2) * 0.08;
      profile.calibratedConfidence = Number(Math.max(0.20, 0.50 - failurePenalty).toFixed(3));
    }

    profile.lastCalibratedAt = new Date();

    // 4. Learning Delta Computation
    const measuredGain =
      metricDeltaPct !== undefined
        ? metricDeltaPct
        : causalLift !== undefined
        ? causalLift
        : isExecutionSuccess
        ? 0.0 // Execution verified, but SEO performance pending observation
        : outcome === 'ROLLED_BACK'
        ? -2.0
        : -1.0;

    const actualGain = Number(measuredGain.toFixed(2));
    const variancePct = Number((actualGain - resolvedExpectedGain).toFixed(2));

    const actualOutcome = {
      passed: isExecutionSuccess,
      metricDeltaPct: actualGain,
      causalLift,
      syntheticControlDelta,
      ...(inputActualOutcome || {}),
    };

    const learningConfidence = confidence ?? profile.calibratedConfidence;
    const confidenceSource = profile.isConfidenceScaleUpAllowed
      ? `Calibrated Empirical: Multi-trial verified (${profile.observedPerformanceTrials} observations, variance=${profile.performanceVariance}, causal=confirmed) => ${profile.calibratedConfidence}`
      : `Safety Prior Anchored: Confidence scale-up gated (requires >= 3 observations [currently ${profile.observedPerformanceTrials}], consistency, and causal proof) => ${profile.calibratedConfidence}`;

    const learningRecord: PersistentLearningRecord = {
      id: `lrn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ruleKey,
      websiteId,
      actionExecutionId,
      evaluationStage,
      executionSuccess: isExecutionSuccess,
      performanceSuccess,
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
        notes: isPostObservationPerformance
          ? `Post-observation performance measured: ${actualGain}% gain vs expected ${resolvedExpectedGain}%`
          : `Execution successfully verified on DOM. Performance measurement pending observation window.`,
      },
      ruleEffectiveness: {
        totalExecutions: profile.totalExecutions,
        successRate: profile.effectivenessRate,
        rollbackRate: Number((profile.rolledBackExecutions / Math.max(1, profile.totalExecutions)).toFixed(3)),
        calibratedConfidence: profile.calibratedConfidence,
        observedPerformanceTrials: profile.observedPerformanceTrials,
        performanceSuccessRate: profile.performanceSuccessRate,
        isConfidenceScaleUpAllowed: profile.isConfidenceScaleUpAllowed,
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
        performanceSuccessRate: 0.50,
        observedPerformanceTrials: 0,
        performanceVariance: 0.0,
        hasCausalEvidence: false,
        isConfidenceScaleUpAllowed: false,
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
