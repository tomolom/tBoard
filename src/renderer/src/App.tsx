import { useEffect, useMemo, useRef, useState } from 'react';

import type { BoardDto, BranchDto, CardDto, CardPriority, CardStatus, TBoardApi } from '../../shared/api';
import { useFocusTrap } from './useFocusTrap';

declare global {
  interface Window {
    tBoard: TBoardApi;
  }
}

const STATUSES: CardStatus[] = ['backlog', 'in_progress', 'in_review', 'done'];
const PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Sentinel values for the branch filter — real branch names are used as-is. */
const FILTER_ALL = '\u0000all';
const FILTER_NONE = '\u0000none';

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
    <small className="branch-badge" title={`Branch: ${branch}`}>
      <span aria-hidden="true">&#9095;</span>
      <span className="branch-name">{branch}</span>
    </small>
  );
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

  const [branchFilter, setBranchFilter] = useState<string>(FILTER_ALL);

  const [newTitle, setNewTitle] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [newPriority, setNewPriority] = useState<CardPriority>('normal');
  const [creating, setCreating] = useState(false);

  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [detailTitle, setDetailTitle] = useState('');
  const [detailDescription, setDetailDescription] = useState('');
  const [detailStatus, setDetailStatus] = useState<CardStatus>('backlog');
  const [detailPriority, setDetailPriority] = useState<CardPriority>('normal');
  const [detailBranch, setDetailBranch] = useState('');
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

  const hasUnbranchedCards = useMemo(() => cards.some((card) => card.branch === null), [cards]);

  const visibleCards = useMemo(() => {
    if (branchFilter === FILTER_ALL) {
      return cards;
    }
    if (branchFilter === FILTER_NONE) {
      return cards.filter((card) => card.branch === null);
    }
    return cards.filter((card) => card.branch === branchFilter);
  }, [cards, branchFilter]);

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
      return;
    }
    let cancelled = false;
    setBranchFilter(FILTER_ALL);
    setSelectedCardId(null);
    setCardError(null);

    // Every state write is guarded: switching boards quickly must not let a
    // slower earlier response overwrite the newer board's data.
    async function load(boardId: number): Promise<void> {
      try {
        const [cardList, branchResult] = await Promise.all([
          window.tBoard.cards.list(boardId),
          window.tBoard.boards.branches(boardId),
        ]);
        if (cancelled) {
          return;
        }
        setCards(cardList);
        setBranches(branchResult.branches);
        setCurrentBranch(branchResult.current);
        setBranchError(branchResult.error);
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

  // A filtered-away branch would otherwise hide every card with no way back.
  useEffect(() => {
    if (branchFilter === FILTER_ALL || branchFilter === FILTER_NONE) {
      return;
    }
    if (!branchOptions.includes(branchFilter)) {
      setBranchFilter(FILTER_ALL);
    }
  }, [branchFilter, branchOptions]);

  // Arming is per-board; switching boards must not carry a primed delete over.
  useEffect(() => {
    setRemoveArmed(false);
  }, [selectedBoardId]);

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

  async function createCard(): Promise<void> {
    const title = newTitle.trim();
    if (selectedBoardId === null || title === '') {
      return;
    }
    setCreating(true);
    setCardError(null);
    try {
      const branch = newBranch.trim();
      await window.tBoard.cards.create({
        boardId: selectedBoardId,
        title,
        priority: newPriority,
        branch: branch === '' ? null : branch,
      });
      setNewTitle('');
      await refreshCards(selectedBoardId);
    } catch (createError) {
      setCardError(errorMessage(createError));
    } finally {
      setCreating(false);
    }
  }

  async function moveCard(cardId: number, status: CardStatus): Promise<void> {
    setMovingCardId(cardId);
    setCardError(null);
    try {
      await window.tBoard.cards.move(cardId, status);
      if (selectedBoardId !== null) {
        await refreshCards(selectedBoardId);
      }
    } catch (moveError) {
      setCardError(errorMessage(moveError));
    } finally {
      setMovingCardId(null);
    }
  }

  function openCardDetail(card: CardDto): void {
    setSelectedCardId(card.id);
    setDetailTitle(card.title);
    setDetailDescription(card.description ?? '');
    setDetailStatus(card.status);
    setDetailPriority(card.priority);
    setDetailBranch(card.branch ?? '');
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
      detailBranch !== (selectedCard.branch ?? ''));

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
      const description = detailDescription.trim();
      await window.tBoard.cards.update(selectedCard.id, {
        title,
        description: description === '' ? null : description,
        status: detailStatus,
        priority: detailPriority,
        branch: branch === '' ? null : branch,
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

  function renderTopbar() {
    return (
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">tBoard</p>
          {selectedBoard ? (
            <h1 title={selectedBoard.repoPath}>{selectedBoard.name}</h1>
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

          <button type="button" className="primary" onClick={() => void addBoard()} disabled={addingBoard}>
            {addingBoard ? 'Adding\u2026' : 'Add Repo'}
          </button>

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

  function renderComposer() {
    return (
      <div className="card-composer">
        <label className="field grow">
          <span>New Card</span>
          <input
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
          <span>Branch</span>
          {renderBranchField(newBranch, setNewBranch)}
        </label>
        <label className="field narrow">
          <span>Priority</span>
          <select value={newPriority} onChange={(event) => setNewPriority(event.target.value as CardPriority)}>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {humanizeLabel(priority)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void createCard()}
          disabled={creating || newTitle.trim() === ''}
        >
          {creating ? 'Adding\u2026' : 'Add Card'}
        </button>
      </div>
    );
  }

  function renderBoardEmptyNote() {
    if (cards.length === 0) {
      return <p className="empty">No cards yet. Add one above to get started.</p>;
    }
    if (visibleCards.length === 0) {
      return (
        <p className="empty">
          No cards on this branch.{' '}
          <button type="button" className="link-button" onClick={() => setBranchFilter(FILTER_ALL)}>
            Show all branches
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
        {renderComposer()}
        {cardError ? <p className="error">{cardError}</p> : null}
        {branchError ? (
          <p className="branch-warning">
            Could not read branches from this repo: {branchError} You can still type a branch name by hand.
          </p>
        ) : null}
        {renderBoardEmptyNote()}

        <div className="kanban">
          {STATUSES.map((status) => {
            const columnCards = cardsByStatus.get(status) ?? [];
            return (
              <div className="column" key={status}>
                <h3>
                  {humanizeLabel(status)}
                  <span className="count">{columnCards.length}</span>
                </h3>
                {columnCards.map((card) => (
                  <article
                    className={`card task-card priority-edge-${card.priority}${
                      selectedCardId === card.id ? ' is-open' : ''
                    }`}
                    key={card.id}
                  >
                    <button type="button" className="card-open" onClick={() => openCardDetail(card)}>
                      {card.title}
                    </button>
                    <div className="badges">
                      {card.branch ? <BranchBadge branch={card.branch} /> : null}
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
                {columnCards.length === 0 ? <p className="column-empty">&mdash;</p> : null}
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
              {selectedCard.branch ? <BranchBadge branch={selectedCard.branch} /> : null}
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
                <label className="drawer-field field">
                  <span>Branch</span>
                  {renderBranchField(detailBranch, setDetailBranch)}
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
                  <dt>Branch</dt>
                  <dd>{selectedCard.branch ?? 'Not set'}</dd>
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
