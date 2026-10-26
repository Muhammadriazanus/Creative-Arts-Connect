'use strict';

/**
 * Rewrites a `strapi export` archive taken from the old schema (firstblog, addictioncate, ...) so it
 * can be imported into an instance running the cleaned-up schema (blog-post, blog-category, ...).
 *
 * Renaming content types in Strapi itself would create new, empty tables. Doing the rename on the
 * export instead lets `strapi import` rebuild every join, component and morph table on its own.
 *
 * Usage:
 *   # 1. On the source (old code):   strapi export --no-encrypt --no-compress -f source
 *   # 2. On the target (new code):   strapi export --no-encrypt --no-compress --only config -f target-schemas
 *   # 3. Here:
 *   npm run migrate:transform-export -- --in source.tar --schemas target-schemas.tar --out migrated.tar
 *   #    [--prune-unused-media]  drop files no kept entry links to or embeds
 *   #    [--skip-assets]         leave the file binaries out; file entries keep their current URLs
 *   #                            (use when the media already lives in a bucket, e.g. staging MinIO)
 *   #    [--force]               drop records that do not fit the target schema instead of failing
 *   # 4. On the target:              strapi import -f migrated.tar --force
 *
 * Nothing is written unless every entity, link and configuration entry fits the target schemas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// `tar` is a direct dependency of @strapi/data-transfer, so resolve it from there.
const tar = require(require.resolve('tar', { paths: [path.dirname(require.resolve('@strapi/data-transfer'))] }));

// ─── Mapping ─────────────────────────────────────────────────────────────────

const DROPPED_TYPES = new Set([
  'api::about.about',
  'api::article.article',
  'api::author.author',
  'api::global.global',
  'api::authorcategory.authorcategory',
  'api::categoresblog.categoresblog',
  'api::cac-blog.cac-blog',
  'api::recent-post.recent-post',
  'api::imagepsot.imagepsot',
  'shared.media',
  'shared.quote',
  'shared.rich-text',
  'shared.slider',
  'shared.blog1',
]);

const RENAMED_TYPES = {
  'api::firstblog.firstblog': 'api::blog-post.blog-post',
  'api::addictioncate.addictioncate': 'api::blog-category.blog-category',
  'api::author-blog.author-blog': 'api::blog-author.blog-author',
  'api::social-link.social-link': 'api::author-social-link.author-social-link',
};

// Keyed by the NEW type uid: old attribute name -> new attribute name.
const RENAMED_FIELDS = {
  'api::blog-post.blog-post': {
    author_blogs: 'blogAuthors',
    addictioncates: 'blogCategories',
    key_takeaway: 'keyTakeaway',
    social_links: 'authorSocialLinks',
  },
  'api::blog-category.blog-category': { categories: 'name', firstblogs: 'blogPosts' },
  'api::blog-author.blog-author': { firstblog: 'blogPost' },
  'api::author-social-link.author-social-link': { firstblog: 'blogPost' },
  'api::comment.comment': {
    author_blogs: 'blogAuthors',
    firstblog: 'blogPost',
    FirstName: 'firstName',
    Email: 'email',
    WebSiteUrl: 'websiteUrl',
  },
  'api::category.category': { firstblogs: 'blogPosts' },
  'api::tag.tag': { firstblogs: 'blogPosts' },
  'api::key-takeaway.key-takeaway': { firstblog: 'blogPost' },
};

// Types that gained a `slug` uid, and the attribute it is generated from.
const SLUG_SOURCES = {
  'api::blog-post.blog-post': 'title',
  'api::blog-category.blog-category': 'name',
  'api::category.category': 'name',
  'api::tag.tag': 'title',
};

// Old flat SEO fields folded into the `seo` component.
const SEO_FIELDS = {
  'api::modality-page.modality-page': { title: 'seoTitle', description: 'seoDescription', keywords: [] },
  'api::specialty-page.specialty-page': {
    title: 'seoTitle',
    description: 'seoDescription',
    keywords: ['primaryKeyword', 'secondaryKeywords'],
  },
};

// Same algorithm as the blog-post controller and the frontend, so migrated slugs match live URLs.
const slugify = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const FORCE = args.includes('--force');
const PRUNE_MEDIA = args.includes('--prune-unused-media');
const SKIP_ASSETS = args.includes('--skip-assets');

const mapType = (uid) => RENAMED_TYPES[uid] || uid;
const mapField = (uid, field) => (RENAMED_FIELDS[uid] && RENAMED_FIELDS[uid][field]) || field;

// Rewrites "api::firstblog.firstblog.find" style strings (permissions, publisher actions).
const mapUidPrefix = (value) => {
  if (typeof value !== 'string') return { value };
  for (const uid of DROPPED_TYPES) if (value === uid || value.startsWith(`${uid}.`)) return { dropped: true };
  for (const [from, to] of Object.entries(RENAMED_TYPES)) {
    if (value === from || value.startsWith(`${from}.`)) return { value: to + value.slice(from.length) };
  }
  return { value };
};

const readJsonl = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .flatMap((f) =>
          fs
            .readFileSync(path.join(dir, f), 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        )
    : [];

const writeJsonl = (dir, name, rows) => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}_00001.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
};

const countBy = (rows, key) => rows.reduce((acc, r) => ((acc[key(r)] = (acc[key(r)] || 0) + 1), acc), {});

// ─── Transform steps ─────────────────────────────────────────────────────────

function transformEntities(entities, problems) {
  const kept = [];
  const usedSlugs = {};
  const slugByDocument = {};

  for (const entity of entities) {
    if (DROPPED_TYPES.has(entity.type)) continue;

    const type = mapType(entity.type);
    const data = {};
    for (const [key, value] of Object.entries(entity.data)) data[mapField(type, key)] = value;

    if (type === 'plugin::users-permissions.permission' || type === 'admin::permission') {
      const mapped = mapUidPrefix(data.action);
      if (mapped.dropped) continue;
      data.action = mapped.value;
      if ('subject' in data) {
        const subject = mapUidPrefix(data.subject);
        if (subject.dropped) continue;
        data.subject = subject.value;
      }
    }

    if (type === 'plugin::publisher.action') {
      const mapped = mapUidPrefix(data.entitySlug);
      if (mapped.dropped) continue;
      data.entitySlug = mapped.value;
    }

    if (SLUG_SOURCES[type] && !data.slug) {
      // Draft and published rows of one document share a slug; different documents must not.
      const docKey = `${type}:${data.documentId}`;
      if (!slugByDocument[docKey]) {
        const base = slugify(data[SLUG_SOURCES[type]] || '') || data.documentId;
        const taken = (usedSlugs[type] = usedSlugs[type] || new Set());
        let slug = base;
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
        if (slug !== base) problems.notes.push(`${type} "${base}" is used by several entries; ${data.documentId} got "${slug}"`);
        taken.add(slug);
        slugByDocument[docKey] = slug;
      }
      data.slug = slugByDocument[docKey];
    }

    if (SEO_FIELDS[type]) {
      const { title, description, keywords } = SEO_FIELDS[type];
      const keywordText = keywords.map((k) => data[k]).filter((v) => typeof v === 'string' && v.trim()).join(', ');
      if (data[title] || data[description] || keywordText) {
        data.seo = {
          metaTitle: data[title] || null,
          metaDescription: data[description] || null,
          keywords: keywordText || null,
          preventIndexing: false,
        };
      }
      for (const k of [title, description, ...keywords]) delete data[k];
    }

    kept.push({ ...entity, type, data });
  }
  return kept;
}

// Components are stored inline in their owning entry, so the instances that will exist after import
// are exactly those reachable from the kept entries. Returns "uid:id" keys.
function componentsOwnedBy(entities, schemas) {
  const owned = new Set();
  const walk = (uid, data) => {
    const schema = schemas[uid];
    if (!schema || !data) return;
    for (const [name, attr] of Object.entries(schema.attributes)) {
      const value = data[name];
      if (value == null) continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        const component = attr.type === 'component' ? attr.component : attr.type === 'dynamiczone' ? item.__component : null;
        if (!component) continue;
        owned.add(`${component}:${item.id}`);
        walk(component, item);
      }
    }
  };
  for (const entity of entities) walk(entity.type, entity.data);
  return owned;
}

// A link whose end is not being imported has nothing to attach to: an entry that was dropped (e.g. a
// permission on a removed type) or a component no kept entry contains (one inside a dropped entry, or
// one already orphaned in the source). Import would otherwise write it with the unmapped source id.
function dropDanglingLinks(links, entities, schemas, problems) {
  // Most links reference the entity id; the virtual `localizations` links reference the documentId.
  const imported = new Set(entities.flatMap((e) => [`${e.type}:${e.id}`, `${e.type}:${e.data.documentId}`]));
  const owned = componentsOwnedBy(entities, schemas);
  const dangling = (side) =>
    side.type.includes('::') ? !imported.has(`${side.type}:${side.ref}`) : !owned.has(`${side.type}:${side.ref}`);
  const kept = links.filter((link) => !dangling(link.left) && !dangling(link.right));
  if (kept.length !== links.length) {
    problems.notes.push(`${links.length - kept.length} link(s) to entries or components that are not imported were dropped`);
  }
  return kept;
}

function transformLinks(links) {
  return links
    .filter((link) => !DROPPED_TYPES.has(link.left.type) && !DROPPED_TYPES.has(link.right.type))
    .map((link) => {
      const left = { ...link.left, type: mapType(link.left.type) };
      const right = { ...link.right, type: mapType(link.right.type) };
      left.field = mapField(left.type, left.field);
      if (right.field) right.field = mapField(right.type, right.field);
      return { ...link, left, right };
    });
}

const CM_TYPE_PREFIX = 'plugin_content_manager_configuration_content_types::';
const CM_COMPONENT_PREFIX = 'plugin_content_manager_configuration_components::';

// Re-keys the content-manager layout of a renamed type so editors keep their list/edit layouts.
// Strapi reconciles these against the schema on boot, adding the new slug/seo fields itself.
function remapLayout(uid, layout, schemas) {
  const attributes = (schemas[uid] && schemas[uid].attributes) || {};
  const field = (name) => mapField(uid, name);
  const mainField = (name, meta) => {
    const target = attributes[name] && attributes[name].target;
    return target && meta && meta.mainField ? { ...meta, mainField: mapField(target, meta.mainField) } : meta;
  };

  const metadatas = {};
  for (const [name, meta] of Object.entries(layout.metadatas || {})) {
    const next = field(name);
    metadatas[next] = { ...meta, edit: mainField(next, meta.edit), list: mainField(next, meta.list) };
  }

  const settings = { ...layout.settings };
  if (settings.mainField) settings.mainField = field(settings.mainField);
  if (settings.defaultSortBy) settings.defaultSortBy = field(settings.defaultSortBy);

  return {
    ...layout,
    uid,
    settings,
    metadatas,
    layouts: {
      ...layout.layouts,
      list: (layout.layouts && layout.layouts.list ? layout.layouts.list : []).map(field),
      edit: (layout.layouts && layout.layouts.edit ? layout.layouts.edit : []).map((row) =>
        row.map((cell) => ({ ...cell, name: field(cell.name) }))
      ),
    },
  };
}

function transformConfiguration(configs, schemas) {
  const kept = [];
  for (const config of configs) {
    if (config.type !== 'core-store') {
      kept.push(config);
      continue;
    }
    const key = config.value.key;

    // A snapshot of the OLD schemas; Strapi writes a fresh one on the next boot.
    if (key === 'strapi_content_types_schema') continue;

    if (key.startsWith(CM_COMPONENT_PREFIX) && DROPPED_TYPES.has(key.slice(CM_COMPONENT_PREFIX.length))) continue;

    if (key.startsWith(CM_TYPE_PREFIX)) {
      const oldUid = key.slice(CM_TYPE_PREFIX.length);
      if (DROPPED_TYPES.has(oldUid)) continue;
      const uid = mapType(oldUid);
      if (!schemas[uid]) continue;
      const layout = typeof config.value.value === 'string' ? JSON.parse(config.value.value) : config.value.value;
      kept.push({
        ...config,
        value: { ...config.value, key: CM_TYPE_PREFIX + uid, value: remapLayout(uid, layout, schemas) },
      });
      continue;
    }

    kept.push(config);
  }
  return kept;
}

// Every record must fit the target schema, otherwise the import would silently drop data.
function validate(entities, links, schemas, problems) {
  const ok = (uid, field) => {
    const schema = schemas[uid];
    return schema && (field === undefined || field === 'documentId' || field === 'id' || field in schema.attributes);
  };

  const validEntities = entities.filter((e) => {
    if (!schemas[e.type]) {
      problems.errors.push(`entity ${e.type} #${e.id}: type does not exist in the target`);
      return false;
    }
    const unknown = Object.keys(e.data).filter((k) => !ok(e.type, k));
    if (unknown.length) problems.errors.push(`entity ${e.type} #${e.id}: unknown attributes ${unknown.join(', ')}`);
    return true;
  });

  const validLinks = links.filter((l) => {
    const sides = [l.left, l.right].filter((s) => s.field !== undefined);
    const bad = [l.left, l.right].filter((s) => !schemas[s.type]).concat(sides.filter((s) => !ok(s.type, s.field)));
    if (bad.length) {
      problems.errors.push(`link ${l.left.type}.${l.left.field} -> ${l.right.type}${l.right.field ? `.${l.right.field}` : ''}: not in the target schema`);
      return false;
    }
    return true;
  });

  return { entities: validEntities, links: validLinks };
}

// Files that no kept entry links to and no rich text/blocks field embeds by URL.
function pruneUnusedMedia(entities, links, assetsDir) {
  const FILE = 'plugin::upload.file';
  const files = entities.filter((e) => e.type === FILE);
  const used = new Set(links.filter((l) => l.left.type === FILE && l.left.field === 'related').map((l) => l.left.ref));
  const content = entities.filter((e) => e.type !== FILE).map((e) => JSON.stringify(e.data)).join('\n');
  for (const file of files) if (file.data.hash && content.includes(file.data.hash)) used.add(file.id);

  const unused = new Set(files.filter((f) => !used.has(f.id)).map((f) => f.id));
  const isUnusedFile = (side) => side.type === FILE && unused.has(side.ref);

  const metadataDir = path.join(assetsDir, 'metadata');
  let assetsRemoved = 0;
  if (fs.existsSync(metadataDir)) {
    for (const name of fs.readdirSync(metadataDir)) {
      const meta = JSON.parse(fs.readFileSync(path.join(metadataDir, name), 'utf8'));
      if (!unused.has(meta.id)) continue;
      fs.rmSync(path.join(metadataDir, name));
      fs.rmSync(path.join(assetsDir, 'uploads', name.replace(/\.json$/, '')), { force: true });
      assetsRemoved += 1;
    }
  }

  return {
    entities: entities.filter((e) => !(e.type === FILE && unused.has(e.id))),
    links: links.filter((l) => !isUnusedFile(l.left) && !isUnusedFile(l.right)),
    filesRemoved: unused.size,
    assetsRemoved,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const input = arg('in');
  const schemasArchive = arg('schemas');
  const output = arg('out');
  if (!input || !schemasArchive || !output) {
    console.error('Usage: transform-export.js --in <source.tar> --schemas <target-schemas.tar> --out <migrated.tar> [--prune-unused-media] [--force]');
    process.exit(2);
  }
  for (const file of [input, schemasArchive]) {
    if (/\.enc$/.test(file)) throw new Error(`${file} is encrypted; re-export with --no-encrypt`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-transform-'));
  const sourceDir = path.join(work, 'source');
  const targetDir = path.join(work, 'target');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(targetDir);

  try {
    await tar.x({ file: input, cwd: sourceDir });
    await tar.x({ file: schemasArchive, cwd: targetDir });

    const schemaRows = readJsonl(path.join(targetDir, 'schemas'));
    if (!schemaRows.length) throw new Error(`${schemasArchive} contains no schemas`);
    const schemas = Object.fromEntries(schemaRows.map((s) => [s.uid, s]));
    for (const uid of [...Object.values(RENAMED_TYPES), ...Object.keys(SLUG_SOURCES)]) {
      if (!schemas[uid]) throw new Error(`${schemasArchive} has no ${uid}; export it from an instance running the new code`);
    }

    const problems = { errors: [], notes: [] };
    const sourceEntities = readJsonl(path.join(sourceDir, 'entities'));
    const sourceLinks = readJsonl(path.join(sourceDir, 'links'));

    let entities = transformEntities(sourceEntities, problems);
    let links = dropDanglingLinks(transformLinks(sourceLinks), entities, schemas, problems);
    ({ entities, links } = validate(entities, links, schemas, problems));
    const configuration = transformConfiguration(readJsonl(path.join(sourceDir, 'configuration')), schemas);

    // Pruning removes files together with their own links, so it cannot leave links dangling.
    let pruned = { filesRemoved: 0, assetsRemoved: 0 };
    if (PRUNE_MEDIA) {
      pruned = pruneUnusedMedia(entities, links, path.join(sourceDir, 'assets'));
      ({ entities, links } = pruned);
    }

    const before = countBy(sourceEntities, (e) => e.type);
    const after = countBy(entities, (e) => e.type);
    const report = {
      input,
      output,
      entities: Object.fromEntries(
        [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .sort()
          .map((uid) => [uid, { before: before[uid] || 0, after: after[mapType(uid)] || 0, ...(DROPPED_TYPES.has(uid) ? { dropped: true } : {}), ...(RENAMED_TYPES[uid] ? { renamedTo: RENAMED_TYPES[uid] } : {}) }])
          .filter(([uid]) => !Object.values(RENAMED_TYPES).includes(uid))
      ),
      links: { before: sourceLinks.length, after: links.length },
      media: PRUNE_MEDIA ? { filesRemoved: pruned.filesRemoved, assetsRemoved: pruned.assetsRemoved } : 'not pruned',
      notes: problems.notes,
      errors: problems.errors,
    };

    console.table(Object.fromEntries(Object.entries(report.entities).map(([uid, r]) => [uid, { before: r.before, after: r.after, change: r.dropped ? 'dropped' : r.renamedTo || '' }])));
    console.log(`links: ${report.links.before} -> ${report.links.after}`);
    if (PRUNE_MEDIA) console.log(`unused media removed: ${pruned.filesRemoved} files, ${pruned.assetsRemoved} asset files`);
    problems.notes.forEach((n) => console.log(`note: ${n}`));
    problems.errors.forEach((e) => console.error(`error: ${e}`));
    fs.writeFileSync(`${output}.report.json`, JSON.stringify(report, null, 2));

    if (problems.errors.length && !FORCE) {
      console.error(`\n${problems.errors.length} record(s) do not fit the target schema. Fix the mapping, or pass --force to drop them.`);
      process.exitCode = 1;
      return;
    }

    // Schemas must match the target exactly or `strapi import` refuses the archive.
    fs.rmSync(path.join(sourceDir, 'schemas'), { recursive: true, force: true });
    fs.cpSync(path.join(targetDir, 'schemas'), path.join(sourceDir, 'schemas'), { recursive: true });
    writeJsonl(path.join(sourceDir, 'entities'), 'entities', entities);
    writeJsonl(path.join(sourceDir, 'links'), 'links', links);
    writeJsonl(path.join(sourceDir, 'configuration'), 'configuration', configuration);

    if (SKIP_ASSETS) fs.rmSync(path.join(sourceDir, 'assets'), { recursive: true, force: true });

    const entries = fs.readdirSync(sourceDir);
    await tar.c({ file: output, cwd: sourceDir, portable: true }, entries);
    console.log(`\nwrote ${output} (report: ${output}.report.json)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
