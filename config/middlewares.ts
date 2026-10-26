import type { Core } from '@strapi/strapi';

// The admin panel loads media previews straight from S3/CDN, so those hosts must be allowed by the CSP.
const mediaHosts = (env: Core.Config.Shared.ConfigParams['env']) =>
  [
    env('AWS_BUCKET') && `${env('AWS_BUCKET')}.s3.${env('AWS_REGION', 'us-east-1')}.amazonaws.com`,
    env('CDN_URL') && new URL(env('CDN_URL')).host,
  ].filter(Boolean) as string[];

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Middlewares => [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...mediaHosts(env)],
          'media-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...mediaHosts(env)],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;
