import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  publisher: {
    enabled: true,
    config: {
      actions: {
        syncFrequency: '*/1 * * * *',
      },
    },
  },
  // Media stays on local disk unless UPLOAD_PROVIDER=s3, so local development needs no AWS setup.
  upload:
    env('UPLOAD_PROVIDER') === 's3'
      ? {
          config: {
            provider: 'aws-s3',
            providerOptions: {
              baseUrl: env('CDN_URL'),
              rootPath: env('S3_ROOT_PATH'),
              s3Options: {
                credentials: {
                  accessKeyId: env('AWS_ACCESS_KEY_ID'),
                  secretAccessKey: env('AWS_ACCESS_SECRET'),
                },
                region: env('AWS_REGION'),
                // Only for S3-compatible stores such as MinIO; leave unset for AWS.
                ...(env('AWS_ENDPOINT') ? { endpoint: env('AWS_ENDPOINT'), forcePathStyle: true } : {}),
                params: {
                  Bucket: env('AWS_BUCKET'),
                  // Buckets with ACLs disabled ("Bucket owner enforced") reject any ACL; they grant public
                  // read through a bucket policy instead. The key must stay present even when AWS_ACL is
                  // unset: the provider adds ACL 'public-read' whenever the key is missing.
                  ACL: env('AWS_ACL'),
                },
              },
            },
            actionOptions: {
              upload: {},
              uploadStream: {},
              delete: {},
            },
          },
        }
      : {},
});

export default config;
