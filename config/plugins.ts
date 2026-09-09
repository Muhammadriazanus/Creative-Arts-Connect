import type { Core } from '@strapi/strapi';

const config = (_: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  publisher: {
    enabled: true,
    config: {
      actions: {
        syncFrequency: '*/1 * * * *', 
      },
    },
  },
});

export default config;
