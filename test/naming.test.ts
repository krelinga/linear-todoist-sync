import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_SCHEMA_VERSION,
  buildArchivedSubtitle,
  buildAttachmentMetadata,
  buildOutstandingSubtitle,
  buildProjectDescription,
  buildProjectName,
  getLastDigestAt,
  isLostProject,
  isMarkerAttachment,
  markAsLost,
  parseLinkedIssueUrl,
  SYNC_APP_MARKER,
} from '../src/naming.js';

describe('buildProjectName', () => {
  it('prefixes the identifier', () => {
    expect(buildProjectName('ENG-123', 'Fix the flaky login test')).toBe(
      '[ENG-123] Fix the flaky login test',
    );
  });
});

describe('buildProjectDescription / parseLinkedIssueUrl', () => {
  it('round-trips the issue URL', () => {
    const url = 'https://linear.app/acme/issue/ENG-123';
    const description = buildProjectDescription(url);
    expect(description).toBe(`Linked Linear issue: ${url}`);
    expect(parseLinkedIssueUrl(description)).toBe(url);
  });

  it('returns null for a description with no marker', () => {
    expect(parseLinkedIssueUrl('Just a normal project description')).toBeNull();
  });

  it('returns null when the marker is present but the url is empty', () => {
    expect(parseLinkedIssueUrl('Linked Linear issue:    ')).toBeNull();
  });

  it('unwraps a Todoist-rewritten markdown link', () => {
    const url = 'https://linear.app/acme/issue/ENG-123';
    expect(parseLinkedIssueUrl(`Linked Linear issue: [Linear](${url})`)).toBe(url);
  });
});

describe('isLostProject / markAsLost', () => {
  it('prefixes an unprefixed name', () => {
    expect(markAsLost('[ENG-123] Fix the flaky login test')).toBe(
      '[LOST] [ENG-123] Fix the flaky login test',
    );
  });

  it('is idempotent on an already-prefixed name', () => {
    const lost = markAsLost('[ENG-123] Fix the flaky login test');
    expect(markAsLost(lost)).toBe(lost);
  });

  it('isLostProject detects the prefix', () => {
    expect(isLostProject('[LOST] [ENG-123] Fix the flaky login test')).toBe(true);
    expect(isLostProject('[ENG-123] Fix the flaky login test')).toBe(false);
  });
});

describe('buildAttachmentMetadata / isMarkerAttachment / getLastDigestAt', () => {
  it('builds metadata recognized as a marker attachment', () => {
    const metadata = buildAttachmentMetadata();
    expect(metadata).toEqual({ syncApp: SYNC_APP_MARKER, schemaVersion: ATTACHMENT_SCHEMA_VERSION });
    expect(isMarkerAttachment(metadata)).toBe(true);
  });

  it('includes lastDigestAt only when provided', () => {
    const withDigest = buildAttachmentMetadata('2026-08-01T00:00:00.000Z');
    expect(getLastDigestAt(withDigest)).toBe('2026-08-01T00:00:00.000Z');

    const withoutDigest = buildAttachmentMetadata();
    expect(getLastDigestAt(withoutDigest)).toBeNull();
    expect('lastDigestAt' in withoutDigest).toBe(false);
  });

  it('does not recognize metadata from another integration', () => {
    expect(isMarkerAttachment({ syncApp: 'some-other-app' })).toBe(false);
    expect(isMarkerAttachment({})).toBe(false);
  });

  it('getLastDigestAt returns null for a non-string value', () => {
    expect(getLastDigestAt({ lastDigestAt: 12345 })).toBeNull();
  });
});

describe('buildOutstandingSubtitle', () => {
  it.each([
    [0, '0 tasks outstanding'],
    [1, '1 task outstanding'],
    [7, '7 tasks outstanding'],
  ])('formats %i as %s', (count, expected) => {
    expect(buildOutstandingSubtitle(count)).toBe(expected);
  });
});

describe('buildArchivedSubtitle', () => {
  it.each([
    [0, 'Archived — 0 tasks were outstanding'],
    [1, 'Archived — 1 task was outstanding'],
    [3, 'Archived — 3 tasks were outstanding'],
  ])('formats %i as %s', (count, expected) => {
    expect(buildArchivedSubtitle(count)).toBe(expected);
  });
});
