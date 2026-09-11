import { describe, expect, it } from 'vitest';
import { ContextualError, errorFields, errorMessage, withContext } from '../src/errors.js';

describe('ContextualError', () => {
  it('renders its context inline after the description', () => {
    const err = new ContextualError('Failed to look up an issue', { issue: 'ENG-42' });
    expect(err.message).toBe('Failed to look up an issue (issue=ENG-42)');
  });

  it('appends the underlying message so the cause is still readable', () => {
    const err = new ContextualError(
      'Failed to look up an issue',
      { issue: 'ENG-42' },
      new Error('Entity not found: Issue'),
    );
    expect(err.message).toBe('Failed to look up an issue (issue=ENG-42): Entity not found: Issue');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('omits empty context rather than rendering an empty parenthetical', () => {
    const err = new ContextualError('Something broke', { issue: undefined, project: null });
    expect(err.message).toBe('Something broke');
  });

  it('quotes non-string values so a number reads differently from a numeric string', () => {
    const err = new ContextualError('Broke', { httpStatus: 400, cursor: '400' });
    expect(err.message).toBe('Broke (httpStatus=400, cursor=400)');
  });
});

describe('errorFields', () => {
  it('flattens the whole cause chain into log fields, outermost winning', () => {
    const inner = new ContextualError(
      'Linear API request failed',
      { system: 'linear', operation: 'issue', phase: 'api' },
      new Error('Entity not found: Issue'),
    );
    const outer = new ContextualError(
      'Failed to look up the Linear issue linked from a Todoist project',
      { todoistProjectId: 'proj-1', linkedIssue: 'ENG-42', phase: 'discover' },
      inner,
    );

    expect(errorFields(outer)).toEqual({
      system: 'linear',
      operation: 'issue',
      todoistProjectId: 'proj-1',
      linkedIssue: 'ENG-42',
      phase: 'discover',
      error: outer.message,
    });
  });

  it('still produces a message for a plain error carrying no context', () => {
    expect(errorFields(new Error('boom'))).toEqual({ error: 'boom' });
  });

  it('handles a non-Error throw', () => {
    expect(errorFields('boom')).toEqual({ error: 'boom' });
    expect(errorMessage(42)).toBe('42');
  });

  it('terminates on a self-referential cause chain', () => {
    // Logging must never be the thing that hangs the process.
    const err = new ContextualError('Broke', { issue: 'ENG-1' });
    Object.defineProperty(err, 'cause', { value: err });
    expect(errorFields(err)).toEqual({ issue: 'ENG-1', error: 'Broke (issue=ENG-1)' });
  });
});

describe('withContext', () => {
  it('passes a success through untouched', async () => {
    await expect(withContext('nope', { issue: 'ENG-1' }, async () => 'ok')).resolves.toBe('ok');
  });

  it('wraps a failure with what was being attempted', async () => {
    await expect(
      withContext('Failed to fetch', { issue: 'ENG-1' }, () =>
        Promise.reject(new Error('network down')),
      ),
    ).rejects.toThrow('Failed to fetch (issue=ENG-1): network down');
  });
});
