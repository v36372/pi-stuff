# Active task record

Use the shape from `templates/active-task.example.json` and include at least:

- `id`, `brIssueId` (e.g. `bd-a1b2c3`; `null` when br is not used), `tmuxSession`, `agent`, `model`, `fallbackModel`, `aiReviewers`, `thinking`
- `description`, `repo`, `worktree`, `branch`
- `startedAt`, `status`, `respawnAttempts`, `maxRespawnAttempts`
- `notifyOnComplete`, `respawnCommand`, `logPath`
- `initialPromptFile`, `wave`, `priority`
- `humanReviewState`, `humanReviewFeedback`, `pendingHumanFollowup`
- `lastPaneSnippet`, `lastPaneCapturedAt` (from `tmux capture-pane`)
- `followupCount`, `lastFollowupAt`, `lastFollowupMessage`, `lastFollowupHash`, `prUpdatedAt`
- `requireHumanReview` (set by monitor policy)
- `prOpenNudgeCount`, `lastPrOpenNudgeAt`, `fallbackActivated`, `fallbackActivatedAt`

Recommended status values:
- `queued`, `running`, `waiting-ci`, `waiting-review`, `waiting-artifacts`, `waiting-human-review`, `needs-human`, `complete`, `cancelled`
