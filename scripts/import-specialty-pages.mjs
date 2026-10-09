// Turns the "Specialty Page Copy" .docx handoff documents into Specialty Page
// entries (plus their Lead Magnet), shaped like the pages already in the CMS.
//
//   DOCS_DIR="…/Speciality Pages" TARGET_URL=… STRAPI_TOKEN=… node scripts/import-specialty-pages.mjs
//       → parses every doc, compares with the target, writes import-specialty-pages.out.json. Changes nothing.
//   … node scripts/import-specialty-pages.mjs --apply
//       → creates the pages whose slug is not in the target yet (ONLY_SLUGS=a,b to limit).
//
// PHOTOS_FROM=<slug> copies heroPhoto/helpsPhoto from an existing page onto new pages.
// Needs pandoc on PATH to read .docx.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DOCS_DIR = process.env.DOCS_DIR;
const TARGET_URL = (process.env.TARGET_URL || '').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_TOKEN;
const APPLY = process.argv.includes('--apply');
const PHOTOS_FROM = process.env.PHOTOS_FROM;
const ONLY_SLUGS = process.env.ONLY_SLUGS ? new Set(process.env.ONLY_SLUGS.split(',')) : null;
const OUT_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'import-specialty-pages.out.json');

const MODALITY_SLUGS = {
  'art therapy': 'art-therapy',
  'music therapy': 'music-therapy',
  'play therapy': 'play-therapy',
  'dance and movement therapy': 'dance-movement-therapy',
  'dance/movement therapy': 'dance-movement-therapy',
  'dance & movement therapy': 'dance-movement-therapy',
  'dance & movement': 'dance-movement-therapy',
  'dance and movement': 'dance-movement-therapy',
  'expressive arts therapy': 'expressive-arts-therapy',
  'drama therapy': 'drama-therapy',
};

// Therapist-carousel filters, using the therapist profile vocabulary
// (cats-frontend config/constants.ts ISSUES / CLIENT_FOCUS_FILTER).
const WIDGET_FILTERS = {
  'adhd-therapy': { issues: ['Neurodevelopmental Disorders (ADHD, Autism)'] },
  'anxiety-therapy': { issues: ['Anxiety Disorders'] },
  'autism-therapy': { issues: ['Autism Spectrum Disorder', 'Neurodevelopmental Disorders (ADHD, Autism)'] },
  'burnout-therapy': { issues: ['Burnout'] },
  'burnout-stress-therapy': { issues: ['Burnout'] },
  'burnout-stress': { issues: ['Burnout'] },
  'child-therapy': { clientFocus: ['Children (under 10)'] },
  depression: { issues: ['Depressive Disorders', 'Mood Disorders'] },
  'depression-therapy': { issues: ['Depressive Disorders', 'Mood Disorders'] },
  'dementia-therapy': { issues: ['Neurocognitive Disorders (Dementia)'], clientFocus: ['Seniors (55 and older)'] },
  'seniors-dementia': { issues: ['Neurocognitive Disorders (Dementia)'], clientFocus: ['Seniors (55 and older)'] },
};

// ---------- parse ----------

const clean = (s) =>
  s
    .replace(/\\([>|.\-*_'"[\]()#!])/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^>\s*/, '')
    .replace(/\\$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const isItalicNote = (raw) => /^\*[^*]/.test(raw.trim()) && /\*$/.test(raw.trim());
const isBoldLine = (raw) => /^\*\*.+\*\*$/.test(raw.trim());
const isBullet = (raw) => /^[●•]\s*/.test(raw.trim());
const isCta = (raw) => /^>/.test(raw.trim());
const noArrow = (s) => s.replace(/\s*→\s*$/, '').trim();
const italicText = (raw) => clean(raw.trim().replace(/^\*|\*$/g, ''));

function splitSections(md) {
  const sections = {};
  let key = 'preamble';
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\*\*(SECTION (\d+):[^*]*|APPENDIX[^*]*)\*\*\s*$/);
    if (m) {
      key = m[2] ? `s${m[2]}` : 'appendix';
      sections[key] = [];
      continue;
    }
    // Horizontal rules (-----) only separate tiles in some docs.
    if (line.trim() && !/^-{3,}$/.test(line.trim())) (sections[key] ||= []).push(line);
  }
  return sections;
}

// Bullet lines may hold several "● a\ ● b" items when pandoc keeps a hard break.
const bullets = (lines) =>
  lines
    .filter(isBullet)
    .flatMap((l) => l.split(/\\?\s*●/))
    .map((l) => clean(l.replace(/^[●•]\s*/, '')))
    .filter(Boolean);

const firstBold = (lines) => clean(lines.find(isBoldLine) || '');
const plain = (lines) =>
  lines.filter((l) => !isBoldLine(l) && !isItalicNote(l) && !isBullet(l) && !isCta(l)).map(clean);

function appendixValue(lines, label) {
  const i = lines.findIndex((l) => clean(l).toLowerCase().startsWith(label.toLowerCase()));
  return i === -1 ? '' : clean(lines[i + 1] || '');
}

function parseDoc(md, file) {
  const s = splitSections(md);
  const warn = [];

  // 1 Hero
  const hero = s.s1 || [];
  const crumbLine = hero.find((l) => /Breadcrumb:/i.test(l)) || '';
  const heroBreadcrumbs = italicText(crumbLine)
    .replace(/^Breadcrumb:\s*/i, '')
    .split('>')
    .map((t) => t.trim())
    .filter(Boolean);
  const heroBold = hero.filter(isBoldLine);
  const heroHeading = clean(heroBold[0] || '');
  const trust = hero.find((l) => l.includes('·'));
  const heroCta = hero.find(isCta);

  // 2 Problem
  const problem = s.s2 || [];

  // 3 Helps: "**Title.** description" cards
  const helps = s.s3 || [];
  const helpsPillars = helps
    .filter((l) => /^\*\*[^*]+\*\*\s*\S/.test(l.trim()))
    .map((l) => {
      const m = l.trim().match(/^\*\*([^*]+)\*\*\s*(.*)$/);
      return { title: clean(m[1]).replace(/[.:]$/, ''), description: clean(m[2]) };
    });
  const helpsDescription = plain(helps).filter((t) => !helpsPillars.some((p) => t.includes(p.description)))[0] || '';

  // 4 Modalities: plain lines naming a modality, then the recommendation line
  const mods = s.s4 || [];
  const modalityNames = plain(mods).filter((t) => MODALITY_SLUGS[t.toLowerCase()]);
  const modalities = modalityNames.map((t) => MODALITY_SLUGS[t.toLowerCase()]);
  // The italic "Recommendation line" under the tiles is an editor's note, not page copy.
  const modalitiesNote = plain(mods)
    .filter((t) => !MODALITY_SLUGS[t.toLowerCase()])
    .join(' ');
  const unknownMods = plain(mods).filter((t) => t.split(' ').length <= 5 && /therapy/i.test(t) && !MODALITY_SLUGS[t.toLowerCase()]);
  if (unknownMods.length) warn.push(`unmapped modality: ${unknownMods.join(', ')}`);

  // 5 Audience: "●" bullets in some docs, plain lines under an unbolded heading in others
  const aud = s.s5 || [];
  const audPlain = plain(aud);
  const audienceHeading = firstBold(aud) || audPlain[0] || '';
  const audienceNote =
    [...audPlain, ...aud.filter(isItalicNote).map(italicText)].find((t) => /^Tap /i.test(t)) || '';
  const audiences = bullets(aud).length
    ? bullets(aud)
    : audPlain.filter((t) => t !== audienceHeading && t !== audienceNote);

  // 6 Therapist carousel
  const car = s.s6 || [];
  const carCta = car.find(isCta);

  // 7 Lead magnet
  const lm = s.s7 || [];
  const lmBold = lm.filter(isBoldLine).map(clean);
  const lmCta = lm.find(isCta);
  const leadMagnet = {
    overline: lmBold[0] || 'Free Guide',
    heading: lmBold[1] || '',
    description: plain(lm)[0] || '',
    bullets: bullets(lm),
    ctaLabel: lmCta ? noArrow(clean(lmCta)) : '',
  };

  // 9 FAQ: bold question followed by answer paragraph(s)
  const faqLines = (s.s9 || []).filter((l) => !isItalicNote(l));
  const faqItems = [];
  for (const l of faqLines.slice(faqLines.findIndex(isBoldLine) + 1)) {
    if (isBoldLine(l)) faqItems.push({ question: clean(l), answer: '' });
    else if (faqItems.length) faqItems.at(-1).answer = [faqItems.at(-1).answer, clean(l)].filter(Boolean).join(' ');
  }

  // Appendix
  const app = s.appendix || [];
  const slugPath = appendixValue(app, 'URL Slug');
  const slug = slugPath.split('/').filter(Boolean).pop() || '';

  const page = {
    slug,
    seoTitle: appendixValue(app, 'Page Title'),
    seoDescription: appendixValue(app, 'Meta Description'),
    primaryKeyword: appendixValue(app, 'Primary Keyword'),
    secondaryKeywords: appendixValue(app, 'Secondary Keywords'),
    showHero: true,
    heroBreadcrumbs: heroBreadcrumbs.map((text) => ({ text })),
    heroHeading,
    heroDescription: plain(hero).filter((t) => !t.includes('·'))[0] || '',
    heroCtaLabel: heroCta ? noArrow(clean(heroCta)) : '',
    heroTrustLine: trust ? clean(trust) : '',
    showProblem: true,
    problemHeading: firstBold(problem),
    problemDescription: plain(problem)[0] || '',
    feelings: bullets(problem).map((text) => ({ text })),
    showHelps: true,
    helpsHeading: firstBold(helps),
    helpsDescription,
    helpsPillars,
    showModalities: true,
    modalitiesHeading: firstBold(mods),
    modalitiesNote,
    showAudience: true,
    audienceHeading,
    audiences: audiences.map((text) => ({ text })),
    audienceNote,
    therapistWidget: {
      show: true,
      heading: firstBold(car),
      ctaLabel: carCta ? clean(carCta) : '',
      cardCount: 3,
      issues: (WIDGET_FILTERS[slug]?.issues || []).map((text) => ({ text })),
      specializations: [],
      clientFocus: (WIDGET_FILTERS[slug]?.clientFocus || []).map((text) => ({ text })),
      therapyTypes: [],
    },
    showRelatedReading: true,
    showFaq: true,
    faqItems,
    showLeadMagnet: true,
  };

  for (const [k, v] of Object.entries(page)) {
    if (v === '' || (Array.isArray(v) && !v.length)) warn.push(`empty ${k}`);
  }
  if (!WIDGET_FILTERS[slug] && !['grief-therapy', 'life-transitions', 'neurodivergence', 'trauma-therapy'].includes(slug)) warn.push('no therapist widget filter for this slug');
  if (!leadMagnet.heading) warn.push('no lead magnet heading');

  return { file, page, modalities, leadMagnet, warnings: warn };
}

function readDocs() {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.docx') && !f.startsWith('~$'))
    .sort()
    .map((f) => {
      const md = execFileSync('pandoc', [path.join(DOCS_DIR, f), '-t', 'markdown-smart', '--wrap=none'], { encoding: 'utf8' });
      return parseDoc(md, f);
    });
}

// ---------- target ----------

async function api(method, route, body) {
  const res = await fetch(`${TARGET_URL}${route}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const POPULATE = [
  'populate[heroBreadcrumbs]=true',
  'populate[feelings]=true',
  'populate[helpsPillars]=true',
  'populate[audiences]=true',
  'populate[faqItems]=true',
  'populate[therapistWidget][populate]=*',
  'populate[modalities][fields][0]=slug',
  'populate[leadMagnet][populate]=*',
  'populate[heroPhoto][fields][0]=id',
  'populate[helpsPhoto][fields][0]=id',
].join('&');

async function existingPages() {
  const { data } = await api('GET', `/api/specialty-pages?status=draft&${POPULATE}&pagination[pageSize]=100`);
  return new Map(data.map((p) => [p.slug, p]));
}

const stripIds = (v) =>
  JSON.parse(JSON.stringify(v, (k, x) => (['id', 'documentId'].includes(k) ? undefined : x)));
const norm = (v) =>
  JSON.stringify(stripIds(v ?? null), (k, x) => (typeof x === 'string'
      ? x.replace(/\s*→/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim()
      : x));

function diffPage(doc, live) {
  const diffs = [];
  for (const [k, v] of Object.entries(doc.page)) {
    if (k === 'therapistWidget') {
      for (const f of ['heading', 'ctaLabel']) {
        if (norm(v[f]) !== norm(live.therapistWidget?.[f])) diffs.push(`therapistWidget.${f}`);
      }
      continue;
    }
    if (norm(v) !== norm(live[k])) diffs.push(k);
  }
  const liveMods = (live.modalities || []).map((m) => m.slug).sort().join(',');
  if (liveMods !== [...doc.modalities].sort().join(',')) diffs.push(`modalities (CMS: ${liveMods || 'none'})`);
  if (!live.leadMagnet) diffs.push('leadMagnet (none in CMS)');
  else if (norm(live.leadMagnet.heading) !== norm(doc.leadMagnet.heading)) diffs.push('leadMagnet.heading');
  return diffs;
}

// The uid field is only auto-filled by the admin UI, not over REST.
const slugify = (s) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function findOrCreateLeadMagnet(lm) {
  const qs = new URLSearchParams({ 'filters[heading][$eqi]': lm.heading, status: 'published' });
  const found = await api('GET', `/api/lead-magnets?${qs}`);
  if (found.data[0]) return found.data[0].documentId;
  const created = await api('POST', '/api/lead-magnets?status=published', {
    data: { ...lm, slug: slugify(lm.heading), bullets: lm.bullets.map((text) => ({ text })) },
  });
  return created.data.documentId;
}

async function modalityIds() {
  const { data } = await api('GET', '/api/modality-pages?fields[0]=slug&pagination[pageSize]=100');
  return new Map(data.map((m) => [m.slug, m.documentId]));
}

// ---------- main ----------

if (!DOCS_DIR || !TARGET_URL || !TOKEN) {
  console.error('Set DOCS_DIR, TARGET_URL and STRAPI_TOKEN.');
  process.exit(1);
}

const docs = readDocs();
const live = await existingPages();

const report = docs.map((d) => {
  const existing = live.get(d.page.slug);
  return {
    ...d,
    status: existing ? 'in CMS' : 'missing',
    differences: existing ? diffPage(d, existing) : [],
  };
});
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

for (const r of report) {
  console.log(`${r.status === 'missing' ? '+' : '='} ${r.page.slug.padEnd(24)} ${r.file}`);
  if (r.differences.length) console.log(`    differs from doc: ${r.differences.join(', ')}`);
  if (r.warnings.length) console.log(`    warnings: ${r.warnings.join('; ')}`);
}
console.log(`Wrote ${OUT_FILE}`);

if (!APPLY) process.exit(0);

const mods = await modalityIds();
const photoSource = PHOTOS_FROM ? live.get(PHOTOS_FROM) : null;
if (PHOTOS_FROM && !photoSource) throw new Error(`PHOTOS_FROM page "${PHOTOS_FROM}" not found`);
const photos = photoSource
  ? { heroPhoto: photoSource.heroPhoto?.id ?? null, helpsPhoto: photoSource.helpsPhoto?.id ?? null }
  : {};
let failed = 0;
for (const r of report.filter((x) => x.status === 'missing' && (!ONLY_SLUGS || ONLY_SLUGS.has(x.page.slug)))) {
  try {
    const leadMagnet = r.leadMagnet.heading ? await findOrCreateLeadMagnet(r.leadMagnet) : null;
    const modalities = r.modalities.map((slug) => mods.get(slug)).filter(Boolean);
    const created = await api('POST', '/api/specialty-pages?status=published', {
      data: { ...r.page, ...photos, modalities, leadMagnet },
    });
    console.log(`✓ created ${r.page.slug} -> ${created.data.documentId}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${r.page.slug}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
