/**
 * Integration tests for the Express app routes.
 * Mocks the github service layer so we never need @octokit/app resolved.
 */

const mockVerifyAndReceive = jest.fn();
const mockWebhooksOn = jest.fn();
const mockWebhooksOnError = jest.fn();

// Mock the github service before any imports touch it
jest.mock('../src/services/github', () => ({
  getGithubApp: jest.fn().mockReturnValue({
    webhooks: {
      on: mockWebhooksOn,
      onError: mockWebhooksOnError,
      verifyAndReceive: mockVerifyAndReceive,
    },
  }),
  getInstallationOctokit: jest.fn(),
  getInstallationToken: jest.fn(),
  getOpenPRsWithConflicts: jest.fn(),
  getPRByNumber: jest.fn(),
  postComment: jest.fn(),
  createCommitStatus: jest.fn(),
  addCommentReaction: jest.fn(),
  getCollaboratorPermission: jest.fn(),
}));

// Keep prProcessor from running real logic
jest.mock('../src/services/prProcessor', () => ({
  processMergedPR: jest.fn().mockResolvedValue(undefined),
  processManualResolve: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import { createApp } from '../src/app';

describe('Express server', () => {
  const app = createApp();

  beforeEach(() => {
    mockVerifyAndReceive.mockReset();
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /unknown', () => {
    it('returns 404', async () => {
      const res = await request(app).get('/not-a-real-route');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /webhook', () => {
    const validHeaders = {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': 'sha256=validsig',
      'x-github-delivery': 'delivery-abc-123',
      'content-type': 'application/json',
    };

    it('returns 400 when github headers are missing', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ action: 'closed' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/missing/i);
    });

    it('returns 401 when signature verification fails', async () => {
      mockVerifyAndReceive.mockRejectedValueOnce(new Error('Signature mismatch'));

      const res = await request(app)
        .post('/webhook')
        .set(validHeaders)
        .send(JSON.stringify({ action: 'closed' }));

      expect(res.status).toBe(401);
    });

    it('returns 200 and calls verifyAndReceive with correct params', async () => {
      mockVerifyAndReceive.mockResolvedValueOnce(undefined);

      const body = { action: 'closed' };
      const res = await request(app)
        .post('/webhook')
        .set(validHeaders)
        .send(JSON.stringify(body));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockVerifyAndReceive).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'delivery-abc-123',
          name: 'pull_request',
          signature: 'sha256=validsig',
        })
      );
    });

    it('passes the EXACT raw bytes to signature verification (no JSON round-trip)', async () => {
      mockVerifyAndReceive.mockResolvedValueOnce(undefined);

      // é as an escape sequence and 1.0 as a float both change bytes if
      // the body is parsed and re-stringified — the HMAC would then fail.
      const rawBody = '{"action": "closed",  "title": "caf\\u00e9", "weight": 1.0}';
      await request(app).post('/webhook').set(validHeaders).send(rawBody);

      expect(mockVerifyAndReceive).toHaveBeenCalledWith(
        expect.objectContaining({ payload: rawBody })
      );
    });
  });

  describe('observability endpoints', () => {
    it('GET /metrics returns Prometheus text format', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('# TYPE aam_runs_total counter');
      expect(res.text).toContain('aam_uptime_seconds');
    });

    it('GET /api/stats returns aggregate stats with queue info', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.runs).toBeDefined();
      expect(res.body.files).toBeDefined();
      expect(res.body.usage).toBeDefined();
      expect(res.body.queue.mode).toBe('in-process');
    });

    it('GET /api/runs returns the run list', async () => {
      const res = await request(app).get('/api/runs?limit=5');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.runs)).toBe(true);
    });

    it('GET /dashboard serves the HTML dashboard', async () => {
      const res = await request(app).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('ai-auto-merge');
    });

    it('GET /health includes version and uptime', async () => {
      const res = await request(app).get('/health');
      expect(res.body.version).toBeTruthy();
      expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(res.body.model).toBeTruthy();
    });
  });
});
