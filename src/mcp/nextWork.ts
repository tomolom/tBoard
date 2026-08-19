import type { CardDto, CardPriority, CardStatus, NextWorkResult } from '../shared/api';
import type { TBoardMcpContext } from './context';

/** Statuses that represent work still needing action. */
const ACTIONABLE_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['backlog', 'developing', 'untested', 'needs_fix']);

const PRIORITY_RANK: Record<CardPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function compareActionableCards(a: CardDto, b: CardDto): number {
  const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const severityDelta = (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  // Older cards first (updatedAt ascending) so long-waiting work surfaces.
  return a.updatedAt.localeCompare(b.updatedAt);
}

/**
 * Composes the read-only services into a prioritized "what needs work" answer
 * (PRD §3.5 / §9: agents can ask what needs work). Purely read-only: it lists
 * actionable cards (highest priority/severity, oldest first), drifted variants,
 * variants with open bugs, and variants missing a source/target root.
 */
export function computeNextWork(context: TBoardMcpContext): NextWorkResult {
  const actionableCards = context.cards
    .listCards()
    .filter((card) => ACTIONABLE_STATUSES.has(card.status))
    .sort(compareActionableCards);

  const driftedVariants = context.diff
    .listDiffOverviews()
    .filter((overview) => overview.addedCount + overview.modifiedCount + overview.deletedCount > 0)
    .sort(
      (a, b) =>
        b.addedCount + b.modifiedCount + b.deletedCount - (a.addedCount + a.modifiedCount + a.deletedCount),
    );

  const variants = context.inventory.listComponentVariants();
  const variantsWithOpenBugs = variants
    .filter((variant) => variant.openBugCount > 0)
    .sort((a, b) => b.openBugCount - a.openBugCount);
  // A single-repo (no target) mapping is complete with just its primary repo;
  // only flag a genuinely missing side. For source_target mappings, either side
  // missing is actionable.
  const variantsMissingSourceOrTarget = variants.filter((variant) =>
    variant.mappingKind === 'single' ? !variant.sourceExists : !variant.sourceExists || !variant.targetExists,
  );

  return {
    actionableCards,
    driftedVariants,
    variantsWithOpenBugs,
    variantsMissingSourceOrTarget,
    generatedAt: new Date().toISOString(),
  };
}
