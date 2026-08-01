import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentChipBody } from './AttachmentChipBody';

describe('AttachmentChipBody', () => {
  test('can render an icon-only chip while preserving remove accessibility', () => {
    const markup = renderToStaticMarkup(
      createElement(AttachmentChipBody, {
        kind: 'pasted-text',
        label: 'Active app: Chromium',
        leadingVisual: createElement('img', {
          className: 'composer-attachment-chip__icon',
          src: 'data:image/png;base64,AAAA',
          alt: '',
        }),
        hideLabel: true,
        onRemoveClick: () => {},
      }),
    );

    expect(markup).toContain('composer-attachment-chip__icon');
    expect(markup).not.toContain('composer-attachment-chip__label');
    expect(markup).toContain('Remove Active app: Chromium');
  });

  test('can suppress the default file icon while showing the label', () => {
    const markup = renderToStaticMarkup(
      createElement(AttachmentChipBody, {
        kind: 'pasted-text',
        label: 'Active app: Chromium',
        suppressDefaultIcon: true,
        onRemoveClick: () => {},
      }),
    );

    expect(markup).not.toContain('composer-attachment-chip__icon');
    expect(markup).toContain('composer-attachment-chip__label');
    expect(markup).toContain('Active app: Chromium');
  });
});
