'use strict';

/**
 * Moves media to the configured S3 bucket and updates the database to point at the new URLs.
 * The source is either local disk (public/uploads, the default) or another bucket's public
 * URLs (--from-url), e.g. staging's MinIO when promoting content to production.
 *
 * Usage:
 *   UPLOAD_PROVIDER=s3 must be set in .env (with the AWS_* variables of the DESTINATION).
 *
 *   npm run migrate:uploads-s3 -- --dry-run       # report what would happen
 *   npm run migrate:uploads-s3                    # upload + update DB, keep local files
 *   npm run migrate:uploads-s3 -- --delete-local  # also remove local files once migrated
 *   npm run migrate:uploads-s3 -- --from-url http://minio:9000/bucket/cms/staging
 *                                                 # copy files whose URL starts with that base
 *
 * Safe to re-run: only files still on the source (provider "local", or a URL under
 * --from-url) are processed. The source is never modified unless --delete-local is passed.
 */

const fs = require('fs-extra');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DELETE_LOCAL = args.includes('--delete-local');
const FROM_URL = args.includes('--from-url') ? args[args.indexOf('--from-url') + 1] : null;

if (FROM_URL !== null && !/^https?:\/\/\S+/.test(FROM_URL || '')) {
  console.error('--from-url needs the public base URL of the source bucket, e.g. http://host:9000/bucket/prefix');
  process.exit(2);
}
if (FROM_URL && DELETE_LOCAL) {
  console.error('--delete-local only applies to local files; it cannot be combined with --from-url');
  process.exit(2);
}

const FILE_UID = 'plugin::upload.file';
const PAGE_SIZE = 100;

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function localPathFor(url) {
  // Local provider URLs look like "/uploads/<hash><ext>".
  return path.join(strapi.dirs.static.public, url.replace(/^\/+/, ''));
}

async function readSource(url) {
  if (FROM_URL) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), filePath: null };
  }
  const filePath = localPathFor(url);
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`missing on disk: ${filePath}`);
  }
  return { buffer: await fs.readFile(filePath), filePath };
}

async function uploadToS3(entry) {
  const { buffer, filePath } = await readSource(entry.url);

  // The provider mutates the object it receives and sets `url` on it.
  const fileData = {
    name: entry.name,
    hash: entry.hash,
    ext: entry.ext,
    mime: entry.mime,
    size: entry.size,
    path: entry.path,
    buffer,
  };
  await strapi.plugin('upload').provider.upload(fileData);

  return { url: fileData.url, provider_metadata: fileData.provider_metadata, filePath };
}

async function migrateFile(file, providerName, urlMap) {
  const localPaths = [];
  const formats = file.formats ? { ...file.formats } : null;

  if (DRY_RUN) {
    console.log(`[dry-run] would migrate #${file.id} ${file.name} (${file.url})`);
    return;
  }

  // Upload the original and every generated format before touching the DB,
  // so a partial failure leaves the record pointing at working local files.
  const main = await uploadToS3(file);
  if (FROM_URL && main.url.startsWith(FROM_URL)) {
    throw new Error(`--from-url is the destination bucket itself (${main.url}); point it at the source bucket`);
  }
  localPaths.push(main.filePath);
  urlMap.set(file.url, main.url);

  for (const key of Object.keys(formats || {})) {
    const format = formats[key];
    const uploaded = await uploadToS3(format);
    localPaths.push(uploaded.filePath);
    urlMap.set(format.url, uploaded.url);
    formats[key] = { ...format, url: uploaded.url };
  }

  await strapi.db.query(FILE_UID).update({
    where: { id: file.id },
    data: {
      url: main.url,
      formats,
      provider: providerName,
      provider_metadata: main.provider_metadata ?? file.provider_metadata,
    },
  });

  console.log(`migrated #${file.id} ${file.name} -> ${main.url}`);

  if (DELETE_LOCAL) {
    await Promise.all(localPaths.filter(Boolean).map((p) => fs.remove(p)));
  }
}

async function migrateFiles(providerName) {
  const urlMap = new Map();
  const failures = [];
  let migrated = 0;
  let offset = 0;

  while (true) {
    const files = await strapi.db.query(FILE_UID).findMany({
      where: FROM_URL ? { url: { $startsWith: FROM_URL } } : { provider: 'local' },
      orderBy: { id: 'asc' },
      limit: PAGE_SIZE,
      // Migrated rows drop out of the source filter, so only skip past failures
      // (and everything, in dry-run mode, since nothing changes).
      offset,
    });
    if (files.length === 0) break;

    for (const file of files) {
      try {
        await migrateFile(file, providerName, urlMap);
        migrated += 1;
        if (DRY_RUN) offset += 1;
      } catch (error) {
        failures.push({ id: file.id, name: file.name, error: error.message });
        console.error(`failed #${file.id} ${file.name}: ${error.message}`);
        offset += 1;
      }
    }
  }

  return { urlMap, migrated, failures };
}

/**
 * Rewrites media URLs embedded in rich text (markdown) and blocks (JSON) fields.
 * Matches both relative ("/uploads/x.png") and absolute ("https://host/uploads/x.png") forms.
 */
async function rewriteContentUrls(urlMap) {
  if (urlMap.size === 0) return 0;

  const replacers = [...urlMap].map(([oldUrl, newUrl]) => [
    new RegExp(`(https?://[^\\s"'()<>]+?)?${escapeRegExp(oldUrl)}(?![\\w.-])`, 'g'),
    newUrl,
  ]);
  const rewrite = (text) =>
    replacers.reduce((acc, [pattern, newUrl]) => acc.replace(pattern, newUrl), text);

  const models = [...Object.values(strapi.contentTypes), ...Object.values(strapi.components)].filter(
    (model) => model.uid.startsWith('api::') || !model.uid.includes('::')
  );

  let updatedRows = 0;

  for (const model of models) {
    const fields = Object.entries(model.attributes)
      .filter(([, attr]) => attr.type === 'richtext' || attr.type === 'blocks')
      .map(([name, attr]) => ({ name, type: attr.type }));
    if (fields.length === 0) continue;

    const rows = await strapi.db.query(model.uid).findMany({
      select: ['id', ...fields.map((f) => f.name)],
    });

    for (const row of rows) {
      const data = {};
      for (const { name, type } of fields) {
        const value = row[name];
        if (value == null) continue;

        const original = type === 'blocks' ? JSON.stringify(value) : value;
        const updated = rewrite(original);
        if (updated !== original) {
          data[name] = type === 'blocks' ? JSON.parse(updated) : updated;
        }
      }

      if (Object.keys(data).length > 0) {
        await strapi.db.query(model.uid).update({ where: { id: row.id }, data });
        updatedRows += 1;
        console.log(`updated embedded URLs in ${model.uid} #${row.id}`);
      }
    }
  }

  return updatedRows;
}

async function run() {
  const uploadConfig = strapi.config.get('plugin::upload');
  const providerName = uploadConfig.provider;

  if (providerName !== 'aws-s3') {
    throw new Error(
      `Active upload provider is "${providerName}". Set UPLOAD_PROVIDER=s3 in .env before running this script.`
    );
  }

  console.log(
    `Migrating ${FROM_URL ? `files under ${FROM_URL}` : 'local uploads'} to S3${DRY_RUN ? ' (dry run)' : ''}${DELETE_LOCAL ? ', deleting local copies' : ''}...`
  );

  const { urlMap, migrated, failures } = await migrateFiles(providerName);
  const contentRows = DRY_RUN ? 0 : await rewriteContentUrls(urlMap);

  console.log('\nSummary');
  console.log(`  files ${DRY_RUN ? 'to migrate' : 'migrated'}: ${migrated}`);
  console.log(`  content entries updated: ${contentRows}`);
  console.log(`  failures: ${failures.length}`);
  failures.forEach((f) => console.log(`    #${f.id} ${f.name}: ${f.error}`));

  return failures.length === 0;
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  app.log.level = 'error';

  const ok = await run();
  await app.destroy();

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
