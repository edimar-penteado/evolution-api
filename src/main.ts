// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Now import other modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import { redisClient } from '@cache/rediscache.client';
import {
  Auth,
  configService,
  Cors,
  HttpServer,
  ProviderSession,
  Sentry as SentryConfig,
  Webhook,
} from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { Server as HttpServerNode } from 'http';
import { Server as HttpsServerNode } from 'https';
import { join } from 'path';

type NetworkServer = HttpServerNode | HttpsServerNode;

async function initWA() {
  await waMonitor.loadInstance();
}

function closeHttpServer(server: NetworkServer) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();
  let shuttingDown = false;

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  app.get('/health/live', (_req, res) => res.status(HttpStatus.OK).json({ status: 'alive' }));
  app.get('/health/ready', async (_req, res) => {
    if (shuttingDown) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'unavailable' });
    }

    try {
      await prismaRepository.$queryRaw`SELECT 1`;
      return res.status(HttpStatus.OK).json({ status: 'ready' });
    } catch {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'unavailable' });
    }
  });

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));

  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK != '' && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000; //offset in milliseconds
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const now = localISOTime;
          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: {
                message: err['message'] || 'Internal Server Error',
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          const baseURL = webhook.EVENTS.ERRORS_WEBHOOK;
          const httpService = axios.create({ baseURL });

          httpService.post('', errorData);
        }

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server: NetworkServer = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  eventManager.init(server);

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');

    // Add this after all routes,
    // but before any and other error-handling middlewares are defined
    Sentry.setupExpressErrorHandler(app);
  }

  server.listen(httpServer.PORT, httpServer.HOST, () =>
    logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.HOST + ':' + httpServer.PORT),
  );

  const shutdownTimeoutMs = Math.max(5000, Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000'));
  const forceCloseAfterMs = Math.max(1000, shutdownTimeoutMs - 5000);

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn(`Shutdown already in progress after ${signal}`);
      return;
    }

    shuttingDown = true;
    logger.warn(`Graceful shutdown started after ${signal}`);

    const forceCloseTimer = setTimeout(() => {
      logger.warn('Forcing remaining HTTP connections to close');
      server.closeAllConnections?.();
    }, forceCloseAfterMs);
    forceCloseTimer.unref();

    const hardStopTimer = setTimeout(() => {
      logger.error(`Graceful shutdown exceeded ${shutdownTimeoutMs}ms`);
      process.exit(1);
    }, shutdownTimeoutMs);
    hardStopTimer.unref();

    try {
      await closeHttpServer(server);
      await waMonitor.shutdown();
      await eventManager.cleanup();
      await providerFiles?.onModuleDestroy();
      await redisClient.close();
      await prismaRepository.onModuleDestroy();
      await Sentry.close(2000);
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error({ local: 'shutdown', error });
      process.exit(1);
    } finally {
      clearTimeout(forceCloseTimer);
      clearTimeout(hardStopTimer);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  onUnexpectedError();
}

bootstrap();
