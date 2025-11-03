import helmet from 'helmet';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const DEFAULT_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  imgSrc: ["'self'", 'data:', 'https:'],
  styleSrc: ["'self'", "'unsafe-inline'"],
  scriptSrc: ["'self'", 'https://js.stripe.com'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", 'https:', 'data:'],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  upgradeInsecureRequests: [],
};

export function securityHeaders({ cspDirectives = {}, enableHsts = process.env.NODE_ENV === 'production' } = {}) {
  const directives = { ...DEFAULT_CSP_DIRECTIVES, ...cspDirectives };
  if (process.env.NEXT_PUBLIC_API_URL) {
    directives.connectSrc = Array.from(new Set([...directives.connectSrc, process.env.NEXT_PUBLIC_API_URL]));
  }

  const middleware = [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives,
      },
      hsts: enableHsts
        ? {
            maxAge: ONE_YEAR_SECONDS,
            includeSubDomains: true,
            preload: true,
          }
        : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: { policy: 'require-corp' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      xDnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
    }),
    (_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    },
  ];

  return middleware;
}
