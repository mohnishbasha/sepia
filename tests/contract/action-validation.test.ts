/**
 * AC-A5 — model output is validated at the boundary, not cast.
 *
 * parseAction previously validated only the `action` name and then cast the
 * rest of the object, so a malformed payload from the model reached the engine
 * and failed there (or worse, acted with undefined fields).
 */

import { describe, it, expect } from 'vitest';
import { parseAction, parseTerminalAction, isValidActionName } from '../../actions/index.js';

describe('AC-A5 — required fields are enforced', () => {
  it('rejects click with no handle', () => {
    expect(() => parseAction({ action: 'click' })).toThrow(/click requires handle/i);
  });

  it('rejects type with no text', () => {
    expect(() => parseAction({ action: 'type', handle: 'e1' })).toThrow(/type requires text/i);
  });

  it('rejects select with no option', () => {
    expect(() => parseAction({ action: 'select', handle: 'e1' })).toThrow(
      /select requires option/i,
    );
  });

  it('rejects press with no key', () => {
    expect(() => parseAction({ action: 'press' })).toThrow(/press requires key/i);
  });

  it('rejects open with no url', () => {
    expect(() => parseAction({ action: 'open' })).toThrow(/open requires url/i);
  });

  it('rejects wait with no condition', () => {
    expect(() => parseAction({ action: 'wait' })).toThrow(/wait requires condition/i);
  });

  it('rejects tabs.switch with no tabId', () => {
    expect(() => parseAction({ action: 'tabs.switch' })).toThrow(/tabs\.switch requires tabId/i);
  });
});

describe('AC-A5 — field types are enforced', () => {
  it('rejects a non-string handle', () => {
    expect(() => parseAction({ action: 'click', handle: 12 })).toThrow(/handle/i);
  });

  it('rejects a non-string text', () => {
    expect(() => parseAction({ action: 'type', handle: 'e1', text: { a: 1 } })).toThrow(/text/i);
  });

  it('rejects a non-boolean submit', () => {
    expect(() => parseAction({ action: 'type', handle: 'e1', text: 'hi', submit: 'yes' })).toThrow(
      /submit/i,
    );
  });

  it('rejects a non-number scrollDistance', () => {
    expect(() => parseAction({ action: 'scroll', scrollDistance: 'lots' })).toThrow(
      /scrollDistance/i,
    );
  });

  it('rejects an unknown verbosity', () => {
    expect(() => parseAction({ action: 'observe', verbosity: 'loud' })).toThrow(/verbosity/i);
  });
});

describe('AC-A5 — valid actions still parse', () => {
  it('parses click', () => {
    expect(parseAction({ action: 'click', handle: 'e12' })).toMatchObject({
      action: 'click',
      handle: 'e12',
    });
  });

  it('parses type with submit', () => {
    expect(parseAction({ action: 'type', handle: 'e1', text: 'hi', submit: true })).toMatchObject({
      action: 'type',
      text: 'hi',
      submit: true,
    });
  });

  it('parses scroll with defaults omitted', () => {
    expect(parseAction({ action: 'scroll' })).toMatchObject({ action: 'scroll' });
  });

  it('parses observe with a valid verbosity', () => {
    expect(parseAction({ action: 'observe', verbosity: 'minimal' })).toMatchObject({
      verbosity: 'minimal',
    });
  });

  it('parses check without an explicit checked flag', () => {
    expect(parseAction({ action: 'check', handle: 'e3' })).toMatchObject({ action: 'check' });
  });
});

/**
 * AC-A9 — terminal actions are validated at the boundary and never dispatched.
 *
 * `done` and `abort` end the run; they are recognised by the agent loop rather
 * than routed through `parseAction`/`dispatch`. `abort` is the typed way for
 * the model to report "I cannot do this" (issue #5), so it must be validated
 * like any other action rather than cast.
 */
describe('AC-A9 — terminal actions are validated, not dispatched', () => {
  it('parses abort with a reason', () => {
    expect(parseTerminalAction({ action: 'abort', reason: 'paywalled' })).toMatchObject({
      action: 'abort',
      reason: 'paywalled',
    });
  });

  it('parses done with a summary', () => {
    expect(parseTerminalAction({ action: 'done', summary: 'done' })).toMatchObject({
      action: 'done',
      summary: 'done',
    });
  });

  it('accepts a terminal action with no payload', () => {
    expect(parseTerminalAction({ action: 'abort' })).toMatchObject({ action: 'abort' });
  });

  it('rejects a non-string reason', () => {
    expect(() => parseTerminalAction({ action: 'abort', reason: 42 })).toThrow(/reason/i);
  });

  it('rejects a non-string summary', () => {
    expect(() => parseTerminalAction({ action: 'done', summary: 42 })).toThrow(/summary/i);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseTerminalAction('abort')).toThrow(/object/i);
  });

  it('rejects a dispatchable action passed as a terminal action', () => {
    expect(() => parseTerminalAction({ action: 'click', handle: 'e1' })).toThrow(/invalid/i);
  });

  it('keeps done and abort out of the dispatchable action enum', () => {
    // Terminal actions are handled by the agent loop, never dispatched to the
    // engine, so they must not pass the dispatchable-name check.
    expect(isValidActionName('done')).toBe(false);
    expect(isValidActionName('abort')).toBe(false);
  });
});
