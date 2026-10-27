import type { Schema, Struct } from '@strapi/strapi';

export interface BlogTakeawayItem extends Struct.ComponentSchema {
  collectionName: 'components_blog_takeaway_items';
  info: {
    displayName: 'Takeaway item';
    icon: 'check';
  };
  attributes: {
    text: Schema.Attribute.String;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: 'Search engine and social sharing metadata for a page';
    displayName: 'SEO';
    icon: 'search';
  };
  attributes: {
    canonicalURL: Schema.Attribute.String;
    keywords: Schema.Attribute.Text;
    metaDescription: Schema.Attribute.Text;
    metaImage: Schema.Attribute.Media<'images'>;
    metaRobots: Schema.Attribute.String;
    metaTitle: Schema.Attribute.String;
    preventIndexing: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    structuredData: Schema.Attribute.JSON;
  };
}

export interface SpecialtyAudienceLink extends Struct.ComponentSchema {
  collectionName: 'components_specialty_audience_links';
  info: {
    description: 'A chip with a label that links to a specialty page';
    displayName: 'Audience Link';
    icon: 'link';
  };
  attributes: {
    label: Schema.Attribute.String & Schema.Attribute.Required;
    page: Schema.Attribute.Relation<
      'oneToOne',
      'api::specialty-page.specialty-page'
    >;
  };
}

export interface SpecialtyFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_specialty_faq_items';
  info: {
    description: 'A question and answer pair';
    displayName: 'FAQ Item';
    icon: 'question-circle';
  };
  attributes: {
    answer: Schema.Attribute.Text & Schema.Attribute.Required;
    question: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface SpecialtyPillar extends Struct.ComponentSchema {
  collectionName: 'components_specialty_pillars';
  info: {
    description: 'A benefit card with a title and description';
    displayName: 'Pillar';
    icon: 'star';
  };
  attributes: {
    description: Schema.Attribute.Text & Schema.Attribute.Required;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface SpecialtyTextItem extends Struct.ComponentSchema {
  collectionName: 'components_specialty_text_items';
  info: {
    description: 'A single line of text used in repeatable lists';
    displayName: 'Text Item';
    icon: 'align-left';
  };
  attributes: {
    text: Schema.Attribute.Text & Schema.Attribute.Required;
  };
}

export interface SpecialtyTherapistWidget extends Struct.ComponentSchema {
  collectionName: 'components_specialty_therapist_widgets';
  info: {
    description: 'Heading, button label and search filters for the therapist cards on a specialty page';
    displayName: 'Therapist Widget';
    icon: 'user-friends';
  };
  attributes: {
    cardCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 6;
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<3>;
    clientFocus: Schema.Attribute.Component<'specialty.text-item', true>;
    ctaLabel: Schema.Attribute.String;
    heading: Schema.Attribute.String;
    issues: Schema.Attribute.Component<'specialty.text-item', true>;
    show: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    specializations: Schema.Attribute.Component<'specialty.text-item', true>;
    therapyTypes: Schema.Attribute.Component<'specialty.text-item', true>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'blog.takeaway-item': BlogTakeawayItem;
      'shared.seo': SharedSeo;
      'specialty.audience-link': SpecialtyAudienceLink;
      'specialty.faq-item': SpecialtyFaqItem;
      'specialty.pillar': SpecialtyPillar;
      'specialty.text-item': SpecialtyTextItem;
      'specialty.therapist-widget': SpecialtyTherapistWidget;
    }
  }
}
