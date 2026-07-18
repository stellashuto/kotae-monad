export const JUDGING_WINDOW_MS = 48 * 60 * 60 * 1000;

export function contestWindow(contest, now = Date.now()) {
  const submissionDeadlineAt = Date.parse(contest.submission_deadline ?? contest.deadline);
  const judgingStartedAt = Date.parse(contest.judging_started_at ?? contest.judgingStartedAt);
  const effectiveJudgingStartAt = Number.isFinite(judgingStartedAt) ? judgingStartedAt : submissionDeadlineAt;
  const judgingDeadlineAt = Number.isFinite(effectiveJudgingStartAt) ? effectiveJudgingStartAt + JUDGING_WINDOW_MS : Number.NaN;
  const capReached = Number(contest.valid_count ?? contest.validCount) >= Number(contest.valid_cap ?? contest.cap);
  const submissionDeadlineReached = Number.isFinite(submissionDeadlineAt) && now >= submissionDeadlineAt;
  const isOpen = contest.status === "OPEN";
  return {
    submissionDeadlineAt,
    judgingStartedAt: Number.isFinite(judgingStartedAt) ? judgingStartedAt : null,
    judgingDeadlineAt,
    capReached,
    submissionOpen: isOpen && !submissionDeadlineReached && !capReached,
    judgingOpen: isOpen && (submissionDeadlineReached || capReached) && (!Number.isFinite(judgingDeadlineAt) || now <= judgingDeadlineAt),
    timeoutReady: isOpen && Number.isFinite(judgingDeadlineAt) && now > judgingDeadlineAt,
  };
}
