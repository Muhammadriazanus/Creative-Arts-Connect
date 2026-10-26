/**
 * blog-post controller
 */

import { factories } from '@strapi/strapi';

const slugify = (text: string) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');

// `slug` is optional, so fall back to the title-derived slug the frontend has always linked to.
const slugOf = (article: { slug?: string | null; title?: string | null }) =>
  article.slug || slugify(article.title || '');

const recencyScore = (dateValue?: string | null) => {
  if (!dateValue) return 1;
  const published = new Date(dateValue);
  if (Number.isNaN(published.getTime())) return 1;
  const days = (Date.now() - published.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 30) return 10;
  if (days <= 90) return 7;
  if (days <= 180) return 5;
  if (days <= 365) return 3;
  return 1;
};

const idsOf = (items?: { id?: number }[] | null) =>
  (items ?? []).map((item) => item.id).filter((id): id is number => id != null);

const excerptFrom = (description?: { children?: { text?: string }[] }[] | null) => {
  if (!Array.isArray(description)) return '';
  for (const block of description) {
    const text = (block?.children ?? [])
      .map((child) => child?.text ?? '')
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
};

const authorNameOf = (article: {
  authorName?: string | null;
  blogAuthors?: { authorname?: string | null }[] | null;
}) =>
  (article.authorName || article.blogAuthors?.[0]?.authorname || '').trim().toLowerCase();

const scoreArticle = (current: any, candidate: any) => {
  let score = 0;
  const currentCategories = new Set(idsOf(current.categories));
  if (idsOf(candidate.categories).some((id) => currentCategories.has(id))) score += 40;

  const currentTags = new Set(idsOf(current.tags));
  const sharedTags = idsOf(candidate.tags).filter((id) => currentTags.has(id)).length;
  score += Math.min(sharedTags * 10, 40);

  const currentAuthor = authorNameOf(current);
  const candidateAuthor = authorNameOf(candidate);
  if (currentAuthor && currentAuthor === candidateAuthor) score += 10;

  score += recencyScore(candidate.date);
  return score;
};

export default factories.createCoreController('api::blog-post.blog-post', ({ strapi }) => ({
  async related(ctx) {
    const slug = String(ctx.params.slug || '');
    const articles = await strapi.db.query('api::blog-post.blog-post').findMany({
      where: { publishedAt: { $notNull: true } },
      populate: {
        categories: true,
        tags: true,
        blogAuthors: true,
        image: true,
        comments: true
      }
    });

    const current = articles.find((article) => slugOf(article) === slug);
    if (!current) return ctx.notFound();

    const data = articles
      .filter((article) => article.id !== current.id)
      .map((article) => ({
        article,
        score: scoreArticle(current, article)
      }))
      .filter((item) => item.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(({ article, score }) => ({
        id: article.id,
        title: article.title,
        slug: slugOf(article),
        image: article.image?.[0]?.url ?? null,
        date: article.date ?? null,
        excerpt: excerptFrom(article.description),
        commentCount: Array.isArray(article.comments) ? article.comments.length : 0,
        score
      }));

    ctx.body = { data };
  }
}));
