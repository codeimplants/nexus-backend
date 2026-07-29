import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as dotenv from 'dotenv';

dotenv.config();

const ALLOWED_ORIGINS = [
  // React (CRA default)
  'http://localhost:3000',
  // Vite default
  'http://localhost:5173',
  // Angular default
  'http://localhost:4200',
  // Your custom dev ports seen in errors
  'http://localhost:8100',
  'http://localhost:8081',
  // Add any other specific dev ports here
  'http://localhost:8080',
  'http://localhost:4173', // vite preview

  // Production / subdomains
  'https://sonebill.codeimplants.com',
  'https://sonebill.lovable.app',
  'https://sonetaran.codeimplants.com',
  'https://sonetaran.lovable.app',
  'https://sonebhav.codeimplants.com',
  'https://jewelerp.codeimplants.com',
  'https://sssdsahyadri.codeimplants.com',
  'https://panchalsonar.in/',

  // Nexus admin panel on Firebase Hosting (project version-control-vc).
  // Listed as exact origins on purpose: putting 'firebaseapp.com' in the suffix
  // list below would let ANY Firebase-hosted site call this API.
  'https://version-control-vc.firebaseapp.com',
  'https://version-control-vc.web.app',

  // SoneBill's react-native-web build (project sonebill-534ab), the "real"
  // SoneBill web surface — sonebill.codeimplants.com above is the separate
  // (unused) admin-dashboard SPA, not this. Calls /sdk/* directly from the
  // browser via platformAnalytics.ts.
  'https://sonebill-534ab.firebaseapp.com',
  'https://sonebill-534ab.web.app',
];

// Any subdomain (and the apex) of these domains is allowed.
const ALLOWED_ORIGIN_SUFFIXES = ['codeimplants.com', 'lovable.app'];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return ALLOWED_ORIGIN_SUFFIXES.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      console.warn(`CORS blocked for origin: ${origin}`);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // x-api-key: how /sdk/* endpoints authenticate web/RN-web clients
    // (platformAnalytics.ts) — missing here silently CORS-blocks every such
    // call from a browser (native apps are unaffected; CORS is browser-only).
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  const requestedPort = Number(process.env.PORT) || 6000;

  // Port hunting is a local-development convenience only. On the VPS each
  // environment has a fixed port (prod 6000, dev 6001, preprod 6002), so an
  // instance that "helpfully" moved to the next free port would bind ANOTHER
  // environment's port — serving prod traffic from dev code, or silently sitting
  // somewhere nginx and the health check never look. Deployed envs fail fast.
  const isDeployed = ['dev', 'preprod', 'prod'].includes(process.env.NODE_ENV ?? '');

  if (isDeployed) {
    await app.listen(requestedPort);
    console.log(
      `Application is running on port ${requestedPort} (NODE_ENV=${process.env.NODE_ENV})`,
    );
    return;
  }

  const port = await listenOnAvailablePort(app, requestedPort);
  console.log(`Application is running on port ${port}`);
}

async function listenOnAvailablePort(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  startPort: number,
  maxAttempts = 10,
): Promise<number> {
  let port = startPort;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await app.listen(port);
      return port;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} is already in use, trying ${port + 1}...`);
        port++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Could not find an available port after ${maxAttempts} attempts starting from ${startPort}`,
  );
}

bootstrap().catch((err) => {
  console.error('Failed to start application', err);
  process.exit(1);
});