import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { ConfirmDialog } from '@plannotator/ui/components/ConfirmDialog';
import {
  extractFrontmatter,
  exportAnnotations,
  parseMarkdownToBlocks,
  type Frontmatter,
} from '@plannotator/ui/utils/parser';
import {
  type Annotation,
  type Block,
  type InputMethod,
  type EditorMode,
} from '@plannotator/ui/types';

const DESKTOP_BREAKPOINT = 1024;

type ReviewDecision = 'approved' | 'changes' | null;

function SubmissionOverlay({ decision }: { decision: ReviewDecision }) {
  if (!decision) return null;

  const approved = decision === 'approved';

  return (
    <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center px-6">
      <div className="max-w-md text-center space-y-5">
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
            {approved ? 'Plan approved' : 'Feedback sent'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {approved
              ? 'The agent can stop here and wait for the next instruction.'
              : 'The agent can revise the plan and submit it again.'}
          </p>
        </div>

        <p className="text-xs text-muted-foreground/70">
          You can close this tab now.
        </p>
      </div>
    </div>
  );
}

const App: React.FC = () => {
  const viewerRef = useRef<ViewerHandle>(null);

  const [markdown, setMarkdown] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(() => window.innerWidth >= DESKTOP_BREAKPOINT);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [decision, setDecision] = useState<ReviewDecision>(null);
  const [showEmptyFeedbackConfirm, setShowEmptyFeedbackConfirm] = useState(false);
  const [repoInfo, setRepoInfo] = useState<{ display: string; branch?: string } | null>(null);

  const editorMode: EditorMode = 'selection';
  const inputMethod: InputMethod = 'drag';

  useEffect(() => {
    document.title = repoInfo ? `${repoInfo.display} · Plan Review` : 'Plan Review';
  }, [repoInfo]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= DESKTOP_BREAKPOINT) {
        setIsPanelOpen(true);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    fetch('/api/plan')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load plan');
        return res.json();
      })
      .then((data: { plan: string; repoInfo?: { display: string; branch?: string } }) => {
        setMarkdown(data.plan || '');
        if (data.repoInfo) setRepoInfo(data.repoInfo);
      })
      .catch(() => {
        setMarkdown('# Plan Review\n\nCould not load the plan.');
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    const parsed = extractFrontmatter(markdown);
    setFrontmatter(parsed.frontmatter);
    setBlocks(parseMarkdownToBlocks(markdown));
  }, [markdown]);

  const feedback = useMemo(() => {
    if (annotations.length === 0) return 'Please revise the plan.';
    return exportAnnotations(blocks, annotations, [], 'Plan Review Feedback', 'plan');
  }, [annotations, blocks]);

  const handleAddAnnotation = (annotation: Annotation) => {
    setAnnotations((prev) => [...prev, annotation]);
    setSelectedAnnotationId(annotation.id);
    setIsPanelOpen(true);
  };

  const handleDeleteAnnotation = (id: string) => {
    viewerRef.current?.removeHighlight(id);
    setAnnotations((prev) => prev.filter((annotation) => annotation.id !== id));
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
  };

  const handleEditAnnotation = (id: string, updates: Partial<Annotation>) => {
    setAnnotations((prev) =>
      prev.map((annotation) => (annotation.id === id ? { ...annotation, ...updates } : annotation)),
    );
  };

  const handleCopyFeedback = async () => {
    await navigator.clipboard.writeText(feedback);
  };

  const submit = async (approved: boolean, fallbackFeedback?: string) => {
    setIsSubmitting(true);
    try {
      const body = approved
        ? { feedback: annotations.length > 0 ? feedback : undefined }
        : { feedback: annotations.length > 0 ? feedback : fallbackFeedback || 'Please revise the plan.' };

      const endpoint = approved ? '/api/approve' : '/api/deny';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error('Failed to submit review');
      }

      setDecision(approved ? 'approved' : 'changes');
    } catch {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <ThemeProvider
        defaultTheme="dark"
        defaultColorTheme="claude-plus"
        storageKey="plan-review-theme"
        colorThemeStorageKey="plan-review-color-theme"
      >
        <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          Loading plan…
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider
      defaultTheme="dark"
      defaultColorTheme="claude-plus"
      storageKey="plan-review-theme"
      colorThemeStorageKey="plan-review-color-theme"
    >
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <header className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-border/50 bg-card/70 px-3 backdrop-blur-xl md:px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight text-foreground">Plan Review</div>
            {repoInfo && (
              <div className="hidden truncate text-[11px] text-muted-foreground md:block">
                {repoInfo.display}
                {repoInfo.branch ? ` · ${repoInfo.branch}` : ''}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (annotations.length === 0) {
                  setShowEmptyFeedbackConfirm(true);
                  return;
                }
                void submit(false);
              }}
              disabled={isSubmitting}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                isSubmitting
                  ? 'cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60'
                  : 'border-accent/30 bg-accent/15 text-accent hover:bg-accent/25'
              }`}
            >
              {isSubmitting ? 'Sending…' : 'Request changes'}
            </button>

            <button
              onClick={() => void submit(true)}
              disabled={isSubmitting}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-opacity ${
                isSubmitting
                  ? 'cursor-not-allowed bg-muted text-muted-foreground opacity-60'
                  : 'bg-success text-success-foreground hover:opacity-90'
              }`}
            >
              {isSubmitting ? 'Submitting…' : annotations.length > 0 ? 'Approve with notes' : 'Approve'}
            </button>

            <button
              onClick={() => setIsPanelOpen((prev) => !prev)}
              className={`rounded-md p-1.5 text-xs transition-colors ${
                isPanelOpen
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              title={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 lg:px-8">
            <div className="mx-auto flex justify-center">
              <Viewer
                ref={viewerRef}
                blocks={blocks}
                markdown={markdown}
                frontmatter={frontmatter}
                annotations={annotations}
                onAddAnnotation={handleAddAnnotation}
                onSelectAnnotation={setSelectedAnnotationId}
                selectedAnnotationId={selectedAnnotationId}
                mode={editorMode}
                inputMethod={inputMethod}
                taterMode={false}
                repoInfo={repoInfo}
                stickyActions={true}
                maxWidth={960}
                copyLabel="Copy plan"
              />
            </div>
          </main>

          <AnnotationPanel
            isOpen={isPanelOpen}
            annotations={annotations}
            blocks={blocks}
            onSelect={setSelectedAnnotationId}
            onDelete={handleDeleteAnnotation}
            onEdit={handleEditAnnotation}
            selectedId={selectedAnnotationId}
            sharingEnabled={false}
            onClose={() => setIsPanelOpen(false)}
            onQuickCopy={handleCopyFeedback}
          />
        </div>

        <ConfirmDialog
          isOpen={showEmptyFeedbackConfirm}
          onClose={() => setShowEmptyFeedbackConfirm(false)}
          onConfirm={() => {
            setShowEmptyFeedbackConfirm(false);
            void submit(false, 'Please revise the plan.');
          }}
          title="Request changes?"
          message="No annotations were added. Send a generic request for changes?"
          confirmText="Send request"
          cancelText="Cancel"
          showCancel={true}
          variant="warning"
        />

        <SubmissionOverlay decision={decision} />
      </div>
    </ThemeProvider>
  );
};

export default App;
