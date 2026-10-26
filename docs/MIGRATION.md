# Staging (SQLite) → Production (Postgres + S3) migration

Moves the staging CMS content to production while renaming and removing content types.
Production **admin users, admin roles and API tokens are kept**; production **content and media are replaced**.

## What changes

| Old | New | API |
|---|---|---|
| `firstblog` | `blog-post` | `/api/blog-posts`, `/api/blog-posts/:slug/related` |
| `addictioncate` (field `categories`) | `blog-category` (field `name`) | `/api/blog-categories` |
| `author-blog` | `blog-author` | `/api/blog-authors` |
| `social-link` | `author-social-link` | `/api/author-social-links` |
| relation fields | `blogPost`, `blogPosts`, `blogAuthors`, `blogCategories`, `keyTakeaway`, `authorSocialLinks` | |
| `comment.FirstName/Email/WebSiteUrl` | `firstName/email/websiteUrl` | |
| `about`, `article`, `author`, `global`, `authorcategory`, `categoresblog`, `cac-blog`, `recent-post`, `imagepsot` | removed | 404 |

Every page type (`blog-post`, `blog-category`, `category`, `tag`, `event`, `lead-magnet`, `modality-page`,
`specialty-page`, `events-page`, `webinars-page`) has a `seo` component (`shared.seo`). Blog posts, blog
categories, categories and tags also gained a `slug`, generated from the title/name during the migration.
`modality-page`/`specialty-page` `seoTitle`, `seoDescription`, `primaryKeyword`, `secondaryKeywords` are folded into `seo`.

The frontend must be released together with this change (branch `feat/cms-rename-seo` in `cats-frontend`).

## How it works

`strapi import` restores content by type uid, so renames are applied to the **export file**, not the database:

0. Staging (branch `feat/staging-minio`: old schema + S3 config) moves its local uploads to MinIO with
   `scripts/migrate-uploads-to-s3.js`. Local files are kept.
1. `strapi export` on staging (old code) → `source.tar`
2. `strapi export --only config` on the target (new code) → `target-schemas.tar` (only its schemas are used)
3. `scripts/transform-export.js` renames types/fields, drops removed types (and their permissions, links,
   media links and admin layouts), backfills slugs, builds `seo` components, and swaps in the target schemas.
   It refuses to write anything that does not fit the target schema. `--skip-assets` leaves the binaries out.
4. `strapi import` into production. It wipes every non-`admin::` table, so admin users survive.
5. `scripts/migrate-uploads-to-s3.js --from-url <minio base>` copies each imported file from MinIO to the
   production bucket and rewrites URLs, including URLs embedded in rich text. MinIO is not modified.

## Prerequisites

- Same Strapi version on staging and production (5.47.1).
- S3 bucket + IAM user (`s3:PutObject`, `GetObject`, `DeleteObject`, `PutObjectAcl` on `<bucket>/cms/*`);
  objects publicly readable or served through CloudFront. Use a separate `S3_ROOT_PATH` per environment.
- The bucket/CDN host added to `cats-frontend/next.config.mjs` `images.remotePatterns`.
- Production `.env`: `DATABASE_CLIENT=postgres`, `DATABASE_*`, `UPLOAD_PROVIDER=s3`, `AWS_*`, `S3_ROOT_PATH`, `CDN_URL` (optional).
- Rehearse the whole runbook on staging first (staging → a fresh Postgres + `S3_ROOT_PATH=cms/staging`).

## Runbook

```bash
# ── STAGING (branch feat/staging-minio; .env: UPLOAD_PROVIDER=s3, AWS_ENDPOINT=<minio>, AWS_BUCKET, S3_ROOT_PATH=cms/staging)
cp .tmp/data.db ~/backup/staging-data.db && tar czf ~/backup/staging-uploads.tgz public/uploads
rm -rf dist && npm ci && npm run build
npm run migrate:uploads-s3 -- --dry-run
npm run migrate:uploads-s3                      # no --delete-local: local images stay
# restart staging Strapi; images now come from MinIO. Content freeze, then:
npx strapi export --no-encrypt --no-compress -f source

# ── PRODUCTION (branch feat/cms-cleanup-rename-seo; .env: postgres + UPLOAD_PROVIDER=s3 + AWS_* + S3_ROOT_PATH=cms/production)
pg_dump -Fc "$PROD_DATABASE_URL" > prod-before-migration.dump
# DOWNTIME STARTS: stop the running production CMS (the new schema sync breaks the old code).
rm -rf dist && npm ci && npm run build
npx strapi export --no-encrypt --no-compress --only config -f target-schemas
npm run migrate:transform-export -- --in source.tar --schemas target-schemas.tar --out migrated.tar --prune-unused-media --skip-assets
npx strapi import -f migrated.tar --force
npm run migrate:uploads-s3 -- --from-url http://<minio-host>:9000/<minio-bucket>/cms/staging --dry-run
npm run migrate:uploads-s3 -- --from-url http://<minio-host>:9000/<minio-bucket>/cms/staging
# start the production CMS, verify, release the frontend.
```

Always `rm -rf dist` before building: a stale `dist/` brings the deleted APIs back.

## Verification

```sql
select id, email from admin_users;                                   -- production admins still there
select count(*), count(*) filter (where published_at is not null) from blog_posts;
select provider, count(*) from files group by 1;                     -- only aws-s3
select count(*) from files where url like '/uploads/%';              -- 0
select count(*) from blog_posts where description::text like '%/uploads/%';   -- 0
```

Compare every count with `migrated.tar.report.json`, then:

- `GET /api/blog-posts?populate=*`, `/api/blog-posts/<slug>/related`, `/api/blog-categories`, `/api/tags`,
  `/api/comments?filters[blogPost][id][$eq]=<id>&populate=blogAuthors`, `/api/specialty-pages`, `/api/modality-pages`,
  `/api/events`, `/api/events-page`, `/api/webinars-page`, `/api/testimonials`, `/api/lead-magnets/<documentId>`
- `POST /api/comments` with `{ data: { comment, firstName, email, blogPost } }`
- Admin: Media Library thumbnails load; publishing a modality page keeps its "other modalities".
- Settings → Users & Permissions → Public: `find`/`findOne` on every public type, `create` on comment.
  Grant `update` on comment if comment editing on the site should work (it was not granted on staging).
- Old routes (`/api/firstblogs`, `/api/addictioncates`, …) return 404.

## Rollback

`pg_restore --clean -d "$PROD_DATABASE_URL" prod-before-migration.dump`, redeploy the previous CMS image and the
previous frontend release. Objects uploaded to S3 are new keys, so leaving them does no harm.

## Notes

- Admin settings stored in the core store (users-permissions email templates/providers, upload settings) come
  from staging. Review them after the import.
- Admin role permissions on renamed types (Editor/Author roles) point at the old uids; re-grant them in
  Settings → Administration Panel → Roles. Super Admin is unaffected.
- The transform prints a note for every duplicate slug it had to suffix (e.g. duplicate category names) — worth cleaning up in the CMS.
- Scheduled publisher actions on removed types are dropped; others are kept.
