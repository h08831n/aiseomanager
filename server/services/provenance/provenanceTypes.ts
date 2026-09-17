/**
 * STRICT SEO DATA PROVENANCE & TRUTH ARCHITECTURE
 *
 * Every SEO metric, observation, ranking fact, and traffic data point
 * in AI SEO Manager MUST be tagged with a verifiable provenance source.
 *
 * MANDATE:
 * - Real SEO claims can ONLY be established by GOOGLE_SEARCH_CONSOLE, GOOGLE_ANALYTICS, or SERP_PROVIDER.
 * - INTERNAL_DIAGNOSTIC (code hygiene, crawl audit) is strictly for code quality, never ranking proof.
 * - SIMULATION mode generates synthetic telemetry for developer/testing sandboxes, but MUST NEVER:
 *   1. Update Bayesian confidence
 *   2. Update rule effectiveness
 *   3. Appear as real SEO improvement
 */

export type MetricProvenanceSource =
  | 'GOOGLE_SEARCH_CONSOLE'
  | 'GOOGLE_ANALYTICS'
  | 'SERP_PROVIDER'
  | 'INTERNAL_DIAGNOSTIC'
  | 'SIMULATION';

export interface ProvenanceValue<T = number> {
  value: T;
  source: MetricProvenanceSource;
  isEmpirical: boolean;
  collectedAt: string;
  sourceDetails?: string;
}

export interface ProvenanceMetricRecord {
  metricName: string;
  provenance: MetricProvenanceSource;
  isVerifiableLiveProof: boolean;
  timestamp: string;
  meta?: Record<string, any>;
}

export class ProvenanceGuard {
  /**
   * Evaluates whether a collection of metrics meets strict empirical criteria
   * for proving real-world ranking or traffic improvement.
   */
  public static canClaimSeoImprovement(sources: MetricProvenanceSource[]): boolean {
    if (!sources || sources.length === 0) return false;
    // If ANY source is SIMULATION or INTERNAL_DIAGNOSTIC used as primary proof, fail immediately
    const hasEmpiricalExternalProof = sources.some(
      (s) => s === 'GOOGLE_SEARCH_CONSOLE' || s === 'GOOGLE_ANALYTICS' || s === 'SERP_PROVIDER'
    );
    const hasOnlySimOrDiag = sources.every(
      (s) => s === 'SIMULATION' || s === 'INTERNAL_DIAGNOSTIC'
    );
    return hasEmpiricalExternalProof && !hasOnlySimOrDiag;
  }

  /**
   * Ensures that learning loop updates are strictly rejected if derived from
   * non-empirical or simulated sources.
   */
  public static assertAllowedForLearningLoop(source: MetricProvenanceSource, context?: string): void {
    if (source === 'SIMULATION') {
      throw new Error(
        `PROVENANCE_VIOLATION: Simulation metrics must NEVER update Bayesian confidence or rule effectiveness (${context || 'LearningLoop'}).`
      );
    }
    if (source === 'INTERNAL_DIAGNOSTIC') {
      throw new Error(
        `PROVENANCE_VIOLATION: Internal diagnostic/DOM scores must NEVER update SEO effectiveness rates or confidence (${context || 'LearningLoop'}).`
      );
    }
  }
}
