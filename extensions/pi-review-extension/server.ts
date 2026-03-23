import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import {
  type DiffType,
  type GitContext,
  type GitCommandResult,
  type ReviewGitRuntime,
  getFileContentsForDiff,
  getGitContext as getGitContextCore,
  runGitDiff as runGitDiffCore,
  validateFilePath,
} from './review-core.ts';

export interface PlanServerResult {
  port: number;
  portSource: 'env' | 'remote-default' | 'random';
  url: string;
  waitForDecision: () => Promise<{ approved: boolean; feedback?: string }>;
  stop: () => void;
}

export interface ReviewServerResult {
  port: number;
  portSource: 'env' | 'remote-default' | 'random';
  url: string;
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
  }>;
  stop: () => void;
}

const DEFAULT_REMOTE_PORT = 19432;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(content);
}

function git(command: string): string {
  try {
    return execSync(`git ${command}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function getRepoInfo(): { display: string; branch?: string } | null {
  const root = git('rev-parse --show-toplevel');
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (!root) return null;

  const repoName = root.split(/[\\/]/).filter(Boolean).pop();
  if (!repoName) return null;

  return {
    display: repoName,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
  };
}

function isRemoteSession(): boolean {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === '1' || remote?.toLowerCase() === 'true') {
    return true;
  }
  return Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

function getServerPort(): { port: number; portSource: 'env' | 'remote-default' | 'random' } {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return { port: parsed, portSource: 'env' };
    }
  }

  if (isRemoteSession()) {
    return { port: DEFAULT_REMOTE_PORT, portSource: 'remote-default' };
  }

  return { port: 0, portSource: 'random' };
}

async function listen(server: ReturnType<typeof createServer>): Promise<{
  port: number;
  portSource: 'env' | 'remote-default' | 'random';
}> {
  const result = getServerPort();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(result.port, isRemoteSession() ? '0.0.0.0' : '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Could not determine server address');
      }

      return { port: address.port, portSource: result.portSource };
    } catch (error) {
      const isAddressInUse = error instanceof Error && error.message.includes('EADDRINUSE');
      if (isAddressInUse && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to bind a port');
}

export function openBrowser(url: string): { opened: boolean; isRemote?: boolean; url?: string } {
  const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
  if (isRemoteSession() && !browser) {
    return { opened: false, isRemote: true, url };
  }

  try {
    const platform = process.platform;
    const wsl = platform === 'linux' && os.release().toLowerCase().includes('microsoft');

    let command: string;
    let args: string[];

    if (browser) {
      if (process.env.PLANNOTATOR_BROWSER && platform === 'darwin') {
        command = 'open';
        args = ['-a', browser, url];
      } else if (platform === 'win32' || wsl) {
        command = 'cmd.exe';
        args = ['/c', 'start', '', browser, url];
      } else {
        command = browser;
        args = [url];
      }
    } else if (platform === 'win32' || wsl) {
      command = 'cmd.exe';
      args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
      command = 'open';
      args = [url];
    } else {
      command = 'xdg-open';
      args = [url];
    }

    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

export async function startPlanReviewServer(options: {
  plan: string;
  htmlContent: string;
  origin?: string;
}): Promise<PlanServerResult> {
  let resolveDecision!: (result: { approved: boolean; feedback?: string }) => void;
  const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
    resolveDecision = resolve;
  });

  const repoInfo = getRepoInfo();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/api/plan' && req.method === 'GET') {
      json(res, {
        plan: options.plan,
        origin: options.origin ?? 'pi',
        repoInfo,
      });
      return;
    }

    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const body = await parseBody(req);
      resolveDecision({ approved: true, feedback: body.feedback as string | undefined });
      json(res, { ok: true });
      return;
    }

    if (url.pathname === '/api/deny' && req.method === 'POST') {
      const body = await parseBody(req);
      resolveDecision({ approved: false, feedback: (body.feedback as string) || 'Plan changes requested.' });
      json(res, { ok: true });
      return;
    }

    html(res, options.htmlContent);
  });

  const { port, portSource } = await listen(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}

const reviewRuntime: ReviewGitRuntime = {
  async runGit(args: string[], options?: { cwd?: string }): Promise<GitCommandResult> {
    const result = spawnSync('git', args, {
      cwd: options?.cwd,
      encoding: 'utf-8',
    });

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? (result.error ? 1 : 0),
    };
  },

  async readTextFile(path: string): Promise<string | null> {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  },
};

export function getGitContext(): Promise<GitContext> {
  return getGitContextCore(reviewRuntime);
}

export function runGitDiff(
  diffType: DiffType,
  defaultBranch = 'main',
): Promise<{ patch: string; label: string; error?: string }> {
  return runGitDiffCore(reviewRuntime, diffType, defaultBranch);
}

export async function startReviewServer(options: {
  rawPatch: string;
  gitRef: string;
  htmlContent: string;
  origin?: string;
  diffType?: DiffType;
  gitContext?: GitContext;
  error?: string;
}): Promise<ReviewServerResult> {
  let resolveDecision!: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
  }>((resolve) => {
    resolveDecision = resolve;
  });

  const repoInfo = getRepoInfo();
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || 'uncommitted';
  let currentError = options.error;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/api/diff' && req.method === 'GET') {
      json(res, {
        rawPatch: currentPatch,
        gitRef: currentGitRef,
        origin: options.origin ?? 'pi',
        diffType: currentDiffType,
        gitContext: options.gitContext,
        repoInfo,
        ...(currentError ? { error: currentError } : {}),
      });
      return;
    }

    if (url.pathname === '/api/diff/switch' && req.method === 'POST') {
      const body = await parseBody(req);
      const newType = body.diffType as DiffType | undefined;
      if (!newType) {
        json(res, { error: 'Missing diffType' }, 400);
        return;
      }

      const defaultBranch = options.gitContext?.defaultBranch || 'main';
      const result = await runGitDiff(newType, defaultBranch);
      currentPatch = result.patch;
      currentGitRef = result.label;
      currentDiffType = newType;
      currentError = result.error;

      json(res, {
        rawPatch: currentPatch,
        gitRef: currentGitRef,
        diffType: currentDiffType,
        ...(currentError ? { error: currentError } : {}),
      });
      return;
    }

    if (url.pathname === '/api/file-content' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        json(res, { error: 'Missing path' }, 400);
        return;
      }

      try {
        validateFilePath(filePath);
      } catch {
        json(res, { error: 'Invalid path' }, 400);
        return;
      }

      const oldPath = url.searchParams.get('oldPath') || undefined;
      if (oldPath) {
        try {
          validateFilePath(oldPath);
        } catch {
          json(res, { error: 'Invalid path' }, 400);
          return;
        }
      }

      const defaultBranch = options.gitContext?.defaultBranch || 'main';
      const result = await getFileContentsForDiff(
        reviewRuntime,
        currentDiffType,
        defaultBranch,
        filePath,
        oldPath,
      );
      json(res, result);
      return;
    }

    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const body = await parseBody(req);
      resolveDecision({
        approved: (body.approved as boolean) ?? false,
        feedback: (body.feedback as string) || '',
        annotations: (body.annotations as unknown[]) || [],
      });
      json(res, { ok: true });
      return;
    }

    html(res, options.htmlContent);
  });

  const { port, portSource } = await listen(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}
