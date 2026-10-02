import type { Schema, Struct } from '@strapi/strapi';

export interface SharedBlog1 extends Struct.ComponentSchema {
  collectionName: 'components_shared_blog1s';
  info: {
    displayName: 'blog1';
  };
  attributes: {
    text: Schema.Attribute.String;
  };
}

export interface SharedMedia extends Struct.ComponentSchema {
  collectionName: 'components_shared_media';
  info: {
    displayName: 'Media';
    icon: 'file-video';
  };
  attributes: {
    file: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    yes: Schema.Attribute.Boolean;
  };
}

export interface SharedQuote extends Struct.ComponentSchema {
  collectionName: 'components_shared_quotes';
  info: {
    displayName: 'Quote';
    icon: 'indent';
  };
  attributes: {
    body: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface SharedRichText extends Struct.ComponentSchema {
  collectionName: 'components_shared_rich_texts';
  info: {
    description: '';
    displayName: 'Rich text';
    icon: 'align-justify';
  };
  attributes: {
    body: Schema.Attribute.RichText;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: '';
    displayName: 'Seo';
    icon: 'allergies';
    name: 'Seo';
  };
  attributes: {};
}

export interface SharedSlider extends Struct.ComponentSchema {
  collectionName: 'components_shared_sliders';
  info: {
    description: '';
    displayName: 'Slider';
    icon: 'address-book';
  };
  attributes: {
    files: Schema.Attribute.Media<'images', true>;
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
      'shared.blog1': SharedBlog1;
      'shared.media': SharedMedia;
      'shared.quote': SharedQuote;
      'shared.rich-text': SharedRichText;
      'shared.seo': SharedSeo;
      'shared.slider': SharedSlider;
      'specialty.audience-link': SpecialtyAudienceLink;
      'specialty.faq-item': SpecialtyFaqItem;
      'specialty.pillar': SpecialtyPillar;
      'specialty.text-item': SpecialtyTextItem;
      'specialty.therapist-widget': SpecialtyTherapistWidget;
    }
  }
}
