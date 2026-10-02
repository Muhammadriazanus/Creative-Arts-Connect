import type { Core } from '@strapi/strapi';

const MODALITY_UID = 'api::modality-page.modality-page';
const TABLE = 'modality_pages';
const LINK_TABLE = 'modality_pages_other_modalities_lnk';

// Publishing a document recreates its published row, which wipes the
// `otherModalities` links other published modality pages hold to it.
// After any modality publish, rebuild every published page's links from its
// draft's links. Written straight to the link table because document-service
// updates would recreate the published rows again.
async function resyncOtherModalities(strapi: Core.Strapi) {
  const knex = strapi.db.connection;
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

  bootstrap() {},
};
