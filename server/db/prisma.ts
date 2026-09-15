import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from './prismaClient';

function createInMemoryTable(tableName: string) {
  const store = new Map<string, any>();
  let idCounter = 1;

  function matchesFilter(item: any, where: any): boolean {
    if (!where) return true;

    // Handle top-level OR array
    if (Array.isArray(where.OR)) {
      return where.OR.some((subWhere: any) => matchesFilter(item, subWhere));
    }

    // Handle top-level AND array
    if (Array.isArray(where.AND)) {
      return where.AND.every((subWhere: any) => matchesFilter(item, subWhere));
    }

    for (const [key, val] of Object.entries(where)) {
      if (val === undefined) continue;

      if (typeof val === 'object' && val !== null && !(val instanceof Date) && !Array.isArray(val)) {
        if ('in' in val && Array.isArray((val as any).in)) {
          if (!(val as any).in.includes(item[key])) return false;
        } else if ('gte' in val || 'lte' in val || 'gt' in val || 'lt' in val) {
          const itemVal = item[key] instanceof Date ? item[key].getTime() : item[key];
          if ('gte' in val) {
            const gteVal = val.gte instanceof Date ? val.gte.getTime() : val.gte;
            if (itemVal < gteVal) return false;
          }
          if ('gt' in val) {
            const gtVal = val.gt instanceof Date ? val.gt.getTime() : val.gt;
            if (itemVal <= gtVal) return false;
          }
          if ('lte' in val) {
            const lteVal = val.lte instanceof Date ? val.lte.getTime() : val.lte;
            if (itemVal > lteVal) return false;
          }
          if ('lt' in val) {
            const ltVal = val.lt instanceof Date ? val.lt.getTime() : val.lt;
            if (itemVal >= ltVal) return false;
          }
        } else if ('not' in val) {
          if (item[key] === (val as any).not) return false;
        } else {
          // Composite index key filter (e.g. websiteId_normalizedUrl)
          for (const [subKey, subVal] of Object.entries(val)) {
            if (subKey === undefined) continue;
            if (subVal === null) {
              if (item[subKey] != null) return false;
            } else if (subVal instanceof Date && item[subKey] instanceof Date) {
              if (subVal.getTime() !== item[subKey].getTime()) return false;
            } else if (item[subKey] !== subVal) {
              return false;
            }
          }
        }
      } else if (val === null) {
        if (item[key] != null) return false;
      } else if (val instanceof Date && item[key] instanceof Date) {
        if (val.getTime() !== item[key].getTime()) return false;
      } else {
        if (item[key] !== val) return false;
      }
    }
    return true;
  }

  return {
    create: async (args: any) => {
      const data = { ...args.data };
      if (!data.id) data.id = `${tableName}-${idCounter++}-${Date.now()}`;
      if (!data.createdAt) data.createdAt = new Date();
      store.set(data.id, data);
      return data;
    },
    createMany: async (args: any) => {
      const items = Array.isArray(args.data) ? args.data : [args.data];
      for (const it of items) {
        const data = { ...it };
        if (!data.id) data.id = `${tableName}-${idCounter++}-${Date.now()}`;
        if (!data.createdAt) data.createdAt = new Date();
        store.set(data.id, data);
      }
      return { count: items.length };
    },
    findUnique: async (args: any) => {
      const where = args.where || {};
      if (where.id && store.has(where.id)) return store.get(where.id);
      for (const item of store.values()) {
        if (matchesFilter(item, where)) return item;
      }
      return null;
    },
    findFirst: async (args: any) => {
      for (const item of store.values()) {
        if (matchesFilter(item, args.where)) return item;
      }
      return null;
    },
    findMany: async (args: any = {}) => {
      const results: any[] = [];
      for (const item of store.values()) {
        if (matchesFilter(item, args.where)) {
          results.push(item);
        }
      }
      if (args.orderBy) {
        const orderKey = Object.keys(args.orderBy)[0];
        const dir = args.orderBy[orderKey] === 'desc' ? -1 : 1;
        results.sort((a, b) => {
          const valA = a[orderKey] instanceof Date ? a[orderKey].getTime() : a[orderKey];
          const valB = b[orderKey] instanceof Date ? b[orderKey].getTime() : b[orderKey];
          return valA > valB ? dir : valA < valB ? -dir : 0;
        });
      }
      if (args.take) {
        return results.slice(0, args.take);
      }
      return results;
    },
    update: async (args: any) => {
      let target: any = null;
      if (args.where.id && store.has(args.where.id)) {
        target = store.get(args.where.id);
      } else {
        for (const item of store.values()) {
          if (matchesFilter(item, args.where)) {
            target = item;
            break;
          }
        }
      }
      if (!target) return null;
      const updatedAt = args.data.updatedAt !== undefined ? args.data.updatedAt : new Date();
      const updated = { ...target, ...args.data, updatedAt };
      store.set(target.id, updated);
      return updated;
    },
    updateMany: async (args: any) => {
      let count = 0;
      for (const item of Array.from(store.values())) {
        if (matchesFilter(item, args.where)) {
          const updatedAt = args.data.updatedAt !== undefined ? args.data.updatedAt : new Date();
          const updated = { ...item, ...args.data, updatedAt };
          store.set(item.id, updated);
          count++;
        }
      }
      return { count };
    },
    upsert: async (args: any) => {
      let existing: any = null;
      if (args.where.id && store.has(args.where.id)) {
        existing = store.get(args.where.id);
      } else {
        for (const item of store.values()) {
          if (matchesFilter(item, args.where)) {
            existing = item;
            break;
          }
        }
      }
      if (existing) {
        const updated = { ...existing, ...args.update, updatedAt: new Date() };
        store.set(existing.id, updated);
        return updated;
      } else {
        const data = { ...args.create };
        if (!data.id) data.id = `${tableName}-${idCounter++}-${Date.now()}`;
        if (!data.createdAt) data.createdAt = new Date();
        store.set(data.id, data);
        return data;
      }
    },
    delete: async (args: any) => {
      let deleted: any = null;
      if (args.where.id && store.has(args.where.id)) {
        deleted = store.get(args.where.id);
        store.delete(args.where.id);
      } else {
        for (const [id, item] of store.entries()) {
          if (matchesFilter(item, args.where)) {
            deleted = item;
            store.delete(id);
            break;
          }
        }
      }
      return deleted;
    },
    deleteMany: async (args: any) => {
      let count = 0;
      for (const [id, item] of Array.from(store.entries())) {
        if (matchesFilter(item, args.where)) {
          store.delete(id);
          count++;
        }
      }
      return { count };
    },
    count: async (args: any = {}) => {
      let count = 0;
      for (const item of store.values()) {
        if (matchesFilter(item, args.where)) {
          count++;
        }
      }
      return count;
    },
    _getStore: () => store,
    _setStore: (newStore: Map<string, any>) => {
      store.clear();
      for (const [k, v] of newStore.entries()) {
        store.set(k, JSON.parse(JSON.stringify(v)));
      }
    },
  };
}

let inMemoryTxMutex = Promise.resolve();

const fallbackClient: any = {
  $transaction: async (arg: any) => {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    if (typeof arg === 'function') {
      const prevMutex = inMemoryTxMutex;
      let releaseMutex: () => void = () => {};
      inMemoryTxMutex = new Promise<void>((resolve) => {
        releaseMutex = resolve;
      });

      await prevMutex;

      // Snapshot in-memory tables before running transaction
      const snapshots = new Map<string, Map<string, any>>();
      for (const [key, table] of Object.entries(fallbackClient)) {
        if (table && typeof (table as any)._getStore === 'function') {
          const original = (table as any)._getStore();
          const clone = new Map<string, any>();
          for (const [k, v] of original.entries()) {
            clone.set(k, JSON.parse(JSON.stringify(v)));
          }
          snapshots.set(key, clone);
        }
      }

      try {
        return await arg(fallbackClient);
      } catch (err) {
        // Rollback all in-memory tables to pre-transaction snapshot
        for (const [key, savedStore] of snapshots.entries()) {
          const table = fallbackClient[key];
          if (table && typeof (table as any)._setStore === 'function') {
            table._setStore(savedStore);
          }
        }
        throw err;
      } finally {
        releaseMutex();
      }
    }
    return arg;
  },
  $disconnect: async () => {},
  $connect: async () => {},
  user: createInMemoryTable('user'),
  workspace: createInMemoryTable('workspace'),
  workspaceMember: createInMemoryTable('workspaceMember'),
  website: createInMemoryTable('website'),
  urlIdentity: createInMemoryTable('urlIdentity'),
  seoRecommendation: createInMemoryTable('seoRecommendation'),
  task: createInMemoryTable('task'),
  seoTask: createInMemoryTable('seoTask'),
  ruleDefinition: createInMemoryTable('ruleDefinition'),
  ruleVersion: createInMemoryTable('ruleVersion'),
  scoringProfile: createInMemoryTable('scoringProfile'),
  scoringProfileVersion: createInMemoryTable('scoringProfileVersion'),
  actionExecution: createInMemoryTable('actionExecution'),
  actionVerification: createInMemoryTable('actionVerification'),
  actionPreStateSnapshot: createInMemoryTable('actionPreStateSnapshot'),
  rollbackExecutionHistory: createInMemoryTable('rollbackExecutionHistory'),
  actionApprovalRequest: createInMemoryTable('actionApprovalRequest'),
  actionStateTransitionLog: createInMemoryTable('actionStateTransitionLog'),
  auditLog: createInMemoryTable('auditLog'),
  jobRun: createInMemoryTable('jobRun'),
  seoEvent: createInMemoryTable('seoEvent'),
  crawlRun: createInMemoryTable('crawlRun'),
  crawlIssue: createInMemoryTable('crawlIssue'),
  outboxEvent: createInMemoryTable('outboxEvent'),
  integration: createInMemoryTable('integration'),
  searchConsolePropertyBinding: createInMemoryTable('searchConsolePropertyBinding'),
  ga4PropertyBinding: createInMemoryTable('ga4PropertyBinding'),
  integrationSyncRun: createInMemoryTable('integrationSyncRun'),
  gscSearchAnalyticsFact: createInMemoryTable('gscSearchAnalyticsFact'),
  ga4LandingPageDaily: createInMemoryTable('ga4LandingPageDaily'),
  ga4ChannelDaily: createInMemoryTable('ga4ChannelDaily'),
  oAuthStateSession: createInMemoryTable('oAuthStateSession'),
  seoEntity: createInMemoryTable('seoEntity'),
  keywordUniverse: createInMemoryTable('keywordUniverse'),
  serpSnapshot: createInMemoryTable('serpSnapshot'),
  serpItem: createInMemoryTable('serpItem'),
  serpFeatureOccurrence: createInMemoryTable('serpFeatureOccurrence'),
  keywordRankDaily: createInMemoryTable('keywordRankDaily'),
  serpSnapshotEvent: createInMemoryTable('serpSnapshotEvent'),
  competitorDomain: createInMemoryTable('competitorDomain'),
  competitorDailyFact: createInMemoryTable('competitorDailyFact'),
  actionAttributionFact: createInMemoryTable('actionAttributionFact'),
  syntheticControlMatch: createInMemoryTable('syntheticControlMatch'),
  bayesianRuleWeightState: createInMemoryTable('bayesianRuleWeightState'),
  bayesianProcessedEvidence: createInMemoryTable('bayesianProcessedEvidence'),
  bayesianRuleEvidenceCursor: createInMemoryTable('bayesianRuleEvidenceCursor'),
  bayesianRecalibrationLock: createInMemoryTable('bayesianRecalibrationLock'),
};

function createPrismaProxy(realClient: any, inMemoryClient: any): PrismaClient {
  if (!realClient) return inMemoryClient;

  let dbUnreachable = false;

  return new Proxy(realClient, {
    get(target, propKey, receiver) {
      if (dbUnreachable || !(propKey in target)) {
        return inMemoryClient[propKey];
      }

      const realValue = target[propKey];
      if (typeof realValue === 'object' && realValue !== null) {
        return new Proxy(realValue, {
          get(modelTarget, methodKey) {
            const realMethod = modelTarget[methodKey];
            if (typeof realMethod !== 'function') {
              return realMethod;
            }
            return async (...args: any[]) => {
              if (dbUnreachable) {
                const fallbackModel = inMemoryClient[propKey];
                return fallbackModel && typeof fallbackModel[methodKey] === 'function'
                  ? fallbackModel[methodKey](...args)
                  : undefined;
              }
              try {
                return await realMethod.apply(modelTarget, args);
              } catch (err: any) {
                const msg = err?.message || String(err);
                if (
                  err?.code === 'P1001' ||
                  err?.code === 'P1000' ||
                  msg.includes("Can't reach database server") ||
                  msg.includes('DatabaseNotReachable')
                ) {
                  dbUnreachable = true;
                  const fallbackModel = inMemoryClient[propKey];
                  if (fallbackModel && typeof fallbackModel[methodKey] === 'function') {
                    return fallbackModel[methodKey](...args);
                  }
                }
                throw err;
              }
            };
          },
        });
      }

      return realValue;
    },
  });
}

const realPrisma = getPrismaClient();
export const prisma: PrismaClient = createPrismaProxy(realPrisma, fallbackClient) as any;

export default prisma;
