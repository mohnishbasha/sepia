/**
 * AC-S8 — repeated controls carry the text that tells them apart.
 *
 * A list of rows each with a "Delete" button renders as N identical lines, so
 * no model — Sepia's own or a host driving it over MCP — can pick the third
 * one. Worse, a "Delete all" in a toolbar is indistinguishable from a per-row
 * delete, which is how a run reports success having destroyed the wrong thing.
 *
 * The fix is to attach the surrounding text, but only where it is needed:
 * a control whose role+name is already unique on the page gets nothing, so the
 * common case costs no extra tokens.
 */

import { describe, it, expect } from 'vitest';
import { serialize } from '../../serializer/index.js';
import type { AXSnapshot } from '../../serializer/index.js';

function button(name: string): AXSnapshot {
  return { role: 'button', name };
}

function text(t: string): AXSnapshot {
  return { role: 'StaticText', name: t };
}

/** A toolbar "Delete" above a list whose rows each have their own "Delete". */
const AMBIGUOUS_LIST: AXSnapshot = {
  role: 'WebArea',
  name: 'Items',
  children: [
    { role: 'heading', name: 'Items' },
    { role: 'navigation', name: 'Toolbar', children: [button('Delete')] },
    {
      role: 'list',
      name: '',
      children: [
        { role: 'listitem', name: '', children: [text('Item 1'), button('Delete')] },
        { role: 'listitem', name: '', children: [text('Item 2'), button('Delete')] },
        { role: 'listitem', name: '', children: [text('Item 3'), button('Delete')] },
      ],
    },
  ],
};

function contexts(snapshot: AXSnapshot): Array<string | undefined> {
  return serialize(snapshot, null, { verbosity: 'standard' })
    .nodes.filter((n) => n.handle !== undefined)
    .map((n) => n.context);
}

describe('AC-S8 — context is added only where names collide', () => {
  it('adds nothing when every control is already distinct', () => {
    const view = serialize(
      {
        role: 'WebArea',
        name: 'Form',
        children: [button('Save'), button('Cancel'), button('Publish')],
      },
      null,
      { verbosity: 'standard' },
    );

    expect(view.nodes.filter((n) => n.handle).map((n) => n.context)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('gives every colliding control some context', () => {
    const found = contexts(AMBIGUOUS_LIST);

    expect(found).toHaveLength(4);
    expect(found.every((c) => c !== undefined && c.length > 0)).toBe(true);
  });

  it('makes the colliding controls distinguishable from one another', () => {
    const found = contexts(AMBIGUOUS_LIST);

    // The whole point: four "Delete" buttons must no longer read identically.
    expect(new Set(found).size).toBe(4);
  });

  it('labels each row button with its row text', () => {
    const found = contexts(AMBIGUOUS_LIST);

    expect(found[1]).toContain('Item 1');
    expect(found[2]).toContain('Item 2');
    expect(found[3]).toContain('Item 3');
  });

  it('labels the toolbar button from its container, not a row', () => {
    const found = contexts(AMBIGUOUS_LIST);

    expect(found[0]).toContain('Toolbar');
    expect(found[0]).not.toContain('Item');
  });
});

describe('AC-S8 — the context is worth reading', () => {
  it('does not simply repeat the control name', () => {
    const view = serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          { role: 'group', name: 'Delete', children: [button('Delete')] },
          { role: 'group', name: 'Archive', children: [button('Delete')] },
        ],
      },
      null,
      { verbosity: 'standard' },
    );

    const first = view.nodes.filter((n) => n.handle)[0];
    expect(first?.context).not.toBe('Delete');
  });

  it('collapses whitespace and trims', () => {
    const view = serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          { role: 'listitem', name: '', children: [text('  Item   1  \n'), button('Go')] },
          { role: 'listitem', name: '', children: [text('Item 2'), button('Go')] },
        ],
      },
      null,
      { verbosity: 'standard' },
    );

    expect(view.nodes.filter((n) => n.handle)[0]?.context).toBe('Item 1');
  });

  it('caps a very long context rather than pasting a paragraph', () => {
    const long = 'x'.repeat(400);
    const view = serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          { role: 'listitem', name: '', children: [text(long), button('Go')] },
          { role: 'listitem', name: '', children: [text('short'), button('Go')] },
        ],
      },
      null,
      { verbosity: 'standard' },
    );

    const c = view.nodes.filter((n) => n.handle)[0]?.context ?? '';
    expect(c.length).toBeLessThanOrEqual(80);
  });

  it('omits the field entirely when nothing useful is nearby', () => {
    const view = serialize(
      { role: 'WebArea', name: '', children: [button('Go'), button('Go')] },
      null,
      { verbosity: 'standard' },
    );

    // Two bare buttons with no surrounding text: better to say nothing than to
    // invent a label. They stay separately addressable by handle.
    expect(view.nodes.filter((n) => n.handle).map((n) => n.context)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe('AC-S8 — junk context is worse than none', () => {
  function twoWithSurroundings(a: AXSnapshot[], b: AXSnapshot[]) {
    return serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          { role: 'group', name: '', children: [...a, button('Go')] },
          { role: 'group', name: '', children: [...b, button('Go')] },
        ],
      },
      null,
      { verbosity: 'standard' },
    ).nodes.filter((n) => n.handle);
  }

  it('rejects separator punctuation with no real words', () => {
    // Real pages put "|" dividers between links; the text between them is not a label.
    const nodes = twoWithSurroundings([text('| |')], [text('Genuine label')]);

    expect(nodes[0]?.context).toBeUndefined();
    expect(nodes[1]?.context).toBe('Genuine label');
  });

  it('rejects a scrap too short to identify anything', () => {
    const nodes = twoWithSurroundings([text('by')], [text('Genuine label')]);

    expect(nodes[0]?.context).toBeUndefined();
  });

  it('accepts a real row even when it contains separators', () => {
    const nodes = twoWithSurroundings(
      [text('354 points by bakigul | hide | 106 comments')],
      [text('other')],
    );

    expect(nodes[0]?.context).toContain('354 points');
  });
});

describe('AC-S8 — context must actually distinguish', () => {
  it('drops a label shared by every colliding control', () => {
    // All three sit under one heading, so "Section" is true of each and
    // separates none of them. Paying tokens for it buys nothing, and it invites
    // the model to think it has disambiguated.
    const view = serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          {
            role: 'region',
            name: 'Section',
            children: [button('Go'), button('Go'), button('Go')],
          },
        ],
      },
      null,
      { verbosity: 'standard' },
    );

    expect(view.nodes.filter((n) => n.handle).map((n) => n.context)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keeps labels when they genuinely differ', () => {
    const view = serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          { role: 'listitem', name: '', children: [text('Alpha row'), button('Go')] },
          { role: 'listitem', name: '', children: [text('Beta row'), button('Go')] },
        ],
      },
      null,
      { verbosity: 'standard' },
    );

    const found = view.nodes.filter((n) => n.handle).map((n) => n.context);
    expect(found).toEqual(['Alpha row', 'Beta row']);
  });

  it('keeps a label that singles one control out from the rest', () => {
    const view = serialize(
      {
        role: 'WebArea',
        name: '',
        children: [
          { role: 'navigation', name: 'Toolbar', children: [button('Delete')] },
          { role: 'listitem', name: '', children: [text('Row one'), button('Delete')] },
          { role: 'listitem', name: '', children: [text('Row two'), button('Delete')] },
        ],
      },
      null,
      { verbosity: 'standard' },
    );

    const found = view.nodes.filter((n) => n.handle).map((n) => n.context);
    expect(new Set(found).size).toBe(3);
    expect(found[0]).toBe('Toolbar');
  });
});

describe('AC-S8 — cost', () => {
  it('adds no tokens to a page with no collisions', () => {
    const clean: AXSnapshot = {
      role: 'WebArea',
      name: 'Login',
      children: [
        { role: 'textbox', name: 'Email' },
        { role: 'textbox', name: 'Password' },
        button('Sign in'),
      ],
    };

    const before = serialize(clean, null, { verbosity: 'standard' });
    expect(before.nodes.every((n) => n.context === undefined)).toBe(true);
  });
});

/**
 * AC-S12 — the label survives a page built out of rows (issue #44).
 *
 * Measured on Hacker News: thirty `link "hide"`, none labelled. A `hide` link's
 * siblings are all links, which `siblingText()` excludes; its only named
 * ancestor is the cell whose name concatenates the whole row and so restates
 * the link itself; and the story title lives in a *different* table row, so it
 * is neither sibling nor ancestor. What the walk did find was the page name,
 * "Hacker News" — true of all thirty, dropped by the distinctness rule, and in
 * the meantime it satisfied the lookup and pre-empted anything better.
 */
describe('AC-S12 — rows', () => {
  /** Two stories, each a title cell followed by a subtext cell, as HN builds them. */
  function story(title: string, when: string): AXSnapshot[] {
    return [
      { role: 'cell', name: title, children: [{ role: 'link', name: title }] },
      {
        role: 'cell',
        name: `by someone ${when} | hide | 5 comments`,
        children: [
          { role: 'link', name: when },
          { role: 'link', name: 'hide' },
          { role: 'link', name: '5 comments' },
        ],
      },
    ];
  }

  const FEED: AXSnapshot = {
    role: 'WebArea',
    // The page name is the candidate the walk finds for every row, and it
    // separates none of them.
    name: 'Hacker News',
    children: [
      ...story('How Complex Systems Fail', '6 hours ago'),
      ...story('The Vibe Tax', '3 hours ago'),
      ...story('What Is a Harness', '7 hours ago'),
    ],
  };

  const labelsFor = (name: string) =>
    serialize(FEED, null, {})
      .nodes.filter((n) => n.name === name)
      .map((n) => n.context);

  it('labels each repeated control with its own row', () => {
    const labels = labelsFor('hide');

    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('How Complex Systems Fail');
    expect(labels[1]).toContain('The Vibe Tax');
    expect(labels[2]).toContain('What Is a Harness');
  });

  it('does not settle for the page name, which is true of every row', () => {
    expect(labelsFor('hide').every((l) => l !== 'Hacker News')).toBe(true);
  });

  it('skips an ancestor whose name merely restates the control', () => {
    // The subtext cell is named "by someone 3 hours ago | hide | 5 comments":
    // it contains the link's own name, so it describes it rather than
    // distinguishing it from its siblings.
    expect(labelsFor('hide').every((l) => l !== undefined && !l.includes('| hide |'))).toBe(true);
  });

  it('does not reach past another member of the group into the previous row', () => {
    const labels = labelsFor('5 comments');

    expect(labels[1]).toContain('The Vibe Tax');
    expect(labels[1]).not.toContain('How Complex Systems Fail');
  });

  it('leaves unnamed controls alone', () => {
    // An unnamed control is identified by what comes *after* it — Hacker News's
    // upvote arrows are `link ""` sitting before their story. Walking backwards
    // yields the previous row every time, so it is left blank rather than
    // labelled with something confidently wrong.
    // Shaped as Hacker News actually is: the arrow sits in an *unnamed* cell,
    // and the title it belongs to is in the cell that follows.
    const withArrows: AXSnapshot = {
      role: 'WebArea',
      name: 'Feed',
      children: [
        { role: 'cell', name: '', children: [{ role: 'link', name: '' }] },
        { role: 'cell', name: 'Story one', children: [{ role: 'link', name: 'Story one' }] },
        { role: 'cell', name: '', children: [{ role: 'link', name: '' }] },
        { role: 'cell', name: 'Story two', children: [{ role: 'link', name: 'Story two' }] },
      ],
    };

    const arrows = serialize(withArrows, null, {}).nodes.filter(
      (n) => n.role === 'link' && n.name === '',
    );
    expect(arrows.length).toBeGreaterThan(1);
    expect(arrows.every((n) => n.context === undefined)).toBe(true);
  });

  it('judges distinctness after trimming, not before', () => {
    // Two labels that differ only past the cap would pass an untrimmed check
    // and then collapse into the same string, handing back a group that looks
    // narrowed and is not. Dropping them is the honest outcome.
    const prefix = 'A very long shared headline prefix that runs on and on';
    const shared: AXSnapshot = {
      role: 'WebArea',
      name: 'Feed',
      children: [...story(`${prefix} one`, '1 hour ago'), ...story(`${prefix} two`, '2 hours ago')],
    };

    const labels = serialize(shared, null, {})
      .nodes.filter((n) => n.name === 'hide')
      .map((n) => n.context);

    const named = labels.filter((l): l is string => l !== undefined);
    expect(new Set(named).size).toBe(named.length);
  });
});
