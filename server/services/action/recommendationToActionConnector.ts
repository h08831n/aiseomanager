import { GeneratedSeoTask } from '../ai/aiSeoStrategistService';
import { ActionExecutionPipelineParams } from './actionExecutionPipeline';
import { UrlNormalizer } from '../crawler/urlNormalizer';

export type ExecutableActionCategory =
  | 'UPDATE_METADATA'
  | 'UPDATE_SCHEMA'
  | 'IMPROVE_INTERNAL_LINKS'
  | 'CONTENT_OPTIMIZATION'
  | 'TECHNICAL_FIX';

export interface ConnectedExecutableAction {
  category: ExecutableActionCategory;
  actionType: string;
  targetUrl: string;
  payload: Record<string, any>;
  pipelineParams: ActionExecutionPipelineParams;
  evidence: string;
  opportunityScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiresApproval: boolean;
  rollbackMethod: string;
  verificationMethod: string;
}

export class RecommendationToActionConnector {
  /**
   * Connects an AI/deterministic SEO recommendation to a real executable action payload.
   * Maps tasks directly into one of the 5 supported operational action categories:
   * 1. Update metadata
   * 2. Update schema
   * 3. Improve internal links
   * 4. Content optimization tasks
   * 5. Technical fixes
   */
  public static connectRecommendation(params: {
    task: GeneratedSeoTask;
    websiteId: string;
    domain: string;
    platform?: string;
    userId?: string;
  }): ConnectedExecutableAction {
    const { task, websiteId, domain, platform = 'WORDPRESS', userId = 'AUTONOMOUS_ENGINE' } = params;
    const targetUrl = UrlNormalizer.normalize(task.targetUrl);

    let category: ExecutableActionCategory;
    let actionType: string;
    let payload: Record<string, any>;
    let rollbackMethod: string;
    let verificationMethod: string;

    switch (task.actionType) {
      case 'SET_META_TAGS':
      default:
        if (task.actionType === 'INJECT_STRUCTURED_DATA') {
          category = 'UPDATE_SCHEMA';
          actionType = 'INJECT_STRUCTURED_DATA';
          payload = {
            targetUrl,
            schemaType: task.actionPayload?.schemaType || 'Organization',
            schemaJsonLd: task.actionPayload?.schemaJsonLd || {
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: domain.replace(/\.[a-z]+$/, '').toUpperCase(),
              url: `https://${domain}`,
            },
          };
          rollbackMethod = 'Revert to pre-state DOM without injected JSON-LD script tag.';
          verificationMethod = 'Live DOM inspection of <script type="application/ld+json"> and Schema.org syntax validation.';
        } else if (task.actionType === 'INJECT_INTERNAL_LINK') {
          category = 'IMPROVE_INTERNAL_LINKS';
          actionType = 'INJECT_INTERNAL_LINK';
          payload = {
            sourceUrl: task.actionPayload?.sourceUrl || `https://${domain}/`,
            targetUrl,
            anchorText: task.actionPayload?.anchorText || task.targetKeyword || 'راهنمای جامع',
          };
          rollbackMethod = 'Restore pre-execution HTML DOM anchor state.';
          verificationMethod = 'HTTP fetch verification of anchor href presence and status code 200 on target.';
        } else if (task.actionType === 'CONTENT_REFRESH_ACTION') {
          category = 'CONTENT_OPTIMIZATION';
          actionType = 'CONTENT_REFRESH_ACTION';
          payload = {
            targetUrl,
            targetKeyword: task.targetKeyword || 'قیمت روز',
            updatedContent: task.actionPayload?.updatedContent || task.actionPayload?.content || 'تحلیل روزانه و مشخصات فنی',
          };
          rollbackMethod = 'CMS revision rollback to prior post/page revision.';
          verificationMethod = 'Live content extraction verifying injected topical clusters and keyword entities.';
        } else if (task.actionType === 'SET_CANONICAL_URL' || task.actionType === 'CREATE_REDIRECT_RULE') {
          category = 'TECHNICAL_FIX';
          actionType = task.actionType;
          payload = task.actionPayload || {
            targetUrl,
            canonicalUrl: targetUrl,
          };
          rollbackMethod = 'Restore previous canonical link element / drop HTTP rewrite redirect rule.';
          verificationMethod = 'HTTP response header and DOM link rel="canonical" extraction.';
        } else {
          category = 'UPDATE_METADATA';
          actionType = 'SET_META_TAGS';
          payload = {
            targetUrl,
            title: task.actionPayload?.title || `${task.targetKeyword || 'قیمت آهن'} - ${domain}`,
            description: task.actionPayload?.description || `بررسی روزانه و قیمت لحظه‌ای در ${domain}.`,
          };
          rollbackMethod = 'Atomic DOM snapshot restore of <title> and <meta name="description"> tags.';
          verificationMethod = 'Live HTTP synthetic DOM extraction verifying updated title and meta description strings.';
        }
        break;
    }

    const idempotencyKey = `exec-${websiteId}-${actionType}-${targetUrl.replace(/[^a-zA-Z0-9]/g, '_')}`;

    const pipelineParams: ActionExecutionPipelineParams = {
      websiteId,
      taskId: task.id,
      recommendationId: task.id,
      actionType,
      targetUrl,
      payload,
      idempotencyKey,
      executionMode: task.risk?.requiresApproval || task.riskLevel !== 'LOW' ? 'MANUAL' : 'AUTONOMOUS',
      userId,
      platform,
      autoVerify: true,
    };

    return {
      category,
      actionType,
      targetUrl,
      payload,
      pipelineParams,
      evidence: task.evidence || `Audited DOM issue on ${targetUrl}`,
      opportunityScore: task.opportunityScore || 75,
      riskLevel: task.riskLevel || 'LOW',
      requiresApproval: task.risk?.requiresApproval || task.riskLevel !== 'LOW',
      rollbackMethod,
      verificationMethod,
    };
  }
}
