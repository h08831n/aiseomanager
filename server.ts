import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './server/app';
import { validateStartupEnvironment } from './server/config/environmentValidator';
import { isProductionMode } from './server/config/runtimeMode';

async function startServer() {
  // 1. Strict Environment Validation on Startup
  validateStartupEnvironment({
    enforceStrict: isProductionMode(),
    exitOnError: isProductionMode(),
  });

  const app = createApp();
  const PORT = 3000;


  // Mount Vite Middleware for development and static fallback for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use((await import('express')).default.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI SEO Manager Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
