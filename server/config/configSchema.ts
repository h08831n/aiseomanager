import { isProductionMode, getAppMode } from './runtimeMode';

export type EnvironmentScope = 'server' | 'client' | 'shared';
export type RequirementType = 'required' | 'optional' | 'required_in_production';

export interface ValidationResult {
  valid: boolean;
  issue?: 'MISSING' | 'PLACEHOLDER' | 'INVALID_FORMAT';
  error?: string;
}

export interface ConfigVariableSchema {
  name: string;
  required: RequirementType;
  default?: string;
  environmentScope: EnvironmentScope;
  description: string;
  validationRule: {
    ruleDescription: string;
    validate: (value: string | undefined, env: NodeJS.ProcessEnv) => ValidationResult;
  };
}

export const COMMON_PLACEHOLDER_SUBSTRINGS = [
  'placeholder',
  'changeme',
  'change-me',
  'change_me',
  'your-client-id',
  'your-client-secret',
  'your-password',
  'your-encryption-key',
  'your-secret',
  'your-project',
  'my-secret',
  'fake',
  'dummy',
  'todo',
  'example',
] as const;

export function containsPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return COMMON_PLACEHOLDER_SUBSTRINGS.some((ph) => lower.includes(ph));
}

/**
 * Single source of truth configuration schema for all application environment variables.
 */
export const CONFIG_SCHEMA: Record<string, ConfigVariableSchema> = {
  DATABASE_URL: {
    name: 'DATABASE_URL',
    required: 'required_in_production',
    default: undefined,
    environmentScope: 'server',
    description: 'Pooled PostgreSQL connection string for application runtime queries and persistence.',
    validationRule: {
      ruleDescription: "Must be a valid PostgreSQL connection URI starting with 'postgresql://' or 'postgres://', free of placeholders.",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: false, issue: 'MISSING', error: 'DATABASE_URL is missing or empty.' };
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'DATABASE_URL contains forbidden placeholder string.' };
        }
        if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
          return { valid: false, issue: 'INVALID_FORMAT', error: "DATABASE_URL must begin with 'postgresql://' or 'postgres://'." };
        }
        return { valid: true };
      },
    },
  },

  DIRECT_URL: {
    name: 'DIRECT_URL',
    required: 'required_in_production',
    default: undefined,
    environmentScope: 'server',
    description: 'Direct unpooled PostgreSQL connection string used exclusively by Prisma migrations and schema synchronization.',
    validationRule: {
      ruleDescription: "Must be a direct PostgreSQL connection URI starting with 'postgresql://' or 'postgres://', free of placeholders.",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: false, issue: 'MISSING', error: 'DIRECT_URL is missing or empty.' };
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'DIRECT_URL contains forbidden placeholder string.' };
        }
        if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
          return { valid: false, issue: 'INVALID_FORMAT', error: "DIRECT_URL must begin with 'postgresql://' or 'postgres://'." };
        }
        return { valid: true };
      },
    },
  },

  ENCRYPTION_MASTER_KEY: {
    name: 'ENCRYPTION_MASTER_KEY',
    required: 'required_in_production',
    default: undefined,
    environmentScope: 'server',
    description: '32-byte master encryption key for AES-256-GCM token and credential encryption at rest.',
    validationRule: {
      ruleDescription: 'Must be a 64-character hex string (32 bytes) or at least 32 raw UTF-8 bytes, free of placeholders.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: false, issue: 'MISSING', error: 'ENCRYPTION_MASTER_KEY is missing or empty.' };
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'ENCRYPTION_MASTER_KEY contains forbidden placeholder string.' };
        }
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          return { valid: true };
        }
        if (Buffer.byteLength(trimmed, 'utf8') >= 32) {
          return { valid: true };
        }
        return {
          valid: false,
          issue: 'INVALID_FORMAT',
          error: 'ENCRYPTION_MASTER_KEY must be a 64-character hex string or >= 32 bytes (generate with `openssl rand -hex 32`).',
        };
      },
    },
  },

  GOOGLE_CLIENT_ID: {
    name: 'GOOGLE_CLIENT_ID',
    required: 'required_in_production',
    default: undefined,
    environmentScope: 'server',
    description: 'Google Cloud OAuth 2.0 Web Application Client ID for Search Console and GA4 API integrations.',
    validationRule: {
      ruleDescription: "Must be a valid Google OAuth Client ID (typically ending in '.apps.googleusercontent.com'), free of placeholders.",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: false, issue: 'MISSING', error: 'GOOGLE_CLIENT_ID is missing or empty.' };
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'GOOGLE_CLIENT_ID contains forbidden placeholder string.' };
        }
        if (!trimmed.includes('.apps.googleusercontent.com') && !trimmed.includes('-')) {
          return {
            valid: false,
            issue: 'INVALID_FORMAT',
            error: "GOOGLE_CLIENT_ID must be a valid Google OAuth Client ID ending in '.apps.googleusercontent.com'.",
          };
        }
        return { valid: true };
      },
    },
  },

  GOOGLE_CLIENT_SECRET: {
    name: 'GOOGLE_CLIENT_SECRET',
    required: 'required_in_production',
    default: undefined,
    environmentScope: 'server',
    description: 'Google Cloud OAuth 2.0 Client Secret for server-side authorization code exchange.',
    validationRule: {
      ruleDescription: 'Must be a valid Google OAuth client secret with minimum length of 16 characters, free of placeholders.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: false, issue: 'MISSING', error: 'GOOGLE_CLIENT_SECRET is missing or empty.' };
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'GOOGLE_CLIENT_SECRET contains forbidden placeholder string.' };
        }
        if (trimmed.length < 16) {
          return {
            valid: false,
            issue: 'INVALID_FORMAT',
            error: 'GOOGLE_CLIENT_SECRET is unexpectedly short (< 16 characters).',
          };
        }
        return { valid: true };
      },
    },
  },

  GOOGLE_OAUTH_REDIRECT_URI: {
    name: 'GOOGLE_OAUTH_REDIRECT_URI',
    required: 'optional',
    default: 'http://localhost:3000/api/integrations/google/callback',
    environmentScope: 'server',
    description: 'Strictly authorized OAuth redirect callback URI registered in Google Cloud Console.',
    validationRule: {
      ruleDescription: 'Must be a valid absolute HTTP or HTTPS URL. Production mode strictly enforces HTTPS.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: true }; // Uses default if not specified
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'GOOGLE_OAUTH_REDIRECT_URI contains placeholder.' };
        }
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, issue: 'INVALID_FORMAT', error: 'Must be an absolute HTTP or HTTPS URL.' };
          }
          const isProd = (env.APP_MODE || env.NODE_ENV || '').toUpperCase() === 'PRODUCTION';
          if (isProd && parsed.protocol !== 'https:') {
            return { valid: false, issue: 'INVALID_FORMAT', error: 'Must use HTTPS protocol in production mode.' };
          }
          return { valid: true };
        } catch {
          return { valid: false, issue: 'INVALID_FORMAT', error: 'Must be a well-formed absolute URL.' };
        }
      },
    },
  },

  AUTONOMOUS_EXECUTION_ENABLED: {
    name: 'AUTONOMOUS_EXECUTION_ENABLED',
    required: 'optional',
    default: 'false',
    environmentScope: 'shared',
    description: "Safety killswitch for autonomous SEO modifications. Disabled by default ('false').",
    validationRule: {
      ruleDescription: "Must be explicitly declared as 'true' or 'false'. Defaults to 'false' (safe mode).",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: true }; // Defaults to 'false'
        }
        const trimmed = value.trim().toLowerCase();
        if (trimmed !== 'true' && trimmed !== 'false') {
          return {
            valid: false,
            issue: 'INVALID_FORMAT',
            error: "AUTONOMOUS_EXECUTION_ENABLED must be strictly 'true' or 'false'.",
          };
        }
        return { valid: true };
      },
    },
  },

  REDIS_URL: {
    name: 'REDIS_URL',
    required: 'optional',
    default: undefined,
    environmentScope: 'server',
    description: 'Redis connection URI for BullMQ job queues, crawler coordination, and outbox workers.',
    validationRule: {
      ruleDescription: "If provided, must be a valid Redis connection URI starting with 'redis://' or 'rediss://'.",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: true }; // Optional in development
        }
        const trimmed = value.trim();
        if (containsPlaceholder(trimmed)) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'REDIS_URL contains forbidden placeholder string.' };
        }
        if (!trimmed.startsWith('redis://') && !trimmed.startsWith('rediss://')) {
          return { valid: false, issue: 'INVALID_FORMAT', error: "REDIS_URL must begin with 'redis://' or 'rediss://'." };
        }
        return { valid: true };
      },
    },
  },

  APP_MODE: {
    name: 'APP_MODE',
    required: 'optional',
    default: 'DEVELOPMENT',
    environmentScope: 'shared',
    description: 'Explicit application runtime profile.',
    validationRule: {
      ruleDescription: "Must be one of 'PRODUCTION', 'DEVELOPMENT', 'DEMO', or 'TEST'.",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: true };
        }
        const upper = value.trim().toUpperCase();
        if (!['PRODUCTION', 'DEVELOPMENT', 'DEMO', 'TEST'].includes(upper)) {
          return {
            valid: false,
            issue: 'INVALID_FORMAT',
            error: "APP_MODE must be one of 'PRODUCTION', 'DEVELOPMENT', 'DEMO', or 'TEST'.",
          };
        }
        return { valid: true };
      },
    },
  },

  NODE_ENV: {
    name: 'NODE_ENV',
    required: 'optional',
    default: 'development',
    environmentScope: 'shared',
    description: 'Standard Node environment indicator.',
    validationRule: {
      ruleDescription: "Must be 'development', 'production', or 'test'.",
      validate: (value, env) => {
        if (!value || value.trim().length === 0) {
          return { valid: true };
        }
        const lower = value.trim().toLowerCase();
        if (!['development', 'production', 'test'].includes(lower)) {
          return {
            valid: false,
            issue: 'INVALID_FORMAT',
            error: "NODE_ENV must be 'development', 'production', or 'test'.",
          };
        }
        return { valid: true };
      },
    },
  },

  PORT: {
    name: 'PORT',
    required: 'optional',
    default: '3000',
    environmentScope: 'server',
    description: 'HTTP listening port for the web server.',
    validationRule: {
      ruleDescription: 'Must be a valid integer between 1 and 65535.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) return { valid: true };
        const port = parseInt(value.trim(), 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          return { valid: false, issue: 'INVALID_FORMAT', error: 'PORT must be an integer between 1 and 65535.' };
        }
        return { valid: true };
      },
    },
  },

  APP_URL: {
    name: 'APP_URL',
    required: 'optional',
    default: 'http://localhost:3000',
    environmentScope: 'server',
    description: 'Public canonical base URL of the web application.',
    validationRule: {
      ruleDescription: 'Must be a valid absolute HTTP or HTTPS URL.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) return { valid: true };
        try {
          const parsed = new URL(value.trim());
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, issue: 'INVALID_FORMAT', error: 'APP_URL must use http or https.' };
          }
          return { valid: true };
        } catch {
          return { valid: false, issue: 'INVALID_FORMAT', error: 'APP_URL must be a valid URL.' };
        }
      },
    },
  },

  PG_POOL_MAX: {
    name: 'PG_POOL_MAX',
    required: 'optional',
    default: '10',
    environmentScope: 'server',
    description: 'Maximum database pool connections.',
    validationRule: {
      ruleDescription: 'Must be a positive integer.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) return { valid: true };
        const num = parseInt(value.trim(), 10);
        if (isNaN(num) || num < 1) {
          return { valid: false, issue: 'INVALID_FORMAT', error: 'PG_POOL_MAX must be a positive integer.' };
        }
        return { valid: true };
      },
    },
  },

  GEMINI_API_KEY: {
    name: 'GEMINI_API_KEY',
    required: 'optional',
    default: undefined,
    environmentScope: 'server',
    description: 'Google Gemini API key for AI-driven SEO strategist insights and intent analysis.',
    validationRule: {
      ruleDescription: 'If provided, must be a non-empty string free of placeholder tokens.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) return { valid: true };
        if (containsPlaceholder(value.trim())) {
          return { valid: false, issue: 'PLACEHOLDER', error: 'GEMINI_API_KEY contains placeholder string.' };
        }
        return { valid: true };
      },
    },
  },

  CORS_ALLOWED_ORIGINS: {
    name: 'CORS_ALLOWED_ORIGINS',
    required: 'optional',
    default: '*',
    environmentScope: 'server',
    description: 'Comma-separated list of allowed origins for CORS headers.',
    validationRule: {
      ruleDescription: "Must be '*' or a comma-separated list of origin domains.",
      validate: (value, env) => {
        return { valid: true };
      },
    },
  },

  CRAWLER_CONCURRENCY: {
    name: 'CRAWLER_CONCURRENCY',
    required: 'optional',
    default: '2',
    environmentScope: 'server',
    description: 'Maximum concurrent HTTP crawl requests.',
    validationRule: {
      ruleDescription: 'Must be a positive integer.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) return { valid: true };
        const num = parseInt(value.trim(), 10);
        if (isNaN(num) || num < 1) {
          return { valid: false, issue: 'INVALID_FORMAT', error: 'CRAWLER_CONCURRENCY must be a positive integer.' };
        }
        return { valid: true };
      },
    },
  },

  AUTH_JWT_SECRET: {
    name: 'AUTH_JWT_SECRET',
    required: 'optional',
    default: undefined,
    environmentScope: 'server',
    description: 'HMAC secret key used for signing session tokens.',
    validationRule: {
      ruleDescription: 'If provided, must be a secure string with minimum length of 16 characters.',
      validate: (value, env) => {
        if (!value || value.trim().length === 0) return { valid: true };
        if (value.trim().length < 16) {
          return { valid: false, issue: 'INVALID_FORMAT', error: 'AUTH_JWT_SECRET must be at least 16 characters.' };
        }
        return { valid: true };
      },
    },
  },
};

/**
 * Retrieves the full configuration schema.
 */
export function getConfigSchema(): Record<string, ConfigVariableSchema> {
  return CONFIG_SCHEMA;
}

/**
 * Retrieves schema specification for a specific variable by name.
 */
export function getVariableSchema(name: string): ConfigVariableSchema | undefined {
  return CONFIG_SCHEMA[name];
}

/**
 * List of strict production credential requirements.
 */
export const REQUIRED_PRODUCTION_CREDENTIALS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'ENCRYPTION_MASTER_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

export type RequiredProductionCredential = typeof REQUIRED_PRODUCTION_CREDENTIALS[number];
