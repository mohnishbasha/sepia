/**
 * AC-P5 — secret field values are stripped from the compact view.
 *
 * `redactSecrets()` only ever ran on the model's OWN output text, to set a
 * boolean flag. Page content reached the model verbatim, so a password already
 * typed into a field — or any secret the page renders — was sent upstream.
 */

import { describe, it, expect } from 'vitest';
import { redactCompactView } from '../../privacy/index.js';
import type { CompactView, CompactNode } from '../../types/index.js';

function viewWith(nodes: CompactNode[]): CompactView {
  return {
    url: 'https://example.com/login',
    title: 'Login',
    verbosity: 'standard',
    tokenCount: 0,
    timestampMs: 0,
    nodes,
  };
}

describe('AC-P5 — secret values never enter the compact view', () => {
  it('redacts the value of a password field', () => {
    const view = viewWith([
      { handle: 'e1', role: 'textbox', name: 'Password', indent: 0, value: 'hunter2' },
    ]);

    const redacted = redactCompactView(view);
    expect(redacted.nodes[0]?.value).toBe('[REDACTED]');
  });

  it.each(['API key', 'Secret token', 'CVV', 'Card number', 'Social security number'])(
    'redacts the value of a field named %j',
    (name) => {
      const view = viewWith([
        { handle: 'e1', role: 'textbox', name, indent: 0, value: 'sensitive' },
      ]);
      expect(redactCompactView(view).nodes[0]?.value).toBe('[REDACTED]');
    },
  );

  it('leaves ordinary field values intact', () => {
    const view = viewWith([
      { handle: 'e1', role: 'textbox', name: 'Email', indent: 0, value: 'alice@example.com' },
    ]);
    expect(redactCompactView(view).nodes[0]?.value).toBe('alice@example.com');
  });

  it('redacts an API key rendered as page text regardless of field name', () => {
    const view = viewWith([
      { role: 'heading', name: 'Your key is sk-proj-ABCDEF1234567890', indent: 0 },
    ]);
    expect(redactCompactView(view).nodes[0]?.name).not.toContain('sk-proj-ABCDEF1234567890');
  });

  it('does not mutate the input view', () => {
    const nodes: CompactNode[] = [
      { handle: 'e1', role: 'textbox', name: 'Password', indent: 0, value: 'hunter2' },
    ];
    const view = viewWith(nodes);
    redactCompactView(view);
    expect(nodes[0]?.value).toBe('hunter2');
  });

  it('leaves a node with no value untouched', () => {
    const view = viewWith([{ handle: 'e1', role: 'button', name: 'Sign in', indent: 0 }]);
    expect(redactCompactView(view).nodes[0]?.value).toBeUndefined();
  });
});

describe('AC-P5 — the nearby label is page text too', () => {
  // `context` (issue #3) carries text lifted from around a control so colliding
  // controls can be told apart. It is page content on its way to the model like
  // any other, and it was added after this redaction pass was written — so it
  // travelled unredacted. A row showing an API key beside a "Copy" button is
  // exactly the shape that produces one.
  it('redacts a credential appearing in the nearby label', () => {
    const view = viewWith([
      {
        handle: 'e1',
        role: 'button',
        name: 'Copy',
        indent: 0,
        context: 'Live key sk-proj-ABCDEF1234567890',
      },
    ]);

    expect(redactCompactView(view).nodes[0]?.context).not.toContain('sk-proj-ABCDEF1234567890');
  });

  it('leaves an ordinary label alone', () => {
    const view = viewWith([
      { handle: 'e1', role: 'button', name: 'Delete', indent: 0, context: 'Item 3' },
    ]);

    expect(redactCompactView(view).nodes[0]?.context).toBe('Item 3');
  });

  it('leaves a node with no label untouched', () => {
    const view = viewWith([{ handle: 'e1', role: 'button', name: 'Delete', indent: 0 }]);

    expect(redactCompactView(view).nodes[0]?.context).toBeUndefined();
  });
});
