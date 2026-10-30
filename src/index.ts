import type { Core } from '@strapi/strapi';
import type { Knex } from 'knex';

const MODALITY_UID = 'api::modality-page.modality-page';
const TABLE = 'modality_pages';
const LINK_TABLE = 'modality_pages_other_modalities_lnk';

// Publishing a document recreates its published row, which wipes the
// `otherModalities` links other published modality pages hold to it.
// After any modality publish, rebuild every published page's links from its
// draft's links. Written straight to the link table because document-service
// updates would recreate the published rows again.
// Runs on the publish's own transaction: on SQLite the pool has a single
// connection, so querying outside it deadlocks until the acquire timeout.
async function resyncOtherModalities(strapi: Core.Strapi) {
  await strapi.db.transaction(({ trx }) => resync(trx));
}

async function resync(knex: Knex.Transaction) {
  const rows: { id: number; document_id: string; published_at: unknown }[] = await knex(TABLE).select(
    'id',
    'document_id',
    'published_at'
  );

  const draftByDoc = new Map<string, number>();
  const publishedByDoc = new Map<string, number>();
  for (const r of rows) (r.published_at ? publishedByDoc : draftByDoc).set(r.document_id, r.id);

  const docByDraftId = new Map([...draftByDoc].map(([doc, id]) => [id, doc]));

  for (const [docId, publishedId] of publishedByDoc) {
    const draftId = draftByDoc.get(docId);
    if (!draftId) continue;

    const links: { inv_modality_page_id: number; modality_page_ord: number }[] = await knex(LINK_TABLE)
      .where({ modality_page_id: draftId })
      .select('inv_modality_page_id', 'modality_page_ord');

    const wanted = links
      .map((l) => ({
        modality_page_id: publishedId,
        inv_modality_page_id: publishedByDoc.get(docByDraftId.get(l.inv_modality_page_id) as string),
        modality_page_ord: l.modality_page_ord,
      }))
      .filter((l) => l.inv_modality_page_id);

    await knex(LINK_TABLE).where({ modality_page_id: publishedId }).del();
    if (wanted.length) await knex(LINK_TABLE).insert(wanted);
  }
}

const SITE_SOCIAL_UID = 'api::site-social.site-social' as const;

const SITE_SOCIAL_SEED = {
  facebook: 'https://www.facebook.com/people/Creativeartsconnect/61573849441775/',
  linkedin: 'https://www.linkedin.com/company/creative-arts-connect/about/',
  tiktok: 'https://www.tiktok.com/@creativeartsconnect',
  instagram: 'https://www.instagram.com/creativeartsconnect/',
};

async function ensureSiteSocial(strapi: Core.Strapi) {
  const existing = await strapi.documents(SITE_SOCIAL_UID).findFirst();
  if (!existing) {
    await strapi.documents(SITE_SOCIAL_UID).create({ data: SITE_SOCIAL_SEED });
  }

  const action = `${SITE_SOCIAL_UID}.find`;
  const alreadyPublic = await strapi.db.query('plugin::users-permissions.permission').findMany({
    where: { action, role: { type: 'public' } },
  });
  if (alreadyPublic.length > 0) return;

  const role = await strapi.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'public' },
  });
  if (!role) return;

  await strapi.db.query('plugin::users-permissions.permission').create({
    data: { action, role: role.id },
  });
}

export default {
  register({ strapi }: { strapi: Core.Strapi }) {
    strapi.documents.use(async (context, next) => {
      const result = await next();
      if (context.uid === MODALITY_UID && context.action === 'publish') {
        await resyncOtherModalities(strapi);
      }
      return result;
    });
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    try {
      await ensureSiteSocial(strapi);
    } catch (error) {
      strapi.log.error('Failed to ensure the Site Social entry');
      strapi.log.error(error);
    }
  },
};
