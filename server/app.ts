import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import crawlRoutes from './routes/crawlRoutes';
import copilotRoutes from './routes/copilotRoutes';
import contentRoutes from './routes/contentRoutes';
import websiteRoutes from './routes/websiteRoutes';
import integrationRoutes from './routes/integrationRoutes';
import taskRoutes from './routes/taskRoutes';
import observabilityRoutes from './routes/observabilityRoutes';
import { keywordRoutes } from './routes/keywordRoutes';
import { serpRoutes } from './routes/serpRoutes';
import { competitorRoutes } from './routes/competitorRoutes';
import decisionRoutes from './routes/decisionRoutes';
import actionRoutes from './routes/actionRoutes';
import authRoutes from './routes/authRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import agentRoutes from './routes/agentRoutes';
import seoEngineRoutes from './routes/seoEngineRoutes';

// Support BigInt serialization in JSON responses
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp() {
  const app = express();

  // Trust reverse proxy (Cloud Run, Nginx, load balancers)
  app.set('trust proxy', 1);

  // Security Headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Disabled for local Vite dev preview compatibility
      crossOriginEmbedderPolicy: false,
    })
  );

  // Configurable CORS: Allowed origins via CORS_ALLOWED_ORIGINS, defaulting to * in dev
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : '*';
  app.use(
    cors(
      allowedOrigins === '*'
        ? undefined
        : {
            origin: allowedOrigins,
            credentials: true,
          }
    )
  );

  // Body Parsing with Bounds
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Global API Rate Limiter
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 180, // Limit each IP to 180 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
      trustProxy: false,
      xForwardedForHeader: false,
      forwardedHeader: false,
    },
    message: {
      status: 'ERROR',
      error: 'Too many requests from this IP. Please wait before retrying.',
    },
  });
  app.use('/api', apiLimiter);

  // Mount Modular Routes
  app.use('/api/crawl', crawlRoutes);
  app.use('/api/copilot', copilotRoutes);
  app.use('/api/content', contentRoutes);
  app.use('/api/websites', websiteRoutes);
  app.use('/api/integrations', integrationRoutes);
  app.use('/api', integrationRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/observability', observabilityRoutes);
  app.use('/api/keywords', keywordRoutes);
  app.use('/api/serp', serpRoutes);
  app.use('/api/competitors', competitorRoutes);
  app.use('/api/decision', decisionRoutes);
  app.use('/api/actions', actionRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/agents', agentRoutes);
  app.use('/api/seo', seoEngineRoutes);

  // Legacy route aliases for backward compatibility
  app.post('/api/crawl', (req, res, next) => {
    // Forward /api/crawl POST to /api/crawl/url
    req.url = '/url';
    crawlRoutes(req, res, next);
  });
  app.post('/api/generate-content-brief', (req, res, next) => {
    req.url = '/brief';
    contentRoutes(req, res, next);
  });
  app.post('/api/generate-refresh-plan', (req, res, next) => {
    req.url = '/refresh';
    contentRoutes(req, res, next);
  });
  app.post('/api/optimize-ctr', (req, res, next) => {
    req.url = '/ctr-optimize';
    contentRoutes(req, res, next);
  });
  app.post('/api/generate-schema', (req, res, next) => {
    req.url = '/schema-generate';
    contentRoutes(req, res, next);
  });
  app.post('/api/export-wordpress', (req, res, next) => {
    req.url = '/export-wordpress';
    integrationRoutes(req, res, next);
  });
  app.post('/api/export-csv', (req, res, next) => {
    req.url = '/export-csv';
    integrationRoutes(req, res, next);
  });

  // Health endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Global Safe Error Handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled server error:', err);
    res.status(err.status || 500).json({
      status: 'ERROR',
      message: err.message || 'An internal server error occurred.',
    });
  });

  return app;
}
