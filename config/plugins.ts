import type { Core } from '@strapi/strapi';

const config = (_: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  publisher: {
    enabled: true,
    config: {
      actions: {
        // How often the plugin checks for content scheduled to be published/unpublished (cron expression)
        syncFrequency: '*/1 * * * *',
      },
    },
  },
});

export default config;
