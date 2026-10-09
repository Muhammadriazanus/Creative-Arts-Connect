// Copies FIRSTBLOG posts from the old CMS into a CMS running the new blog
// design schema, reshaping each post on the way.
//
//   node scripts/migrate-firstblogs.mjs --dry-run      # writes migrate-firstblogs.out.json, posts nothing
//   TARGET_URL=https://staging.example.com STRAPI_TOKEN=... node scripts/migrate-firstblogs.mjs
//   ... node scripts/migrate-firstblogs.mjs --social-links   # only add SOCIAL_LINKS to target posts that have none
//
// Optional: SOURCE_URL (defaults to the old CMS), TAG (only posts whose `tag` contains it),
// ONLY_IDS (comma-separated old post ids, to retry failures).

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_URL = (process.env.SOURCE_URL || 'https://cms.creativeartsconnect.com').replace(/\/$/, '');
const TARGET_URL = (process.env.TARGET_URL || '').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_TOKEN;
const TAG = process.env.TAG;
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_IDS = process.env.ONLY_IDS ? new Set(process.env.ONLY_IDS.split(',').map(Number)) : null;

const WORDS_PER_MINUTE = 200;
const DEFAULT_AUTHOR = 'Creative Arts Connect';

// Old posts have no social links; use the ones in the live site's footer.
const SOCIAL_LINKS = {
  facebook: 'https://www.facebook.com/people/Creativeartsconnect/61573849441775/',
  instagram: 'https://www.instagram.com/creativeartsconnect/',
  linkedin: 'https://www.linkedin.com/company/creative-arts-connect/about/',
  ownWebsite: 'https://creativeartsconnect.com/',
};

// ---------- source ----------

async function fetchOldPosts() {
  const posts = [];
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({
      populate: '*',
      'pagination[pageSize]': '100',
      'pagination[page]': String(page),
      sort: 'date:desc',
    });
    if (TAG) qs.set('filters[tag][$containsi]', TAG);
    const res = await fetch(`${SOURCE_URL}/api/firstblogs?${qs}`);
    if (!res.ok) throw new Error(`GET old firstblogs page ${page}: ${res.status}`);
    const body = await res.json();
    posts.push(...body.data);
    if (page >= body.meta.pagination.pageCount) return posts;
  }
}

// ---------- transform ----------

const textOf = (node) =>
  node.text ?? (node.children || []).map(textOf).join('');

const isEmptyParagraph = (n) => n.type === 'paragraph' && !textOf(n).trim();

// Older posts mark headings in one of two ways: a paragraph that is entirely
// bold, or a short stand-alone line with no closing punctuation.
function headingLevel(node) {
  if (node.type !== 'paragraph') return 0;
  const kids = node.children || [];
  const text = textOf(node).trim();
  if (!text || text.length > 100 || /^[•\-–"“‘']/.test(text)) return 0;
  if (kids.some((k) => k.type === 'link')) return 0;

  const allBold = kids.filter((k) => (k.text || '').trim()).every((k) => k.bold);
  if (allBold) return /^\d+[.)]\s/.test(text) ? 3 : 2;

  const words = text.split(/\s+/).length;
  if (words < 2 || words > 14 || /[.,;:!…"”]$/.test(text)) return 0;
  return /^\d+[.)]\s/.test(text) ? 3 : 2;
}

// Posts pasted from social media fake bold with Unicode math letters (𝗜𝘁).
const MATH_ALNUM = /[\u{1D400}-\u{1D7FF}]/gu;
function plainText(node) {
  if (typeof node.text === 'string') node.text = node.text.replace(MATH_ALNUM, (c) => c.normalize('NFKC'));
  (node.children || []).forEach(plainText);
  return node;
}

const BULLET = /^\s*[•\-–]\s+/;

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
function isTitleCase(text) {
  const words = text.replace(/[^\p{L}\s'’-]/gu, ' ').split(/\s+/).filter(Boolean).slice(1);
  const big = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  return big.length > 0 && big.filter((w) => /^\p{Lu}/u.test(w)).length / big.length >= 0.6;
}

const squash =(s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function transformBlocks(blocks = [], { title, tag } = {}) {
  const out = [];
  const lastList = () => (out.at(-1)?.type === 'list' ? out.at(-1) : null);
  const pushItem = (children) => {
    const item = { type: 'list-item', children };
    const list = lastList();
    if (list && list.format === 'unordered') list.children.push(item);
    else out.push({ type: 'list', format: 'unordered', children: [item] });
  };

  let nodes = structuredClone(blocks).map(plainText).filter((n) => !isEmptyParagraph(n));
  // Some posts repeat the title as the first line, or end with the tags run together.
  if (nodes[0] && squash(textOf(nodes[0])) === squash(title)) nodes = nodes.slice(1);
  if (tag && nodes.at(-1) && squash(textOf(nodes.at(-1))) === squash(tag)) nodes = nodes.slice(0, -1);

  // Two or more sentence-case, heading-like lines in a row are a list written
  // without bullets. Title Case lines stay headings ("The Music Bit").
  const level = nodes.map(headingLevel);
  const listy = nodes.map(
    (n, i) => level[i] && !isTitleCase(textOf(n)) && !n.children.some((k) => k.bold)
  );
  const inRun = (i) => listy[i] && (listy[i - 1] || listy[i + 1]);

  for (const [i, node] of nodes.entries()) {
    // "• item" paragraphs become real list items.
    if (node.type === 'paragraph' && BULLET.test(textOf(node))) {
      const children = structuredClone(node.children);
      children[0].text = children[0].text.replace(BULLET, '');
      pushItem(children);
      continue;
    }

    if (inRun(i)) {
      pushItem(structuredClone(node.children));
      continue;
    }

    // Consecutive single-item lists merge into one list.
    if (node.type === 'list') {
      const list = lastList();
      if (list && list.format === node.format) list.children.push(...structuredClone(node.children));
      else out.push(structuredClone(node));
      continue;
    }

    if (level[i]) {
      out.push({
        type: 'heading',
        level: level[i],
        children: [{ type: 'text', text: textOf(node).trim() }],
      });
      continue;
    }

    out.push(structuredClone(node));
  }
  return out;
}

function readTime(blocks) {
  const words = blocks.map(textOf).join(' ').split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / WORDS_PER_MINUTE))} min read`;
}

// Fixes for comma slips and typos in the old free-text tag/category fields.
const LIST_FIXES = [
  ['Art MaterialsArt ,Therapy, How Therapy,WorksTips', 'Art Materials,Art Therapy,How Therapy Works,Tips'],
  ['DepressionMental,Health Support', 'Depression,Mental Health Support'],
  ['Creative Arts,Therapies', 'Creative Arts Therapies'],
  ['Childhhod', 'Childhood'],
  ['Improvment', 'Improvement'],
  ['Endmetriosis', 'Endometriosis'],
];

const splitList = (s) =>
  LIST_FIXES.reduce((acc, [from, to]) => acc.split(from).join(to), s || '')
    .split(',')
    .map((x) => x.replace(/\s+/g, ' ').trim().replace(/^Category:\s*/i, ''))
    .filter(Boolean);

const unique = (xs) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];

// Old categories hold several names in one comma-joined entry.
const categoryNames = (post) =>
  unique((post.categories || []).flatMap((c) => splitList(c.name))).filter(
    (n) => n.toLowerCase() !== 'uncategorized'
  );

const tagNames = (post) => unique(splitList(post.tag));

function transformPost(post) {
  const description = transformBlocks(post.description, { title: post.title, tag: post.tag });
  const categories = categoryNames(post);
  const author = (post.author_blogs || []).map((a) => (a.authorname || '').trim()).find(Boolean);

  return {
    source: { id: post.id, documentId: post.documentId },
    data: {
      title: post.title?.trim(),
      date: post.date,
      eyebrow: categories[0] || null,
      readTime: readTime(description),
      description,
      tag: tagNames(post).join(', ') || null,
      authorName: author || DEFAULT_AUTHOR,
      showKeyTakeaways: false,
      showGuide: false,
    },
    media: {
      image: (post.image || []).map((f) => f.url),
      contentImages: (post.contentImages || []).map((f) => f.url),
    },
    categories,
    tags: tagNames(post),
    comments: (post.comments || []).map(({ comment, FirstName, Email, WebSiteUrl }) => ({
      comment,
      FirstName,
      Email,
      WebSiteUrl,
    })),
  };
}

// ---------- target ----------

async function api(method, route, body) {
  const res = await fetch(`${TARGET_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

// Large image transfers sometimes drop mid-stream ("terminated"); retry those.
async function withRetry(label, fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`  retry ${i}/${attempts - 1} ${label}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const absolute = (url) => (/^https?:/.test(url) ? url : `${SOURCE_URL}${url}`);

const uploaded = new Map(); // source url -> target file
async function upload(url) {
  const src = absolute(url);
  if (uploaded.has(src)) return uploaded.get(src);
  const blob = await withRetry(`download ${src}`, async () => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download ${src}: ${res.status}`);
    return new Blob([await res.arrayBuffer()], { type: res.headers.get('content-type') || undefined });
  });
  const [file] = await withRetry(`upload ${src}`, () => {
    const form = new FormData();
    form.append('files', blob, decodeURIComponent(path.basename(new URL(src).pathname)));
    return api('POST', '/api/upload', form);
  });
  uploaded.set(src, file);
  return file;
}

const lookups = new Map(); // "collection:name" -> documentId
async function findOrCreate(collection, field, name) {
  const key = `${collection}:${name.toLowerCase()}`;
  if (lookups.has(key)) return lookups.get(key);
  const qs = new URLSearchParams({ [`filters[${field}][$eqi]`]: name, status: 'published' });
  const found = await api('GET', `/api/${collection}?${qs}`);
  const id =
    found.data[0]?.documentId ??
    (await api('POST', `/api/${collection}?status=published`, { data: { [field]: name } })).data.documentId;
  lookups.set(key, id);
  return id;
}

// Blocks image nodes embed the file object; point them at the re-uploaded copy.
async function rehostBlockImages(blocks) {
  for (const node of blocks) {
    if (node.type !== 'image' || !node.image?.url) continue;
    const file = await upload(node.image.url);
    node.image = { ...file, url: absolute(file.url).replace(SOURCE_URL, TARGET_URL) };
  }
}

async function migrate(item) {
  const { data } = item;
  await rehostBlockImages(data.description);

  const image = [];
  for (const url of item.media.image) image.push((await upload(url)).id);
  const contentImages = [];
  for (const url of item.media.contentImages) contentImages.push((await upload(url)).id);

  const categories = [];
  for (const name of item.categories) categories.push(await findOrCreate('categories', 'name', name));
  const tags = [];
  for (const name of item.tags) tags.push(await findOrCreate('tags', 'title', name));

  const created = await api('POST', '/api/firstblogs?status=published', {
    data: { ...data, image, contentImages, categories, tags },
  });
  const blogId = created.data.documentId;

  await api('POST', '/api/social-links?status=published', { data: { ...SOCIAL_LINKS, firstblog: blogId } });

  for (const c of item.comments) {
    await api('POST', '/api/comments?status=published', { data: { ...c, firstblog: blogId } });
  }
  return blogId;
}

async function backfillSocialLinks() {
  const qs = new URLSearchParams({
    'fields[0]': 'title',
    'populate[social_links][fields][0]': 'id',
    'pagination[pageSize]': '100',
  });
  const { data } = await api('GET', `/api/firstblogs?${qs}`);
  for (const post of data.filter((p) => !p.social_links?.length)) {
    await api('POST', '/api/social-links?status=published', { data: { ...SOCIAL_LINKS, firstblog: post.documentId } });
    console.log(`✓ social links: ${post.title}`);
  }
}

// ---------- main ----------

if (process.argv.includes('--social-links')) {
  if (!TARGET_URL || !TOKEN) throw new Error('Set TARGET_URL and STRAPI_TOKEN.');
  await backfillSocialLinks();
  process.exit(0);
}

const posts = await fetchOldPosts();
const items = posts.filter((p) => !ONLY_IDS || ONLY_IDS.has(p.id)).map(transformPost);
console.log(`Fetched ${posts.length} posts from ${SOURCE_URL}`);

if (DRY_RUN) {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'migrate-firstblogs.out.json');
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
  console.log(`Dry run: wrote ${file}`);
  process.exit(0);
}

if (!TARGET_URL || !TOKEN) {
  console.error('Set TARGET_URL and STRAPI_TOKEN (or pass --dry-run).');
  process.exit(1);
}

let failed = 0;
for (const item of items) {
  try {
    const id = await migrate(item);
    console.log(`✓ ${item.data.title} -> ${id}`);
  } catch (err) {
    failed++;
    console.error(`✗ [old id ${item.source.id}] ${item.data.title}: ${err.message}`);
  }
}
console.log(`Done: ${items.length - failed} created, ${failed} failed`);
process.exit(failed ? 1 : 0);
