import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import type { CodeAnnotation, CodeAnnotationType, SelectedLineRange } from '@plannotator/ui/types';
import type { GitContext } from '@plannotator/shared/types';
import { DiffViewer } from '../../../packages/review-editor/components/DiffViewer';
import { FileTree } from '../../../packages/review-editor/components/FileTree';
import { ReviewPanel } from '../../../packages/review-editor/components/ReviewPanel';
import { exportReviewFeedback } from '../../../packages/review-editor/utils/exportFeedback';

interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

interface DiffData {
  files: DiffFile[];
  rawPatch: string;
  gitRef: string;
  origin?: 'pi';
  diffType?: string;
  gitContext?: GitContext;
}

type SubmissionState = 'approved' | 'feedback' | null;

function parseDiffToFiles(rawPatch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileChunks = rawPatch.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+) b\/(.+)/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    files.push({
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      patch: 'diff --git ' + chunk,
      additions,
      deletions,
    });
  }

  return files;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function SubmissionOverlay({ submitted }: { submitted: SubmissionState }) {
  if (!submitted) return null;

  const approved = submitted === 'approved';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background px-6">
      <div className="max-w-md space-y-5 text-center">
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${
            approved ? 'bg-success/20 text-success' : 'bg-accent/20 text-accent'
          }`}
        >
          {approved ? (
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-semibold text-foreground">
            {approved ? 'Diff approved' : 'Feedback sent'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {approved
              ? 'No changes were requested. You can close this tab now.'
              : 'The review feedback has been sent to the agent.'}
          </p>
        </div>
      </div>
    </div>
  );
}

const App: React.FC = () => {
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [annotations, setAnnotations] = useState<CodeAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [diffType, setDiffType] = useState<string>('uncommitted');
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmissionState>(null);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Diff Review` : 'Diff Review';
  }, [repoInfo]);

  useEffect(() => {
    fetch('/api/diff')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load diff');
        return res.json();
      })
      .then((data: {
        rawPatch: string;
        gitRef: string;
        origin?: 'pi';
        diffType?: string;
        gitContext?: GitContext;
        repoInfo?: { display: string; branch?: string };
        error?: string;
      }) => {
        const parsedFiles = parseDiffToFiles(data.rawPatch);
        setDiffData({
          files: parsedFiles,
          rawPatch: data.rawPatch,
          gitRef: data.gitRef,
          origin: data.origin,
          diffType: data.diffType,
          gitContext: data.gitContext,
        });
        setFiles(parsedFiles);
        if (data.diffType) setDiffType(data.diffType);
        if (data.gitContext) setGitContext(data.gitContext);
        if (data.repoInfo) setRepoInfo(data.repoInfo);
        if (data.error) setDiffError(data.error);
      })
      .catch(() => {
        setDiffError('Could not load the diff.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const activeFile = files[activeFileIndex];

  const handleLineSelection = useCallback((range: SelectedLineRange | null) => {
    setPendingSelection(range);
  }, []);

  const handleAddAnnotation = useCallback((
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
  ) => {
    if (!pendingSelection || !files[activeFileIndex]) return;

    const lineStart = Math.min(pendingSelection.start, pendingSelection.end);
    const lineEnd = Math.max(pendingSelection.start, pendingSelection.end);

    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type,
      scope: 'line',
      filePath: files[activeFileIndex].path,
      lineStart,
      lineEnd,
      side: pendingSelection.side === 'additions' ? 'new' : 'old',
      text,
      suggestedCode,
      originalCode,
      createdAt: Date.now(),
    };

    setAnnotations((prev) => [...prev, newAnnotation]);
    setPendingSelection(null);
  }, [pendingSelection, files, activeFileIndex]);

  const handleAddFileComment = useCallback((text: string) => {
    const file = files[activeFileIndex];
    const trimmed = text.trim();
    if (!file || !trimmed) return;

    const newAnnotation: CodeAnnotation = {
      id: generateId(),
      type: 'comment',
      scope: 'file',
      filePath: file.path,
      lineStart: 1,
      lineEnd: 1,
      side: 'new',
      text: trimmed,
      createdAt: Date.now(),
    };

    setAnnotations((prev) => [...prev, newAnnotation]);
  }, [files, activeFileIndex]);

  const handleEditAnnotation = useCallback((
    id: string,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
  ) => {
    setAnnotations((prev) => prev.map((annotation) =>
      annotation.id === id
        ? {
            ...annotation,
            ...(text !== undefined && { text }),
            ...(suggestedCode !== undefined && { suggestedCode }),
            ...(originalCode !== undefined && { originalCode }),
          }
        : annotation,
    ));
  }, []);

  const handleDeleteAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((annotation) => annotation.id !== id));
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
  }, [selectedAnnotationId]);

  const handleFileSwitch = useCallback((index: number) => {
    if (index !== activeFileIndex) {
      setPendingSelection(null);
      setActiveFileIndex(index);
    }
  }, [activeFileIndex]);

  const feedbackMarkdown = useMemo(() => exportReviewFeedback(annotations), [annotations]);

  const handleCopyDiff = useCallback(async () => {
    if (!diffData) return;
    try {
      await navigator.clipboard.writeText(diffData.rawPatch);
      setCopyFeedback('Diff copied');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback('Copy failed');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [diffData]);

  const handleSendFeedback = useCallback(async () => {
    if (annotations.length === 0) return;
    setIsSendingFeedback(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: false,
          feedback: feedbackMarkdown,
          annotations,
        }),
      });
      if (!res.ok) throw new Error('Failed to send feedback');
      setSubmitted('feedback');
    } catch {
      setIsSendingFeedback(false);
    }
  }, [annotations, feedbackMarkdown]);

  const handleApprove = useCallback(async () => {
    setIsApproving(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          feedback: 'LGTM - no changes requested.',
          annotations: [],
        }),
      });
      if (!res.ok) throw new Error('Failed to approve');
      setSubmitted('approved');
    } catch {
      setIsApproving(false);
    }
  }, []);

  const fetchDiffSwitch = useCallback(async (nextDiffType: string) => {
    setIsLoadingDiff(true);
    try {
      const res = await fetch('/api/diff/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffType: nextDiffType }),
      });
      if (!res.ok) throw new Error('Failed to switch diff');

      const data = await res.json() as {
        rawPatch: string;
        gitRef: string;
        diffType: string;
        error?: string;
      };

      const parsedFiles = parseDiffToFiles(data.rawPatch);
      setFiles(parsedFiles);
      setActiveFileIndex(0);
      setPendingSelection(null);
      setDiffType(data.diffType);
      setDiffError(data.error || null);
      setDiffData((prev) => prev ? {
        ...prev,
        files: parsedFiles,
        rawPatch: data.rawPatch,
        gitRef: data.gitRef,
        diffType: data.diffType,
      } : null);
    } catch {
      setDiffError('Failed to switch diff view.');
    } finally {
      setIsLoadingDiff(false);
    }
  }, []);

  if (isLoading) {
    return (
      <ThemeProvider
        defaultTheme="dark"
        defaultColorTheme="claude-plus"
        storageKey="diff-review-theme"
        colorThemeStorageKey="diff-review-color-theme"
      >
        <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          Loading diff…
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider
      defaultTheme="dark"
      defaultColorTheme="claude-plus"
      storageKey="diff-review-theme"
      colorThemeStorageKey="diff-review-color-theme"
    >
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <header className="z-40 flex h-12 items-center justify-between border-b border-border/50 bg-card/70 px-3 backdrop-blur-xl md:px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight text-foreground">Diff Review</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {repoInfo?.display || diffData?.gitRef || 'Current changes'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
              <button
                onClick={() => setDiffStyle('split')}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  diffStyle === 'split' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Split
              </button>
              <button
                onClick={() => setDiffStyle('unified')}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  diffStyle === 'unified' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Unified
              </button>
            </div>

            <button
              onClick={handleCopyDiff}
              className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/80"
            >
              {copyFeedback || 'Copy diff'}
            </button>

            <button
              onClick={() => void handleSendFeedback()}
              disabled={isSendingFeedback || isApproving || annotations.length === 0}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                isSendingFeedback || isApproving || annotations.length === 0
                  ? 'cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60'
                  : 'border-accent/30 bg-accent/15 text-accent hover:bg-accent/25'
              }`}
            >
              {isSendingFeedback ? 'Sending…' : 'Request changes'}
            </button>

            <button
              onClick={() => void handleApprove()}
              disabled={isSendingFeedback || isApproving}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-opacity ${
                isSendingFeedback || isApproving
                  ? 'cursor-not-allowed bg-muted text-muted-foreground opacity-60'
                  : 'bg-success text-success-foreground hover:opacity-90'
              }`}
            >
              {isApproving ? 'Approving…' : 'Approve'}
            </button>

            <button
              onClick={() => setIsPanelOpen((prev) => !prev)}
              className={`rounded-md p-1.5 text-xs transition-colors ${
                isPanelOpen ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              title={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </button>
          </div>
        </header>

        {diffError && (
          <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {diffError}
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {(files.length > 1 || gitContext?.diffOptions) && (
            <FileTree
              files={files}
              activeFileIndex={activeFileIndex}
              onSelectFile={handleFileSwitch}
              annotations={annotations}
              viewedFiles={new Set<string>()}
              enableKeyboardNav={true}
              diffOptions={gitContext?.diffOptions}
              activeDiffType={diffType.startsWith('worktree:') ? diffType.slice(diffType.lastIndexOf(':') + 1) : diffType}
              onSelectDiff={(next) => void fetchDiffSwitch(next)}
              isLoadingDiff={isLoadingDiff}
              worktrees={gitContext?.worktrees}
              activeWorktreePath={diffType.startsWith('worktree:') ? diffType.slice('worktree:'.length).replace(/:[^:]+$/, '') : null}
              onSelectWorktree={(path) => void fetchDiffSwitch(path ? `worktree:${path}:uncommitted` : 'uncommitted')}
              currentBranch={gitContext?.currentBranch}
            />
          )}

          <main className="min-w-0 flex-1 overflow-hidden">
            {activeFile ? (
              <DiffViewer
                patch={activeFile.patch}
                filePath={activeFile.path}
                oldPath={activeFile.oldPath}
                diffStyle={diffStyle}
                annotations={annotations.filter((annotation) => annotation.filePath === activeFile.path)}
                selectedAnnotationId={selectedAnnotationId}
                pendingSelection={pendingSelection}
                onLineSelection={handleLineSelection}
                onAddAnnotation={handleAddAnnotation}
                onAddFileComment={handleAddFileComment}
                onEditAnnotation={handleEditAnnotation}
                onSelectAnnotation={setSelectedAnnotationId}
                onDeleteAnnotation={handleDeleteAnnotation}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No diff content available.
              </div>
            )}
          </main>

          <ReviewPanel
            isOpen={isPanelOpen}
            onToggle={() => setIsPanelOpen((prev) => !prev)}
            annotations={annotations}
            files={files}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={setSelectedAnnotationId}
            onDeleteAnnotation={handleDeleteAnnotation}
            feedbackMarkdown={feedbackMarkdown}
          />
        </div>

        <SubmissionOverlay submitted={submitted} />
      </div>
    </ThemeProvider>
  );
};

export default App;
