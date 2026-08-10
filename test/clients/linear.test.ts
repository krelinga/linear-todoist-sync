import { describe, expect, it, vi } from 'vitest';
import { LinearClient } from '../../src/clients/linear.js';
import type {
  LinearSdkClient,
  RawAttachment,
  RawAttachmentPayload,
  RawConnection,
  RawIssue,
} from '../../src/clients/linear.js';
import { createMetrics } from '../../src/metrics.js';

function rawIssue(overrides: Partial<Omit<RawIssue, 'state' | 'attachments'>> & { stateType?: string }): RawIssue {
  const { stateType, ...rest } = overrides;
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the thing',
    url: 'https://linear.app/acme/issue/ENG-1',
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    state: Promise.resolve({ type: stateType ?? 'started' }),
    attachments: vi.fn().mockResolvedValue({ nodes: [] }),
    ...rest,
  };
}

function connection(nodes: RawIssue[], hasNextPage = false, endCursor: string | null = null): RawConnection<RawIssue> {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function httpError(status: number): unknown {
  return { status };
}

describe('LinearClient', () => {
  describe('getStartedIssues', () => {
    it('resolves state type and maps fields', async () => {
      const sdk: LinearSdkClient = {
        issues: vi.fn().mockResolvedValue(connection([rawIssue({})])),
        issue: vi.fn(),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      const result = await client.getStartedIssues();
      expect(result).toEqual([
        {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix the thing',
          url: 'https://linear.app/acme/issue/ENG-1',
          stateType: 'started',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ]);
    });

    it('paginates through multiple pages', async () => {
      const issuesFn = vi
        .fn()
        .mockResolvedValueOnce(connection([rawIssue({ id: 'a' })], true, 'cursor-1'))
        .mockResolvedValueOnce(connection([rawIssue({ id: 'b' })], false, null));
      const sdk: LinearSdkClient = {
        issues: issuesFn,
        issue: vi.fn(),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      const result = await client.getStartedIssues();
      expect(result.map((i) => i.id)).toEqual(['a', 'b']);
      expect(issuesFn).toHaveBeenCalledTimes(2);
      expect(issuesFn.mock.calls[1]?.[0]).toMatchObject({ after: 'cursor-1' });
    });
  });

  describe('getIssue', () => {
    it('returns the issue when found', async () => {
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn().mockResolvedValue(rawIssue({ stateType: 'completed' })),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      const result = await client.getIssue('ENG-1');
      expect(result?.stateType).toBe('completed');
    });

    it('returns null on a 4xx (not found)', async () => {
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn().mockRejectedValue(httpError(400)),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      await expect(client.getIssue('ENG-404')).resolves.toBeNull();
    });

    it('rethrows a 5xx after retries are exhausted rather than treating it as not-found', async () => {
      vi.useFakeTimers();
      try {
        const sdk: LinearSdkClient = {
          issues: vi.fn(),
          issue: vi.fn().mockRejectedValue(httpError(503)),
          createAttachment: vi.fn(),
          updateAttachment: vi.fn(),
          createComment: vi.fn(),
        };
        const client = new LinearClient(sdk);
        const assertion = expect(client.getIssue('ENG-1')).rejects.toBeDefined();
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getMarkerAttachment', () => {
    it('returns null when the issue has no marker attachment', async () => {
      const issue = rawIssue({});
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn().mockResolvedValue(issue),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      await expect(client.getMarkerAttachment('issue-1')).resolves.toBeNull();
    });

    it('returns the marker attachment when present among others', async () => {
      const other: RawAttachment = {
        id: 'att-other',
        url: 'https://github.com/acme/repo/pull/1',
        subtitle: null,
        metadata: {},
      };
      const marker: RawAttachment = {
        id: 'att-marker',
        url: 'https://todoist.com/showProject?id=123',
        subtitle: '3 tasks outstanding',
        metadata: { syncApp: 'linear-todoist-sync', schemaVersion: 1 },
      };
      const issue = rawIssue({
        attachments: vi.fn().mockResolvedValue({ nodes: [other, marker] }),
      });
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn().mockResolvedValue(issue),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      const result = await client.getMarkerAttachment('issue-1');
      expect(result).toEqual({
        id: 'att-marker',
        url: 'https://todoist.com/showProject?id=123',
        subtitle: '3 tasks outstanding',
        metadata: { syncApp: 'linear-todoist-sync', schemaVersion: 1 },
      });
    });

    it('returns null when the issue itself no longer exists', async () => {
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn().mockRejectedValue(httpError(404)),
        createAttachment: vi.fn(),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      await expect(client.getMarkerAttachment('issue-1')).resolves.toBeNull();
    });
  });

  describe('createAttachment', () => {
    it('forwards fields and returns the created attachment', async () => {
      const attachment: RawAttachment = {
        id: 'att-1',
        url: 'https://todoist.com/showProject?id=123',
        subtitle: null,
        metadata: { syncApp: 'linear-todoist-sync' },
      };
      const payload: RawAttachmentPayload = { attachment: Promise.resolve(attachment) };
      const createAttachment = vi.fn().mockResolvedValue(payload);
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn(),
        createAttachment,
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      const result = await client.createAttachment({
        issueId: 'issue-1',
        title: '[ENG-1] Fix the thing',
        url: 'https://todoist.com/showProject?id=123',
        iconUrl: 'https://example.com/icon.png',
        metadata: { syncApp: 'linear-todoist-sync' },
      });
      expect(createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: 'issue-1', url: 'https://todoist.com/showProject?id=123' }),
      );
      expect(result.id).toBe('att-1');
    });

    it('throws if the mutation reports no attachment', async () => {
      const payload: RawAttachmentPayload = { attachment: undefined };
      const sdk: LinearSdkClient = {
        issues: vi.fn(),
        issue: vi.fn(),
        createAttachment: vi.fn().mockResolvedValue(payload),
        updateAttachment: vi.fn(),
        createComment: vi.fn(),
      };
      const client = new LinearClient(sdk);
      await expect(
        client.createAttachment({
          issueId: 'issue-1',
          title: 'x',
          url: 'https://example.com',
          iconUrl: 'https://example.com/icon.png',
          metadata: {},
        }),
      ).rejects.toThrow();
    });
  });

  it('createComment forwards issueId and body', async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const sdk: LinearSdkClient = {
      issues: vi.fn(),
      issue: vi.fn(),
      createAttachment: vi.fn(),
      updateAttachment: vi.fn(),
      createComment,
    };
    const client = new LinearClient(sdk);
    await client.createComment('issue-1', 'hello');
    expect(createComment).toHaveBeenCalledWith({ issueId: 'issue-1', body: 'hello' });
  });

  it('records API request metrics on success and failure', async () => {
    const metrics = createMetrics();
    const sdk: LinearSdkClient = {
      issues: vi.fn(),
      issue: vi
        .fn()
        .mockResolvedValueOnce(rawIssue({}))
        .mockRejectedValueOnce(httpError(400)),
      createAttachment: vi.fn(),
      updateAttachment: vi.fn(),
      createComment: vi.fn(),
    };
    const client = new LinearClient(sdk, metrics);
    await client.getIssue('ENG-1');
    await client.getIssue('ENG-2');
    const successCount = await metrics.apiRequestsTotal.get();
    expect(successCount.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { service: 'linear', result: 'success' }, value: 1 }),
        expect.objectContaining({ labels: { service: 'linear', result: 'error' }, value: 1 }),
      ]),
    );
  });
});
