import { IActionExecutor } from './actionExecutorInterface';
import { ActionType } from '../actionTypes';
import { CanonicalActionExecutor } from './canonicalActionExecutor';
import { MetaTagsActionExecutor } from './metaTagsActionExecutor';
import { StructuredDataActionExecutor } from './structuredDataActionExecutor';
import { RedirectActionExecutor } from './redirectActionExecutor';
import { InternalLinkActionExecutor } from './internalLinkActionExecutor';
import { ContentRefreshActionExecutor } from './contentRefreshActionExecutor';

export class ActionExecutorRouter {
  private static executors: Map<string, IActionExecutor> = new Map();

  static {
    const canonical = new CanonicalActionExecutor();
    const meta = new MetaTagsActionExecutor();
    const schema = new StructuredDataActionExecutor();
    const redirect = new RedirectActionExecutor();
    const internalLink = new InternalLinkActionExecutor();
    const contentRefresh = new ContentRefreshActionExecutor();

    this.registerExecutor(canonical);
    this.registerExecutor(meta);
    this.registerExecutor(schema);
    this.registerExecutor(redirect);
    this.registerExecutor(internalLink);
    this.registerExecutor(contentRefresh);

    // Aliases matching the 5 core autonomous action categories
    this.executors.set('UPDATE_METADATA', meta);
    this.executors.set('UPDATE_SCHEMA', schema);
    this.executors.set('IMPROVE_INTERNAL_LINKS', internalLink);
    this.executors.set('CONTENT_OPTIMIZATION', contentRefresh);
    this.executors.set('TECHNICAL_FIX', canonical);
  }

  public static registerExecutor(executor: IActionExecutor): void {
    this.executors.set(executor.actionType, executor);
  }

  public static getExecutor(actionType: string): IActionExecutor {
    const normalized = actionType.toUpperCase();
    const executor = this.executors.get(normalized) || this.executors.get(actionType);
    if (!executor) {
      throw new Error(`No action executor registered for action type: '${actionType}'`);
    }
    return executor;
  }

  public static hasExecutor(actionType: string): boolean {
    const normalized = actionType.toUpperCase();
    return this.executors.has(normalized) || this.executors.has(actionType);
  }
}
