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

  // SoneBill's react-native-web build (project sonebill-534ab). Calls /sdk/*
  // directly from the browser via platformAnalytics.ts.
  //
  // sonebill.codeimplants.com, listed above under the suffix allow-list, is a
  // custom domain on THIS SAME project and serves this same build — verified
  // byte-identical on 31 Aug 2026. An earlier note here called it a separate,
  // unused admin-dashboard SPA; that is wrong, and it matters because it is the
  // canonical URL to hand people (it survives a Firebase project change), which
  // is what Nexus opens for impersonation.
  'https://sonebill-534ab.firebaseapp.com',
  'https://sonebill-534ab.web.app',
];

// Any subdomain (and the apex) of these domains is allowed.
//
// This is the built-in floor, not the whole list: per-deployment domains are
// added through CORS_EXTRA_ORIGIN_SUFFIXES (see below), which is how
// barnefarms.com is allowed. Add here only what should be true for every
// deployment of Nexus.
const ALLOWED_ORIGIN_SUFFIXES = ['codeimplants.com', 'lovable.app'];

/**
 * Extra origins from the environment, so onboarding an app on a new domain is
 * an .env edit and a restart rather than a code change and three deploys of
 * the shared platform.
 *
 *   CORS_EXTRA_ORIGINS=https://foo.example,https://bar.example
 *   CORS_EXTRA_ORIGIN_SUFFIXES=barnefarms.com,newapp.in
 *
 * The hardcoded lists above stay as the floor and are never replaced. A
 * mistyped or empty variable can therefore only fail to ADD a domain; it can
 * never lock out an app that already works, which is the failure mode that
 * would matter at 2am.
 *
 * Exact origins and suffixes are kept as separate variables on purpose. A
 * suffix is far more powerful than it looks -- 'firebaseapp.com' as a suffix
 * would admit every Firebase-hosted site on the internet -- and merging them
 * into one variable makes it easy to paste a host into the wrong one.
 */
function parseListEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Suffixes that would hand access to every tenant of a shared host. */
const MULTI_TENANT_SUFFIXES = [
  'firebaseapp.com',
  'web.app',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'github.io',
];

function loadExtraSuffixes(): string[] {
  return parseListEnv('CORS_EXTRA_ORIGIN_SUFFIXES').filter((suffix) => {
    // A single-label suffix ('com') would match every hostname ending in it.
    if (!suffix.includes('.')) {
      console.error(
        `CORS_EXTRA_ORIGIN_SUFFIXES: ignoring '${suffix}' — a suffix with no dot matches far too much.`,
      );
      return false;
    }
    if (MULTI_TENANT_SUFFIXES.includes(suffix)) {
      console.warn(
        `CORS_EXTRA_ORIGIN_SUFFIXES: '${suffix}' is a shared hosting domain — this allows EVERY site hosted there. Use CORS_EXTRA_ORIGINS with the exact origin instead.`,
      );
    }
    return true;
  });
}

const EXTRA_ORIGINS = parseListEnv('CORS_EXTRA_ORIGINS');
const EXTRA_ORIGIN_SUFFIXES = loadExtraSuffixes();

const effectiveOrigins = [...ALLOWED_ORIGINS, ...EXTRA_ORIGINS];
const effectiveSuffixes = [...ALLOWED_ORIGIN_SUFFIXES, ...EXTRA_ORIGIN_SUFFIXES];

function isAllowedOrigin(origin: string): boolean {
  if (effectiveOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return effectiveSuffixes.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Logged at boot because the alternative way to discover a missing entry is
  // a silently dropped telemetry call from a browser somewhere.
  console.log(
    `CORS: ${effectiveOrigins.length} exact origins, ${effectiveSuffixes.length} suffixes ` +
      `(${EXTRA_ORIGINS.length} + ${EXTRA_ORIGIN_SUFFIXES.length} from env)` +
      (EXTRA_ORIGIN_SUFFIXES.length
        ? ` — env suffixes: ${EXTRA_ORIGIN_SUFFIXES.join(', ')}`
        : ''),
  );

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