import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { planDenyFeedback } from './feedback-templates.ts';
import {
  getGitContext,
  openBrowser,
  runGitDiff,
  startPlanReviewServer,
  startReviewServer,
  type PlanServerResult,
  type ReviewServerResult,
} from './server.ts';

type ReviewLoopPhase = 'idle' | 'plan-review';

interface DecisionServer<T> {
  url: string;
  stop: () => void;
  waitForDecision: () => Promise<T>;
}

interface DiffReviewAnnotation {
  scope?: 'line' | 'file';
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  text?: string;
  suggestedCode?: string;
}

const PLAN_REQUEST_PATTERNS = [
  /\bmake\s+(?:me\s+)?a\s+plan\b/i,
  /\b(?:draft|write|create|prepare|propose)\s+(?:me\s+)?(?:an?\s+)?(?:implementation\s+)?plan\b/i,
  /\b(?:come up with|put together)\s+(?:an?\s+)?plan\b/i,
  /\blet'?s\s+plan\b/i,
  /\bplan\s+(?:this|it|that|the work|the change|the migration|the refactor|the feature)\b/i,
  /\bwhat'?s\s+the\s+plan\b/i,
  /\b(?:before|first),?\s+(?:please\s+)?(?:make|draft|write|create)\s+(?:an?\s+)?plan\b/i,
];

const __dirname = dirname(fileURLToPath(import.meta.url));
let planReviewHtmlContent = '';
let diffReviewHtmlContent = '';
try {
  planReviewHtmlContent = readFileSync(resolve(__dirname, 'plan-review.html'), 'utf-8');
} catch {
  // HTML not built yet.
}
try {
  diffReviewHtmlContent = readFileSync(resolve(__dirname, 'diff-review.html'), 'utf-8');
} catch {
  // HTML not built yet.
}

function getStartupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

function getMessageText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is TextContent => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function getLastUserMessageText(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; message?: AgentMessage };
    if (entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role !== 'user') continue;
    const text = getMessageText(entry.message).trim();
    if (text) return text;
  }
  return null;
}

function looksLikePlanRequest(text: string | null): boolean {
  if (!text) return false;
  return PLAN_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function isDiffReviewAnnotation(value: unknown): value is DiffReviewAnnotation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as DiffReviewAnnotation;
  return typeof candidate.filePath === 'string';
}

function formatDiffReviewAnnotationForAgent(annotation: DiffReviewAnnotation): string {
  const scope = annotation.scope ?? 'line';
  const text = annotation.text?.trim();
  const suggestedCode = annotation.suggestedCode?.trim();

  let location = annotation.filePath || 'unknown-file';
  if (scope === 'file') {
    location += ':file';
  } else if (typeof annotation.lineStart === 'number') {
    const end = typeof annotation.lineEnd === 'number' ? annotation.lineEnd : annotation.lineStart;
    location += annotation.lineStart === end ? `:${annotation.lineStart}` : `:${annotation.lineStart}-${end}`;
    if (annotation.side === 'old' || annotation.side === 'new') {
      location += `(${annotation.side})`;
    }
  }

  const parts = [location];
  if (text) {
    parts.push(text);
  } else if (suggestedCode) {
    parts.push('Suggested change attached.');
  }

  let output = parts.join(' ');
  if (suggestedCode) {
    output += `\nSuggested code:\n\`\`\`\n${suggestedCode}\n\`\`\``;
  }

  return output;
}

function formatDiffReviewFeedbackForAgent(feedback: string, annotations: unknown[]): string {
  const formattedAnnotations = annotations
    .filter(isDiffReviewAnnotation)
    .map(formatDiffReviewAnnotationForAgent)
    .filter((entry) => entry.trim().length > 0);

  if (formattedAnnotations.length === 0) {
    return `${feedback.trim() || 'Diff review feedback received.'}\n\nPlease address this diff review feedback.`;
  }

  return `${formattedAnnotations.join('\n\n')}\n\nPlease address this diff review feedback.`;
}

function buildPlanReviewKickoffMessage(planFilePath?: string): string {
  if (planFilePath) {
    return `Start a plan review for the existing plan file ${planFilePath}. Do not draft a new plan unless review feedback requires changes. Read the file and call submit_plan_review with filePath set to ${planFilePath}. Do not implement the plan.`;
  }

  return 'Start a plan review. Draft a plan only, create a new task-specific plan file, then call submit_plan_review with filePath set to that file. Do not implement the plan.';
}

async function runBrowserReview<T>(server: DecisionServer<T>, ctx: ExtensionContext): Promise<T> {
  const browserResult = openBrowser(server.url);
  if (browserResult.isRemote) {
    ctx.ui.notify(`Remote session. Open manually: ${browserResult.url}`, 'info');
  }

  const result = await server.waitForDecision();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  server.stop();
  return result;
}

export default function reviewExtension(pi: ExtensionAPI): void {
  let phase: ReviewLoopPhase = 'idle';
  let defaultPlanFilePath = '';
  let planFilePath = '';

  const persistState = () => {
    pi.appendEntry('plan-review', { phase, planFilePath });
  };

  const getPlanFilePath = (override?: string) => {
    const candidate = override?.trim() || planFilePath.trim() || defaultPlanFilePath.trim();
    return candidate.length > 0 ? candidate : undefined;
  };

  const enterPlanReview = (ctx: ExtensionContext) => {
    phase = 'plan-review';
    persistState();
    const configuredPath = getPlanFilePath();
    ctx.ui.notify(
      configuredPath
        ? `Plan review started. Draft the plan in ${configuredPath}, then submit it for review.`
        : 'Plan review started. Create a task-specific plan file, then submit it for review.',
    );
  };

  const exitPlanReview = (ctx: ExtensionContext) => {
    phase = 'idle';
    planFilePath = '';
    persistState();
    ctx.ui.notify('Plan review stopped.');
  };

  const resolvePlanPath = (cwd: string, override?: string) => {
    const targetPath = getPlanFilePath(override);
    return targetPath ? resolve(cwd, targetPath) : undefined;
  };

  const maybeAutoEnterPlanReview = (ctx: ExtensionContext): boolean => {
    if (phase === 'plan-review') return true;
    if (!looksLikePlanRequest(getLastUserMessageText(ctx))) return false;

    phase = 'plan-review';
    persistState();
    if (ctx.hasUI) {
      const configuredPath = getPlanFilePath();
      ctx.ui.notify(
        configuredPath
          ? `Detected a planning request. Starting plan review using ${configuredPath}.`
          : 'Detected a planning request. Starting plan review and expecting a new task-specific plan file.',
        'info',
      );
    }
    return true;
  };

  pi.registerFlag('plan-review', {
    description: 'Start in the plan review loop',
    type: 'boolean',
    default: false,
  });

  pi.registerFlag('plan-file', {
    description: 'Optional plan file path used by the plan review loop',
    type: 'string',
    default: '',
  });

  pi.registerFlag('auto-plan-review', {
    description: 'Automatically enter the plan review loop when the user asks for a plan',
    type: 'boolean',
    default: true,
  });

  pi.registerCommand('plan-review', {
    description: 'Start or stop the plan review loop',
    handler: async (args, ctx) => {
      const nextPath = args?.trim();
      const wasActive = phase === 'plan-review';

      if (wasActive) {
        if (nextPath) {
          planFilePath = nextPath;
          persistState();
          ctx.ui.notify(`Plan review is already active. Plan file changed to: ${planFilePath}`);
          return;
        }
        exitPlanReview(ctx);
        return;
      }

      if (nextPath) {
        planFilePath = nextPath;
      }

      enterPlanReview(ctx);

      if (ctx.isIdle()) {
        pi.sendUserMessage(buildPlanReviewKickoffMessage(getPlanFilePath()));
      }
    },
  });

  pi.registerCommand('diff-review', {
    description: 'Open the current git diff in the browser review UI',
    handler: async (_args, ctx) => {
      if (!diffReviewHtmlContent) {
        ctx.ui.notify("Diff review UI not available. Run 'bun run build:pi-review-extension' first.", 'error');
        return;
      }

      let server: ReviewServerResult;
      try {
        const gitContext = await getGitContext();
        const { patch: rawPatch, label: gitRef, error } = await runGitDiff('uncommitted', gitContext.defaultBranch);

        server = await startReviewServer({
          rawPatch,
          gitRef,
          error,
          origin: 'pi',
          diffType: 'uncommitted',
          gitContext,
          htmlContent: diffReviewHtmlContent,
        });
      } catch (err) {
        ctx.ui.notify(`Failed to start diff review UI: ${getStartupErrorMessage(err)}`, 'error');
        return;
      }

      const result = await runBrowserReview(server, ctx);
      if (result.feedback) {
        if (result.approved) {
          pi.sendUserMessage('# Diff Review\n\nApproved — no changes requested.');
        } else {
          pi.sendUserMessage(formatDiffReviewFeedbackForAgent(result.feedback, result.annotations));
        }
      } else {
        ctx.ui.notify('Diff review closed.', 'info');
      }
    },
  });

  pi.registerTool({
    name: 'submit_plan_review',
    label: 'Submit Plan Review',
    description:
      'Submit the current plan for review. Call this after drafting or revising the plan. ' +
      'If the user requests changes, revise the plan and call this tool again. ' +
      'If the user approves the plan, stop and wait for the next instruction.',
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: 'Brief summary of the plan' })),
      filePath: Type.Optional(Type.String({ description: 'Optional path to the plan file' })),
      plan: Type.Optional(Type.String({ description: 'Optional inline plan markdown to review' })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (phase !== 'plan-review' && !(pi.getFlag('auto-plan-review') === true && maybeAutoEnterPlanReview(ctx))) {
        return {
          content: [{ type: 'text', text: 'Error: Plan review is not active. Use /plan-review first.' }],
          details: { approved: false },
        };
      }

      const inlinePlan = typeof params.plan === 'string' ? params.plan : undefined;
      const explicitFilePath = typeof params.filePath === 'string' && params.filePath.trim() ? params.filePath.trim() : undefined;

      if (explicitFilePath) {
        planFilePath = explicitFilePath;
        persistState();
      }

      let planContent = inlinePlan;
      if (!planContent) {
        const fullPath = resolvePlanPath(ctx.cwd, explicitFilePath);
        if (!fullPath) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: No plan file was provided. Create a task-specific plan file and call submit_plan_review with filePath, or pass the plan inline with plan.',
              },
            ],
            details: { approved: false },
          };
        }
        try {
          planContent = readFileSync(fullPath, 'utf-8');
        } catch {
          const targetPath = explicitFilePath || getPlanFilePath();
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${targetPath || 'The provided plan file'} does not exist. Write the plan first, then call submit_plan_review again.`,
              },
            ],
            details: { approved: false },
          };
        }
      }

      if (!planContent || planContent.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: The plan is empty. Draft the plan first, then submit it again.' }],
          details: { approved: false },
        };
      }

      if (!ctx.hasUI) {
        phase = 'idle';
        planFilePath = '';
        persistState();
        return {
          content: [
            {
              type: 'text',
              text: 'Plan auto-approved (non-interactive mode). Do not implement the plan. Stop here and wait for the next instruction.',
            },
          ],
          details: { approved: true },
        };
      }

      if (!planReviewHtmlContent) {
        return {
          content: [
            {
              type: 'text',
              text: "Error: Plan review UI not available. Run 'bun run build:pi-review-extension' first.",
            },
          ],
          details: { approved: false },
        };
      }

      let server: PlanServerResult;
      try {
        server = await startPlanReviewServer({
          plan: planContent,
          htmlContent: planReviewHtmlContent,
          origin: 'pi',
        });
      } catch (err) {
        const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
        ctx.ui.notify(message, 'error');
        return {
          content: [{ type: 'text', text: message }],
          details: { approved: false },
        };
      }

      const result = await runBrowserReview(server, ctx);
      if (result.approved) {
        phase = 'idle';
        planFilePath = '';
        persistState();

        if (result.feedback) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Plan approved with notes. Do not implement the plan. Stop here and wait for the next instruction.\n\n' +
                  '## Notes\n\n' +
                  result.feedback,
              },
            ],
            details: { approved: true, feedback: result.feedback },
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: 'Plan approved. Do not implement the plan. Stop here and wait for the next instruction.',
            },
          ],
          details: { approved: true },
        };
      }

      const feedbackText = result.feedback || 'Plan changes requested.';
      return {
        content: [
          {
            type: 'text',
            text: planDenyFeedback(
              feedbackText,
              'submit_plan_review',
              inlinePlan ? undefined : { planFilePath: explicitFilePath || getPlanFilePath() },
            ),
          },
        ],
        details: { approved: false, feedback: feedbackText },
      };
    },
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (phase !== 'plan-review' && !(pi.getFlag('auto-plan-review') === true && maybeAutoEnterPlanReview(ctx))) {
      return;
    }

    return {
      message: {
        customType: 'plan-review-context',
        content: getPlanFilePath()
          ? `[PLAN REVIEW LOOP]\nYou are reviewing an existing plan file only. Do not implement the plan. Read the configured plan file and call submit_plan_review with filePath set to that file.\n\nIf the user requests changes, revise the same plan file and call submit_plan_review again with the same filePath. Repeat until the plan is approved. Once the plan is approved, stop and wait for the user's next instruction.`
          : `[PLAN REVIEW LOOP]\nYou are drafting a plan only. Do not implement the plan. Explore the codebase as needed, create a new task-specific plan file, write the plan there, and call submit_plan_review with filePath set to that file.\n\nIf the user requests changes, revise the same plan file and call submit_plan_review again with the same filePath. Repeat until the plan is approved. Once the plan is approved, stop and wait for the user's next instruction.\n\nKeep the plan concise and execution-ready. Include:\n- Context\n- Approach\n- Files to modify\n- Reuse opportunities\n- Steps\n- Verification`,
        display: false,
      },
    };
  });

  pi.on('context', async (event) => {
    if (phase !== 'idle') return;

    return {
      messages: event.messages.filter((message) => {
        const msg = message as AgentMessage & { customType?: string };
        if (msg.customType === 'plan-review-context') return false;
        if (msg.role !== 'user') return true;

        const content = msg.content;
        if (typeof content === 'string') {
          return !content.includes('[PLAN REVIEW LOOP]');
        }
        if (Array.isArray(content)) {
          return !content.some(
            (block) => block.type === 'text' && (block as TextContent).text?.includes('[PLAN REVIEW LOOP]'),
          );
        }
        return true;
      }),
    };
  });

  pi.on('session_start', async (_event, ctx) => {
    const flagPlanFile = pi.getFlag('plan-file') as string;
    if (flagPlanFile) {
      defaultPlanFilePath = flagPlanFile;
    }

    if (pi.getFlag('plan-review') === true) {
      phase = 'plan-review';
    }

    const entries = ctx.sessionManager.getEntries();
    const stateEntry = entries
      .filter((entry: { type: string; customType?: string }) => entry.type === 'custom' && entry.customType === 'plan-review')
      .pop() as { data?: { phase?: ReviewLoopPhase; planFilePath?: string } } | undefined;

    if (stateEntry?.data) {
      phase = stateEntry.data.phase ?? phase;
      planFilePath = stateEntry.data.planFilePath ?? planFilePath;
    }
  });
}
