import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import type { BoardDto, BranchDto, CardDto, CardPriority, CardStatus, CardType, TBoardApi } from '../../shared/api';
import { useFocusTrap } from './useFocusTrap';

declare global {
  interface Window {
    tBoard: TBoardApi;
  }
}

const STATUSES: CardStatus[] = ['backlog', 'developing', 'untested', 'needs_fix', 'approved', 'released'];
const PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];
const CARD_TYPES: CardType[] = ['task', 'bug', 'feature'];

/** Sentinels for the filters — real branch/module names are used as-is. */
const FILTER_ALL = '\u0000all';
const FILTER_NONE = '\u0000none';

/**
 * The connection bridge only exists on the Electron preload, so its absence is
 * the reliable "served over HTTP" signal. Checked lazily rather than at module
 * scope because web mode assigns `window.tBoard` after this module is imported.
 */
function isWebMode(): boolean {
  return !window.tBoard.connection;
}

/**
 * On the hosted server the git repos are not on disk, so a repo read always
 * fails with a path from someone else's machine. Branch and module are
 * free-text there, so the failure is not actionable — drop it.
 */
function repoReadError(error: string | null): string | null {
  return isWebMode() ? null : error;
}

/**
 * Where a dragged card would land: immediately before `beforeCardId`, or at the
 * end of the column when that is null.
 */
type DropSpot = { status: CardStatus; beforeCardId: number | null };

/**
 * Words that must not be Title-Cased naively. Keyed by the lowercased token.
 */
const LABEL_SPECIAL_CASES: Record<string, string> = {
  mcp: 'MCP',
  ui: 'UI',
  id: 'ID',
  url: 'URL',
  api: 'API',
};

/**
 * Turns an enum value into a display label: `in_progress` → "In Progress",
 * `mcp` → "MCP". Only the display changes; stored values are untouched.
 */
function humanizeLabel(value: string): string {
  return value
    .split(/[\s_]+/u)
    .filter(Boolean)
    .map((word) => {
      const special = LABEL_SPECIAL_CASES[word.toLowerCase()];
      if (special) {
        return special;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return '\u2014';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function BranchBadge({ branch }: { branch: string }) {
  return (
    <small className="meta-badge branch-badge" title={`Branch: ${branch}`}>
      <span aria-hidden="true">&#9095;</span>
      <span className="meta-name">{branch}</span>
    </small>
  );
}

/**
 * Type badge. `task` is the default and stays neutral so that bugs and
 * features are what the eye catches when scanning a column.
 */
function TypeBadge({ type }: { type: CardType }) {
  if (type === 'bug') {
    return (
      <small className="meta-badge type-badge type-bug" title="Bug">
        <svg className="type-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path
            d="M6 1a2 2 0 0 1 1.83 1.2A3 3 0 0 1 9 4.6V5h1.4a.6.6 0 0 1 0 1.2H9v.6q0 .3-.05.6h1.45a.6.6 0 0 1 0 1.2H8.5A3 3 0 0 1 6 11a3 3 0 0 1-2.5-2.4H1.6a.6.6 0 0 1 0-1.2h1.45Q3 7.1 3 6.8v-.6H1.6a.6.6 0 0 1 0-1.2H3v-.4a3 3 0 0 1 1.17-2.4A2 2 0 0 1 6 1"
            fill="currentColor"
          />
        </svg>
        Bug
      </small>
    );
  }
  if (type === 'feature') {
    return (
      <small className="meta-badge type-badge type-feature" title="Feature">
        <svg className="type-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M6 0.8 7.15 4.1 10.6 5.2 7.15 6.3 6 9.6 4.85 6.3 1.4 5.2 4.85 4.1Z" fill="currentColor" />
          <path d="M9.9 7.7 10.4 9.1 11.8 9.6 10.4 10.1 9.9 11.5 9.4 10.1 8 9.6 9.4 9.1Z" fill="currentColor" />
        </svg>
        Feature
      </small>
    );
  }
  return (
    <small className="meta-badge type-badge type-task" title="Task">
      Task
    </small>
  );
}

function ModuleBadge({ module }: { module: string }) {
  return (
    <small className="meta-badge module-badge" title={`Module: ${module}`}>
      <svg className="folder-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path
          d="M1 2.75A.75.75 0 0 1 1.75 2h2.6c.27 0 .52.14.65.38l.4.62h4.85a.75.75 0 0 1 .75.75v5.5a.75.75 0 0 1-.75.75h-8.5A.75.75 0 0 1 1 9.25z"
          fill="currentColor"
        />
      </svg>
      <span className="meta-name">{module}</span>
    </small>
  );
}

/**
 * Reorders `list` so `cardId` sits in `status` immediately after `afterCardId`
 * (or at the top when null). Used for the optimistic update before the server
 * response lands; `cards.list` order stays authoritative.
 */
function applyLocalMove(
  list: CardDto[],
  cardId: number,
  status: CardStatus,
  afterCardId: number | null,
): CardDto[] {
  const card = list.find((item) => item.id === cardId);
  if (!card) {
    return list;
  }
  const without = list.filter((item) => item.id !== cardId);
  const moved: CardDto = { ...card, status };

  if (afterCardId === null) {
    const firstOfStatus = without.findIndex((item) => item.status === status);
    if (firstOfStatus === -1) {
      return [...without, moved];
    }
    return [...without.slice(0, firstOfStatus), moved, ...without.slice(firstOfStatus)];
  }

  const anchor = without.findIndex((item) => item.id === afterCardId);
  if (anchor === -1) {
    return [...without, moved];
  }
  return [...without.slice(0, anchor + 1), moved, ...without.slice(anchor + 1)];
}

export default function App() {
  const [boards, setBoards] = useState<BoardDto[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<number | null>(null);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [addingBoard, setAddingBoard] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [removingBoard, setRemovingBoard] = useState(false);

  const [cards, setCards] = useState<CardDto[]>([]);
  const [cardError, setCardError] = useState<string | null>(null);
  const [movingCardId, setMovingCardId] = useState<number | null>(null);

  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [modules, setModules] = useState<string[]>([]);
  const [refreshingRepo, setRefreshingRepo] = useState(false);

  const [branchFilter, setBranchFilter] = useState<string>(FILTER_ALL);
  const [moduleFilter, setModuleFilter] = useState<string>(FILTER_ALL);
  const [typeFilter, setTypeFilter] = useState<string>(FILTER_ALL);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const [dragCardId, setDragCardId] = useState<number | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const kanbanRef = useRef<HTMLDivElement | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollVectorRef = useRef({ x: 0, y: 0 });

  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newBranch, setNewBranch] = useState('');
  // Once the user picks a branch for new cards, auto-refresh stops overriding it.
  const [composerBranchTouched, setComposerBranchTouched] = useState(false);
  const [newModule, setNewModule] = useState('');
  const [newType, setNewType] = useState<CardType>('task');
  const [newPriority, setNewPriority] = useState<CardPriority>('normal');
  const [creating, setCreating] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const remoteRef = useRef<HTMLDivElement | null>(null);
  const remoteInputRef = useRef<HTMLInputElement | null>(null);
  const remoteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerTitleRef = useRef<HTMLInputElement | null>(null);
  const composerTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [detailTitle, setDetailTitle] = useState('');
  const [detailDescription, setDetailDescription] = useState('');
  const [detailStatus, setDetailStatus] = useState<CardStatus>('backlog');
  const [detailPriority, setDetailPriority] = useState<CardPriority>('normal');
  const [detailBranch, setDetailBranch] = useState('');
  const [detailModule, setDetailModule] = useState('');
  const [detailType, setDetailType] = useState<CardType>('task');
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );

  const selectedCard = useMemo(
    () => (selectedCardId === null ? null : (cards.find((card) => card.id === selectedCardId) ?? null)),
    [cards, selectedCardId],
  );

  // Git may be unavailable or the repo may have moved. Fall back to a free-text
  // branch field rather than blocking card editing.
  const branchesUnavailable = branchError !== null || branches.length === 0;

  /**
   * Branches offered in the filter: everything git reported, plus any branch
   * already referenced by a card. The union keeps the filter usable even when
   * `boards.branches` fails.
   */
  const branchOptions = useMemo(() => {
    const names = new Set<string>();
    for (const branch of branches) {
      names.add(branch.name);
    }
    for (const card of cards) {
      if (card.branch) {
        names.add(card.branch);
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [branches, cards]);

  // No discovered modules means the repo scan found nothing (or failed) — fall
  // back to free text so the field is never a dead end.
  const modulesUnavailable = modules.length === 0;

  /** Discovered modules plus any module a card already references. */
  const moduleOptions = useMemo(() => {
    const names = new Set<string>(modules);
    for (const card of cards) {
      if (card.module) {
        names.add(card.module);
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [modules, cards]);

  const hasUnbranchedCards = useMemo(() => cards.some((card) => card.branch === null), [cards]);
  const hasUnmoduledCards = useMemo(() => cards.some((card) => card.module === null), [cards]);

  const visibleCards = useMemo(() => {
    return cards.filter((card) => {
      const branchOk =
        branchFilter === FILTER_ALL ||
        (branchFilter === FILTER_NONE ? card.branch === null : card.branch === branchFilter);
      const moduleOk =
        moduleFilter === FILTER_ALL ||
        (moduleFilter === FILTER_NONE ? card.module === null : card.module === moduleFilter);
      const typeOk = typeFilter === FILTER_ALL || card.type === typeFilter;
      return branchOk && moduleOk && typeOk;
    });
  }, [cards, branchFilter, moduleFilter, typeFilter]);

  const cardsByStatus = useMemo(() => {
    const grouped = new Map<CardStatus, CardDto[]>(STATUSES.map((status) => [status, []]));
    for (const card of visibleCards) {
      grouped.get(card.status)?.push(card);
    }
    return grouped;
  }, [visibleCards]);

  async function refreshCards(boardId: number): Promise<void> {
    setCards(await window.tBoard.cards.list(boardId));
  }

  /**
   * Re-reads branches and modules for a board. Only touches repo metadata —
   * never card state — so it is safe to run while a card is being edited.
   * `syncNewBranch` follows the repo's checked-out branch in the composer.
   */
  async function refreshRepoMeta(boardId: number, syncNewBranch: boolean): Promise<void> {
    const [branchResult, moduleList] = await Promise.all([
      window.tBoard.boards.branches(boardId),
      window.tBoard.boards.modules(boardId),
    ]);
    setBranches(branchResult.branches);
    setCurrentBranch(branchResult.current);
    setBranchError(repoReadError(branchResult.error));
    setModules(moduleList);
    if (syncNewBranch) {
      setNewBranch(branchResult.current ?? '');
    }
  }

  // Restore the last board on launch.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [list, lastBoardId] = await Promise.all([
          window.tBoard.boards.list(),
          window.tBoard.settings.getLastBoardId(),
        ]);
        if (cancelled) {
          return;
        }
        setBoards(list);
        const restored = list.find((board) => board.id === lastBoardId) ?? list[0] ?? null;
        setSelectedBoardId(restored?.id ?? null);
      } catch (loadError) {
        if (!cancelled) {
          setBoardError(errorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setBoardsLoaded(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load a board's cards and branches whenever the selection changes.
  useEffect(() => {
    if (selectedBoardId === null) {
      setCards([]);
      setBranches([]);
      setCurrentBranch(null);
      setBranchError(null);
      setModules([]);
      return;
    }
    let cancelled = false;
    setBranchFilter(FILTER_ALL);
    setModuleFilter(FILTER_ALL);
    setTypeFilter(FILTER_ALL);
    setSelectedCardId(null);
    setCardError(null);
    setComposerBranchTouched(false);
    setNewModule('');
    setNewDescription('');

    // Every state write is guarded: switching boards quickly must not let a
    // slower earlier response overwrite the newer board's data.
    async function load(boardId: number): Promise<void> {
      try {
        const [cardList, branchResult, moduleList] = await Promise.all([
          window.tBoard.cards.list(boardId),
          window.tBoard.boards.branches(boardId),
          window.tBoard.boards.modules(boardId),
        ]);
        if (cancelled) {
          return;
        }
        setCards(cardList);
        setBranches(branchResult.branches);
        setCurrentBranch(branchResult.current);
        setBranchError(repoReadError(branchResult.error));
        setModules(moduleList);
        // New cards default to whatever the repo has checked out.
        setNewBranch(branchResult.current ?? '');
      } catch (loadError) {
        if (!cancelled) {
          setCardError(errorMessage(loadError));
        }
      }
    }
    void load(selectedBoardId);
    void window.tBoard.settings.setLastBoardId(selectedBoardId);
    return () => {
      cancelled = true;
    };
  }, [selectedBoardId]);

  /**
   * Live-update from external database writes (e.g. an agent using the MCP
   * server). Registered once; refs feed it the current selection and drag state
   * so it never re-subscribes and never reads stale values.
   *
   * Safe because the MCP surface can only add boards and create/update/move
   * cards — it cannot remove a board or delete a card, so a live refetch can
   * never pull the selected board or an open card out from under the user. The
   * drawer's edit buffer is separate `detail*` state, so refreshing `cards`
   * leaves unsaved edits intact. An in-progress drag is skipped — its own drop
   * refetches at the end.
   */
  const selectedBoardIdRef = useRef(selectedBoardId);
  selectedBoardIdRef.current = selectedBoardId;
  const dragCardIdRef = useRef(dragCardId);
  dragCardIdRef.current = dragCardId;

  useEffect(() => {
    const unsubscribe = window.tBoard.onDbChanged(() => {
      if (dragCardIdRef.current !== null) {
        return;
      }
      void window.tBoard.boards.list().then(setBoards).catch(() => undefined);
      const boardId = selectedBoardIdRef.current;
      if (boardId !== null) {
        void window.tBoard.cards.list(boardId).then(setCards).catch(() => undefined);
      }
    });
    return unsubscribe;
  }, []);

  /*
   * Edge auto-scroll while dragging a card. This listens on the document rather
   * than hooking the existing dragover handlers, so drop-position logic, the
   * optimistic reorder and `dragCardId` are all left exactly as they were.
   *
   * The kanban owns both axes of overflow, so it is the only container to move.
   * The rAF loop reads a ref vector: pointer events only update the vector, and
   * the loop keeps scrolling between events — dragover goes quiet when the
   * pointer is held still inside the hot zone, which would otherwise stall.
   */
  useEffect(() => {
    if (dragCardId === null) {
      return;
    }

    const HOT_ZONE = 60;
    const MAX_SPEED = 18;

    function speedFor(distance: number): number {
      if (distance >= HOT_ZONE) {
        return 0;
      }
      // Closer to the edge scrolls faster, clamped so it never jumps.
      const closeness = (HOT_ZONE - Math.max(distance, 0)) / HOT_ZONE;
      return Math.ceil(closeness * MAX_SPEED);
    }

    function step(): void {
      const container = kanbanRef.current;
      const { x, y } = autoScrollVectorRef.current;
      if (!container || (x === 0 && y === 0)) {
        autoScrollFrameRef.current = null;
        return;
      }
      container.scrollLeft += x;
      container.scrollTop += y;
      autoScrollFrameRef.current = requestAnimationFrame(step);
    }

    function onDragOver(event: globalThis.DragEvent): void {
      const container = kanbanRef.current;
      if (!container) {
        return;
      }
      const bounds = container.getBoundingClientRect();
      const inside =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (!inside) {
        autoScrollVectorRef.current = { x: 0, y: 0 };
        return;
      }
      const left = speedFor(event.clientX - bounds.left);
      const right = speedFor(bounds.right - event.clientX);
      const top = speedFor(event.clientY - bounds.top);
      const bottom = speedFor(bounds.bottom - event.clientY);
      autoScrollVectorRef.current = { x: right - left, y: bottom - top };
      if (autoScrollFrameRef.current === null) {
        autoScrollFrameRef.current = requestAnimationFrame(step);
      }
    }

    document.addEventListener('dragover', onDragOver);
    // Covers drop, dragend and a cancelled drag alike, plus unmount mid-drag.
    return () => {
      document.removeEventListener('dragover', onDragOver);
      autoScrollVectorRef.current = { x: 0, y: 0 };
      if (autoScrollFrameRef.current !== null) {
        cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    };
  }, [dragCardId]);

  // A filtered-away branch would otherwise hide every card with no way back.
  useEffect(() => {
    if (branchFilter === FILTER_ALL || branchFilter === FILTER_NONE) {
      return;
    }
    if (!branchOptions.includes(branchFilter)) {
      setBranchFilter(FILTER_ALL);
    }
  }, [branchFilter, branchOptions]);

  useEffect(() => {
    if (moduleFilter === FILTER_ALL || moduleFilter === FILTER_NONE) {
      return;
    }
    if (!moduleOptions.includes(moduleFilter)) {
      setModuleFilter(FILTER_ALL);
    }
  }, [moduleFilter, moduleOptions]);

  // Card types are a fixed set, so this only guards against a stale value.
  useEffect(() => {
    if (typeFilter !== FILTER_ALL && !CARD_TYPES.includes(typeFilter as CardType)) {
      setTypeFilter(FILTER_ALL);
    }
  }, [typeFilter]);

  /**
   * Re-read branches/modules when the window regains focus, so a branch checked
   * out or a folder added in the terminal shows up without a board switch.
   * Card state is untouched, so an open drawer keeps its unsaved edits.
   */
  useEffect(() => {
    if (selectedBoardId === null) {
      return;
    }
    const boardId = selectedBoardId;
    function onFocus(): void {
      // Follow the repo's checked-out branch only while the composer branch is
      // still the default — never overwrite a choice the user made.
      void refreshRepoMeta(boardId, !composerBranchTouched).catch((refreshError) => {
        setCardError(errorMessage(refreshError));
      });
    }
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [selectedBoardId, composerBranchTouched]);

  // Arming is per-board; switching boards must not carry a primed delete over.
  useEffect(() => {
    setRemoveArmed(false);
    setRenaming(false);
  }, [selectedBoardId]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  /**
   * Opens the remote-connect popover, pre-filling whatever URL is stored. The
   * connection bridge is desktop-only, so every call site guards on it first.
   */
  function openRemotePopover(): void {
    setRemoteError(null);
    setRemoteOpen(true);
    void window.tBoard.connection?.getRemoteUrl().then((url) => {
      setRemoteUrl(url ?? '');
    });
  }

  async function connectRemote(): Promise<void> {
    const url = remoteUrl.trim();
    if (remoteBusy || url === '') {
      return;
    }
    const connection = window.tBoard.connection;
    if (!connection) {
      return;
    }
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      // On success the main process reloads the window onto the hosted board,
      // so there is nothing to do here but surface a failure.
      const result = await connection.setRemoteUrl(url);
      if (!result.ok) {
        setRemoteError(result.error ?? 'Could not connect to that address.');
        setRemoteBusy(false);
      }
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error));
      setRemoteBusy(false);
    }
  }

  async function addBoard(): Promise<void> {
    setBoardError(null);
    setAddingBoard(true);
    try {
      const repoPath = await window.tBoard.boards.pickRepoFolder();
      if (repoPath === null) {
        return;
      }
      const result = await window.tBoard.boards.add({ repoPath });
      if (result.error !== null || result.board === null) {
        setBoardError(result.error ?? 'Could not add that folder as a board.');
        return;
      }
      setBoards(await window.tBoard.boards.list());
      setSelectedBoardId(result.board.id);
    } catch (addError) {
      setBoardError(errorMessage(addError));
    } finally {
      setAddingBoard(false);
    }
  }

  async function removeBoard(): Promise<void> {
    if (selectedBoardId === null) {
      return;
    }
    setBoardError(null);
    setRemovingBoard(true);
    try {
      await window.tBoard.boards.remove(selectedBoardId);
      const list = await window.tBoard.boards.list();
      setBoards(list);
      setSelectedBoardId(list[0]?.id ?? null);
      if (list.length === 0) {
        void window.tBoard.settings.setLastBoardId(null);
      }
      setRemoveArmed(false);
    } catch (removeError) {
      setBoardError(errorMessage(removeError));
    } finally {
      setRemovingBoard(false);
    }
  }

  async function refreshRepoMetaNow(): Promise<void> {
    if (selectedBoardId === null) {
      return;
    }
    setRefreshingRepo(true);
    setCardError(null);
    try {
      await refreshRepoMeta(selectedBoardId, !composerBranchTouched);
    } catch (refreshError) {
      setCardError(errorMessage(refreshError));
    } finally {
      setRefreshingRepo(false);
    }
  }

  function startRename(): void {
    if (!selectedBoard) {
      return;
    }
    setRenameValue(selectedBoard.name);
    setRenaming(true);
    setBoardError(null);
  }

  async function commitRename(): Promise<void> {
    if (selectedBoardId === null) {
      return;
    }
    const name = renameValue.trim();
    if (name === '') {
      setBoardError('A board needs a name.');
      return;
    }
    if (name === selectedBoard?.name) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    setBoardError(null);
    try {
      await window.tBoard.boards.rename(selectedBoardId, name);
      setBoards(await window.tBoard.boards.list());
      setRenaming(false);
    } catch (renameError) {
      setBoardError(errorMessage(renameError));
    } finally {
      setRenameBusy(false);
    }
  }

  async function createCard(): Promise<void> {
    const title = newTitle.trim();
    if (selectedBoardId === null || title === '') {
      return;
    }
    setCreating(true);
    setCardError(null);
    try {
      const branch = newBranch.trim();
      const module = newModule.trim();
      const description = newDescription.trim();
      await window.tBoard.cards.create({
        boardId: selectedBoardId,
        title,
        description: description === '' ? null : description,
        type: newType,
        priority: newPriority,
        branch: branch === '' ? null : branch,
        module: module === '' ? null : module,
      });
      setNewTitle('');
      setNewDescription('');
      setComposerOpen(false);
      await refreshCards(selectedBoardId);
    } catch (createError) {
      setCardError(errorMessage(createError));
    } finally {
      setCreating(false);
    }
  }

  /**
   * Moves a card, optimistically reordering first so the board does not flicker
   * on the round trip, then reconciling against the server's canonical order.
   */
  async function moveCard(cardId: number, status: CardStatus, afterCardId: number | null = null): Promise<void> {
    const previous = cards;
    setCards((current) => applyLocalMove(current, cardId, status, afterCardId));
    setMovingCardId(cardId);
    setCardError(null);
    try {
      await window.tBoard.cards.move(cardId, status, afterCardId);
      if (selectedBoardId !== null) {
        await refreshCards(selectedBoardId);
      }
    } catch (moveError) {
      // Put the board back the way it was rather than leaving a phantom move.
      setCards(previous);
      setCardError(errorMessage(moveError));
    } finally {
      setMovingCardId(null);
    }
  }

  /**
   * Converts a drop marker ("insert before X", or end-of-column when null) into
   * the `afterCardId` anchor the API expects. The dragged card is excluded so
   * its own current slot never becomes its anchor.
   */
  function resolveAfterCardId(spot: DropSpot, draggedId: number): number | null {
    const column = (cardsByStatus.get(spot.status) ?? []).filter((card) => card.id !== draggedId);
    if (spot.beforeCardId === null) {
      return column.length === 0 ? null : column[column.length - 1].id;
    }
    const index = column.findIndex((card) => card.id === spot.beforeCardId);
    // Dropped above the first card (or the anchor vanished) — send to the top.
    if (index <= 0) {
      return null;
    }
    return column[index - 1].id;
  }

  function onCardDragStart(event: DragEvent<HTMLElement>, card: CardDto): void {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(card.id));
    setDragCardId(card.id);
  }

  function onCardDragEnd(): void {
    setDragCardId(null);
    setDropSpot(null);
  }

  /** Top half of a card means "insert above it", bottom half "insert below". */
  function onCardDragOver(event: DragEvent<HTMLElement>, card: CardDto, index: number): void {
    if (dragCardId === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const isTopHalf = event.clientY < bounds.top + bounds.height / 2;
    const column = cardsByStatus.get(card.status) ?? [];
    const next = column[index + 1];
    setDropSpot({
      status: card.status,
      beforeCardId: isTopHalf ? card.id : (next?.id ?? null),
    });
  }

  function onColumnDragOver(event: DragEvent<HTMLElement>, status: CardStatus): void {
    if (dragCardId === null) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // Not over any card — land at the end of this column.
    setDropSpot({ status, beforeCardId: null });
  }

  function onColumnDrop(event: DragEvent<HTMLElement>, status: CardStatus): void {
    event.preventDefault();
    const cardId = dragCardId;
    const spot = dropSpot;
    setDragCardId(null);
    setDropSpot(null);
    if (cardId === null) {
      return;
    }
    const target: DropSpot = spot?.status === status ? spot : { status, beforeCardId: null };
    const afterCardId = resolveAfterCardId(target, cardId);
    const dragged = cards.find((card) => card.id === cardId);
    // Same column, same neighbour — nothing actually changed.
    if (dragged && dragged.status === status) {
      const column = (cardsByStatus.get(status) ?? []).filter((card) => card.id !== cardId);
      const currentIndex = (cardsByStatus.get(status) ?? []).findIndex((card) => card.id === cardId);
      const currentAfter = currentIndex <= 0 ? null : (column[currentIndex - 1]?.id ?? null);
      if (currentAfter === afterCardId) {
        return;
      }
    }
    void moveCard(cardId, status, afterCardId);
  }

  function openCardDetail(card: CardDto): void {
    setSelectedCardId(card.id);
    setDetailTitle(card.title);
    setDetailDescription(card.description ?? '');
    setDetailStatus(card.status);
    setDetailPriority(card.priority);
    setDetailBranch(card.branch ?? '');
    setDetailModule(card.module ?? '');
    setDetailType(card.type);
    setDetailError(null);
    setDeleteArmed(false);
  }

  function closeCardDetail(): void {
    setSelectedCardId(null);
    setDetailError(null);
    setDeleteArmed(false);
  }

  function resetCardDetail(): void {
    if (selectedCard) {
      openCardDetail(selectedCard);
    }
  }

  const detailDirty =
    selectedCard !== null &&
    (detailTitle !== selectedCard.title ||
      detailDescription !== (selectedCard.description ?? '') ||
      detailStatus !== selectedCard.status ||
      detailPriority !== selectedCard.priority ||
      detailBranch !== (selectedCard.branch ?? '') ||
      detailModule !== (selectedCard.module ?? '') ||
      detailType !== selectedCard.type);

  async function saveCardDetail(): Promise<void> {
    if (selectedCard === null) {
      return;
    }
    const title = detailTitle.trim();
    if (title === '') {
      setDetailError('A card needs a title.');
      return;
    }
    setDetailBusy(true);
    setDetailError(null);
    try {
      const branch = detailBranch.trim();
      const module = detailModule.trim();
      const description = detailDescription.trim();
      await window.tBoard.cards.update(selectedCard.id, {
        title,
        description: description === '' ? null : description,
        type: detailType,
        status: detailStatus,
        priority: detailPriority,
        branch: branch === '' ? null : branch,
        module: module === '' ? null : module,
      });
      if (selectedBoardId !== null) {
        await refreshCards(selectedBoardId);
      }
    } catch (saveError) {
      setDetailError(errorMessage(saveError));
    } finally {
      setDetailBusy(false);
    }
  }

  async function deleteCard(): Promise<void> {
    if (selectedCard === null) {
      return;
    }
    setDetailBusy(true);
    setDetailError(null);
    try {
      await window.tBoard.cards.remove(selectedCard.id);
      closeCardDetail();
      if (selectedBoardId !== null) {
        await refreshCards(selectedBoardId);
      }
    } catch (removeError) {
      setDetailError(errorMessage(removeError));
      setDetailBusy(false);
    }
  }

  // Escape closes the drawer; body scroll is locked while it is open.
  useEffect(() => {
    if (selectedCardId === null) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        closeCardDetail();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Initial focus and restore are owned by useFocusTrap below.
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedCardId]);

  useFocusTrap(selectedCardId !== null, drawerRef, { initialFocusRef: drawerCloseRef });

  // The quick-add popover: Esc and any click outside dismiss it. Focus lands on
  // the title input and returns to the "+" button on close (via useFocusTrap).
  useEffect(() => {
    if (!composerOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setComposerOpen(false);
      }
    }
    function onPointerDown(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      // The trigger toggles on its own click; ignore it here so the two
      // handlers do not cancel each other out.
      if (composerRef.current?.contains(target) || composerTriggerRef.current?.contains(target)) {
        return;
      }
      setComposerOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [composerOpen]);

  useFocusTrap(composerOpen, composerRef, { initialFocusRef: composerTitleRef });

  // Remote-connect popover: same dismissal contract as the quick-add composer.
  useEffect(() => {
    if (!remoteOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setRemoteOpen(false);
      }
    }
    function onPointerDown(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (remoteRef.current?.contains(target) || remoteTriggerRef.current?.contains(target)) {
        return;
      }
      setRemoteOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [remoteOpen]);

  useFocusTrap(remoteOpen, remoteRef, { initialFocusRef: remoteInputRef });

  // Adding a card with no board selected is not possible — keep them in sync.
  useEffect(() => {
    if (selectedBoardId === null) {
      setComposerOpen(false);
    }
  }, [selectedBoardId]);

  // The open card may vanish on a refresh (deleted elsewhere) — drop the drawer.
  useEffect(() => {
    if (selectedCardId !== null && !cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(null);
    }
  }, [cards, selectedCardId]);

  /**
   * A dropdown of real git branches, or a free-text input when git could not be
   * read so the user is never blocked from setting a branch.
   */
  function renderBranchField(value: string, onChange: (next: string) => void) {
    if (branchesUnavailable) {
      return (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Branch name"
          spellCheck={false}
        />
      );
    }
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">No branch</option>
        {branches.map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}
            {branch.current ? ' (current)' : ''}
          </option>
        ))}
        {/* A card may point at a branch that no longer exists locally. */}
        {value !== '' && !branches.some((branch) => branch.name === value) ? (
          <option value={value}>{value} (missing)</option>
        ) : null}
      </select>
    );
  }

  /**
   * A dropdown of discovered repo subfolders, or free text when the scan found
   * none, mirroring the branch field.
   */
  function renderModuleField(value: string, onChange: (next: string) => void) {
    if (modulesUnavailable) {
      return (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Module path"
          spellCheck={false}
        />
      );
    }
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">No module</option>
        {modules.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {/* The card may point at a folder that is no longer in the repo. */}
        {value !== '' && !modules.includes(value) ? <option value={value}>{value} (missing)</option> : null}
      </select>
    );
  }

  function renderTopbar() {
    return (
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">tBoard</p>
          {selectedBoard ? (
            renaming ? (
              <div className="rename-row">
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitRename();
                    } else if (event.key === 'Escape') {
                      setRenaming(false);
                    }
                  }}
                  aria-label="Board name"
                  disabled={renameBusy}
                />
                <button type="button" className="primary" onClick={() => void commitRename()} disabled={renameBusy}>
                  {renameBusy ? 'Saving\u2026' : 'Save'}
                </button>
                <button type="button" onClick={() => setRenaming(false)} disabled={renameBusy}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="board-title">
                <h1 title={selectedBoard.repoPath}>{selectedBoard.name}</h1>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => startRename()}
                  title="Rename this board in tBoard. The folder on disk is not changed."
                >
                  Rename
                </button>
              </div>
            )
          ) : (
            <h1>No board selected</h1>
          )}
          {selectedBoard ? (
            <p className="repo-path">
              <span title={selectedBoard.repoPath}>{selectedBoard.repoPath}</span>
              {currentBranch ? <span className="checked-out">on {currentBranch}</span> : null}
            </p>
          ) : null}
        </div>

        <div className="topbar-controls">
          {boards.length > 0 ? (
            <label className="field inline">
              <span>Board</span>
              <select
                value={selectedBoardId ?? ''}
                onChange={(event) => setSelectedBoardId(Number(event.target.value))}
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedBoard ? (
            <label className="field inline">
              <span>Branch</span>
              <select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}>
                <option value={FILTER_ALL}>All Branches</option>
                {hasUnbranchedCards ? <option value={FILTER_NONE}>No Branch</option> : null}
                {branchOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedBoard ? (
            <label className="field inline">
              <span>Module</span>
              <select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}>
                <option value={FILTER_ALL}>All Modules</option>
                {hasUnmoduledCards ? <option value={FILTER_NONE}>No Module</option> : null}
                {moduleOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedBoard ? (
            <label className="field inline narrow">
              <span>Type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value={FILTER_ALL}>All Types</option>
                {CARD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {humanizeLabel(type)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedBoard ? (
            <button
              type="button"
              onClick={() => void refreshRepoMetaNow()}
              disabled={refreshingRepo}
              title="Re-read branches and modules from the repo"
            >
              {refreshingRepo ? 'Rescanning…' : 'Rescan repo'}
            </button>
          ) : null}

          <button type="button" className="primary" onClick={() => void addBoard()} disabled={addingBoard}>
            {addingBoard ? 'Adding\u2026' : 'Add Repo'}
          </button>

          {window.tBoard.connection ? (
            <div className="remote-anchor">
              <button
                type="button"
                className="quiet remote-trigger"
                ref={remoteTriggerRef}
                onClick={() => (remoteOpen ? setRemoteOpen(false) : openRemotePopover())}
                aria-expanded={remoteOpen}
                aria-haspopup="dialog"
                title="Connect this app to a self-hosted tBoard server"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="1em"
                  height="1em"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6.5 19a4.5 4.5 0 0 1-.5-8.97 6 6 0 0 1 11.66-1.2A4 4 0 0 1 18 19z" />
                </svg>
                Connect Remote
              </button>
              {remoteOpen ? renderRemotePopover() : null}
            </div>
          ) : null}

          {selectedBoard ? (
            removeArmed ? (
              <span className="remove-confirm">
                <span>Remove board and its cards?</span>
                <button type="button" className="danger" onClick={() => void removeBoard()} disabled={removingBoard}>
                  {removingBoard ? 'Removing\u2026' : 'Remove'}
                </button>
                <button type="button" onClick={() => setRemoveArmed(false)} disabled={removingBoard}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="quiet" onClick={() => setRemoveArmed(true)}>
                Remove Board
              </button>
            )
          ) : null}
        </div>
      </header>
    );
  }

  function renderRemotePopover() {
    return (
      <div
        className="remote-popover"
        ref={remoteRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect to remote board"
      >
        <h2>Connect to a Remote Board</h2>
        <p className="remote-note">
          Point this app at your self-hosted tBoard server. Local boards stay on this machine and remain the
          default.
        </p>
        <label className="field">
          <span>Server Address</span>
          <input
            ref={remoteInputRef}
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void connectRemote();
              }
            }}
            placeholder="https://board.example.com"
            type="url"
            spellCheck={false}
            autoComplete="off"
            disabled={remoteBusy}
          />
        </label>
        {remoteError ? (
          <p className="error remote-error" role="alert">
            {remoteError}
          </p>
        ) : null}
        <div className="remote-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void connectRemote()}
            disabled={remoteBusy || remoteUrl.trim() === ''}
          >
            {remoteBusy ? 'Connecting\u2026' : 'Connect'}
          </button>
          <button type="button" onClick={() => setRemoteOpen(false)} disabled={remoteBusy}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderComposer() {
    return (
      <div
        className="card-composer"
        ref={composerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add card"
      >
        <label className="field grow">
          <span>Title</span>
          <input
            ref={composerTitleRef}
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void createCard();
              }
            }}
            placeholder="Card title"
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            className="composer-description"
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            rows={3}
            placeholder="Description (optional)"
          />
        </label>
        <div className="composer-row">
          <label className="field">
            <span>Type</span>
            <select value={newType} onChange={(event) => setNewType(event.target.value as CardType)}>
              {CARD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {humanizeLabel(type)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select value={newPriority} onChange={(event) => setNewPriority(event.target.value as CardPriority)}>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {humanizeLabel(priority)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Branch</span>
          {renderBranchField(newBranch, (next) => {
            setComposerBranchTouched(true);
            setNewBranch(next);
          })}
        </label>
        <label className="field">
          <span>Module</span>
          {renderModuleField(newModule, setNewModule)}
        </label>
        <div className="composer-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void createCard()}
            disabled={creating || newTitle.trim() === ''}
          >
            {creating ? 'Adding\u2026' : 'Add Card'}
          </button>
          <button type="button" onClick={() => setComposerOpen(false)} disabled={creating}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function clearFilters(): void {
    setBranchFilter(FILTER_ALL);
    setModuleFilter(FILTER_ALL);
    setTypeFilter(FILTER_ALL);
  }

  function renderBoardEmptyNote() {
    if (cards.length === 0) {
      return (
        <p className="empty">
          No cards yet.{' '}
          <button type="button" className="link-button" onClick={() => setComposerOpen(true)}>
            Add a card
          </button>{' '}
          to get started.
        </p>
      );
    }
    if (visibleCards.length === 0) {
      return (
        <p className="empty">
          No cards match the current filters.{' '}
          <button type="button" className="link-button" onClick={() => clearFilters()}>
            Clear filters
          </button>
        </p>
      );
    }
    return null;
  }

  function renderBoard() {
    if (!selectedBoard) {
      return null;
    }
    return (
      <section className="board-panel">
        <div className="board-bar">
          <span className="board-count">
            {visibleCards.length === cards.length
              ? `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`
              : `${visibleCards.length} of ${cards.length} cards`}
          </span>
          <div className="composer-anchor">
            <button
              type="button"
              className="primary add-card"
              ref={composerTriggerRef}
              onClick={() => setComposerOpen((open) => !open)}
              aria-label="Add card"
              aria-expanded={composerOpen}
              aria-haspopup="dialog"
              title="Add card"
            >
              <span aria-hidden="true">+</span>
            </button>
            {composerOpen ? renderComposer() : null}
          </div>
        </div>
        {cardError ? <p className="error">{cardError}</p> : null}
        {branchError ? (
          <p className="branch-warning">
            Could not read branches from this repo: {branchError} You can still type a branch name by hand.
          </p>
        ) : null}
        {renderBoardEmptyNote()}

        <div className="kanban" ref={kanbanRef}>
          {STATUSES.map((status) => {
            const columnCards = cardsByStatus.get(status) ?? [];
            const isDropTarget = dragCardId !== null && dropSpot?.status === status;
            return (
              <div
                className={`column${isDropTarget ? ' is-drop-target' : ''}`}
                key={status}
                onDragOver={(event) => onColumnDragOver(event, status)}
                onDrop={(event) => onColumnDrop(event, status)}
              >
                <h3>
                  {humanizeLabel(status)}
                  <span className="count">{columnCards.length}</span>
                </h3>
                {columnCards.map((card, index) => (
                  <article
                    className={`card task-card priority-edge-${card.priority}${
                      selectedCardId === card.id ? ' is-open' : ''
                    }${dragCardId === card.id ? ' is-dragging' : ''}${
                      isDropTarget && dropSpot?.beforeCardId === card.id ? ' drop-before' : ''
                    }`}
                    key={card.id}
                    draggable
                    onDragStart={(event) => onCardDragStart(event, card)}
                    onDragEnd={() => onCardDragEnd()}
                    onDragOver={(event) => onCardDragOver(event, card, index)}
                  >
                    <button type="button" className="card-open" onClick={() => openCardDetail(card)}>
                      {card.title}
                    </button>
                    {/* One clamped line so a card with notes reads differently
                        from one without, without growing the card. */}
                    {card.description?.trim() ? (
                      <p className="card-note" title={card.description}>
                        {card.description}
                      </p>
                    ) : null}
                    <div className="badges">
                      <TypeBadge type={card.type} />
                      {card.branch ? <BranchBadge branch={card.branch} /> : null}
                      {card.module ? <ModuleBadge module={card.module} /> : null}
                      <small className={`priority-${card.priority}`}>{humanizeLabel(card.priority)}</small>
                      {card.source === 'mcp' ? <small className="source-mcp">MCP</small> : null}
                    </div>
                    <select
                      className="card-status"
                      value={card.status}
                      onChange={(event) => void moveCard(card.id, event.target.value as CardStatus)}
                      disabled={movingCardId === card.id}
                      aria-label={`Status for ${card.title}`}
                    >
                      {STATUSES.map((option) => (
                        <option key={option} value={option}>
                          {humanizeLabel(option)}
                        </option>
                      ))}
                    </select>
                  </article>
                ))}
                {/* End-of-column marker doubles as the drop zone for an empty column. */}
                {isDropTarget && dropSpot?.beforeCardId === null ? <div className="drop-tail" /> : null}
                {columnCards.length === 0 && !isDropTarget ? <p className="column-empty">&mdash;</p> : null}
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function renderNoBoards() {
    return (
      <section className="board-panel">
        <div className="empty-state">
          <h2>No boards yet</h2>
          <p>Add a repo to create your first board. Each repo gets its own board, and cards track a git branch.</p>
          <button type="button" className="primary" onClick={() => void addBoard()} disabled={addingBoard}>
            {addingBoard ? 'Adding\u2026' : 'Add Repo'}
          </button>
        </div>
      </section>
    );
  }

  function renderDrawer() {
    if (!selectedCard) {
      return null;
    }
    return (
      <div className="drawer-overlay" role="presentation" onClick={() => closeCardDetail()}>
        <aside
          className="drawer"
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="card-drawer-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="drawer-header">
            <div>
              <p>
                {humanizeLabel(selectedCard.status)} &middot; updated {formatTimestamp(selectedCard.updatedAt)}
              </p>
              <h2 id="card-drawer-title">{selectedCard.title}</h2>
              <div className="badges">
                <TypeBadge type={selectedCard.type} />
                {selectedCard.branch ? <BranchBadge branch={selectedCard.branch} /> : null}
                {selectedCard.module ? <ModuleBadge module={selectedCard.module} /> : null}
              </div>
            </div>
            <button
              type="button"
              className="drawer-close"
              ref={drawerCloseRef}
              onClick={() => closeCardDetail()}
              aria-label="Close card"
            >
              &times;
            </button>
          </div>

          <div className="drawer-body">
            <div className="drawer-section">
              <h3>Edit</h3>
              <label className="drawer-field field">
                <span>Title</span>
                <input value={detailTitle} onChange={(event) => setDetailTitle(event.target.value)} />
              </label>
              <label className="drawer-field field">
                <span>Description</span>
                <textarea
                  value={detailDescription}
                  onChange={(event) => setDetailDescription(event.target.value)}
                  rows={5}
                  placeholder="Optional notes"
                />
              </label>
              <div className="drawer-row">
                <label className="drawer-field field">
                  <span>Type</span>
                  <select value={detailType} onChange={(event) => setDetailType(event.target.value as CardType)}>
                    {CARD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {humanizeLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="drawer-field field">
                  <span>Status</span>
                  <select value={detailStatus} onChange={(event) => setDetailStatus(event.target.value as CardStatus)}>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {humanizeLabel(status)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="drawer-field field">
                  <span>Priority</span>
                  <select
                    value={detailPriority}
                    onChange={(event) => setDetailPriority(event.target.value as CardPriority)}
                  >
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {humanizeLabel(priority)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="drawer-row pair">
                <label className="drawer-field field">
                  <span>Branch</span>
                  {renderBranchField(detailBranch, setDetailBranch)}
                </label>
                <label className="drawer-field field">
                  <span>Module</span>
                  {renderModuleField(detailModule, setDetailModule)}
                </label>
              </div>

              {detailError ? <p className="error">{detailError}</p> : null}

              <div className="drawer-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void saveCardDetail()}
                  disabled={detailBusy || !detailDirty}
                >
                  {detailBusy ? 'Saving\u2026' : 'Save Changes'}
                </button>
                <button type="button" onClick={() => resetCardDetail()} disabled={detailBusy || !detailDirty}>
                  Discard
                </button>
              </div>
            </div>

            <div className="drawer-section">
              <h3>Details</h3>
              <dl className="drawer-meta">
                <div>
                  <dt>Type</dt>
                  <dd>{humanizeLabel(selectedCard.type)}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{selectedCard.branch ?? 'Not set'}</dd>
                </div>
                <div>
                  <dt>Module</dt>
                  <dd>{selectedCard.module ?? 'Not set'}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{humanizeLabel(selectedCard.source)}</dd>
                </div>
                <div>
                  <dt>Created By</dt>
                  <dd>{selectedCard.createdBy}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatTimestamp(selectedCard.createdAt)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatTimestamp(selectedCard.updatedAt)}</dd>
                </div>
                {selectedCard.completedAt ? (
                  <div>
                    <dt>Completed</dt>
                    <dd>{formatTimestamp(selectedCard.completedAt)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <div className="drawer-section">
              <h3>Delete</h3>
              {deleteArmed ? (
                <div className="drawer-actions">
                  <span className="danger-prompt">Delete this card permanently?</span>
                  <button type="button" className="danger" onClick={() => void deleteCard()} disabled={detailBusy}>
                    {detailBusy ? 'Deleting\u2026' : 'Delete Card'}
                  </button>
                  <button type="button" onClick={() => setDeleteArmed(false)} disabled={detailBusy}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="drawer-actions">
                  <button type="button" className="quiet" onClick={() => setDeleteArmed(true)} disabled={detailBusy}>
                    Delete Card
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <main className="app-shell">
      {renderTopbar()}
      {boardError ? <p className="error banner-error">{boardError}</p> : null}
      {!boardsLoaded ? (
        <p className="empty">Loading boards&hellip;</p>
      ) : boards.length === 0 ? (
        renderNoBoards()
      ) : (
        renderBoard()
      )}
      {renderDrawer()}
    </main>
  );
}
