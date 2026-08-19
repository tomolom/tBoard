// Shared types between the Electron main process, preload bridge, renderer, and
// the standalone MCP server. tBoard is a Kanban board PER GIT REPO: a board is a
// git repo the user adds, cards belong to a board and carry a git branch.

export type CardStatus = 'backlog' | 'in_progress' | 'in_review' | 'done';

/** Lightweight card categorization. */
export type CardType = 'task' | 'bug' | 'feature';

export type CardPriority = 'low' | 'normal' | 'high' | 'urgent';

/** How a card entered the board. */
export type CardSource = 'manual' | 'mcp';

/** A board is one git repo the user added. */
export type BoardDto = {
  id: number;
  name: string;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
};

export type AddBoardInput = {
  /** Absolute path to a git repository. */
  repoPath: string;
  /** Optional display name; defaults to the repo folder name. */
  name?: string;
};

export type AddBoardResult = {
  board: BoardDto | null;
  error: string | null;
};

/** A git branch discovered in a board's repo. */
export type BranchDto = {
  name: string;
  /** True for the branch currently checked out in the repo. */
  current: boolean;
};

export type BranchListResult = {
  branches: BranchDto[];
  current: string | null;
  error: string | null;
};

export type CardDto = {
  id: number;
  boardId: number;
  title: string;
  description: string | null;
  type: CardType;
  status: CardStatus;
  priority: CardPriority;
  /** Git branch this card is associated with, or null. */
  branch: string | null;
  /** Repo subfolder (module) this card relates to, or null. */
  module: string | null;
  /** Sort key within its (board, status) column. */
  position: number;
  source: CardSource;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreateCardInput = {
  boardId: number;
  title: string;
  description?: string | null;
  type?: CardType;
  status?: CardStatus;
  priority?: CardPriority;
  branch?: string | null;
  module?: string | null;
  source?: CardSource;
  createdBy?: string;
};

export type UpdateCardInput = {
  title?: string;
  description?: string | null;
  type?: CardType;
  status?: CardStatus;
  priority?: CardPriority;
  branch?: string | null;
  module?: string | null;
};

export type ClipboardWriteResult = {
  copied: boolean;
  error: string | null;
};

/**
 * The API surface exposed to the renderer via the preload bridge
 * (window.tBoard). The renderer never touches fs/db/git directly.
 */
export type TBoardApi = {
  boards: {
    list(): Promise<BoardDto[]>;
    add(input: AddBoardInput): Promise<AddBoardResult>;
    remove(id: number): Promise<void>;
    /** Renames a board (display name only; does not touch the repo). */
    rename(id: number, name: string): Promise<BoardDto>;
    /** Lists local git branches for a board's repo. */
    branches(boardId: number): Promise<BranchListResult>;
    /** Lists discovered repo subfolders (modules) for a board's repo. */
    modules(boardId: number): Promise<string[]>;
    /** Opens a native folder picker; returns the chosen path or null. */
    pickRepoFolder(): Promise<string | null>;
  };
  cards: {
    list(boardId: number): Promise<CardDto[]>;
    create(input: CreateCardInput): Promise<CardDto>;
    update(id: number, input: UpdateCardInput): Promise<CardDto>;
    /**
     * Moves a card to `status` and positions it immediately after
     * `afterCardId` in that column (null/omitted = top of the column).
     */
    move(id: number, status: CardStatus, afterCardId?: number | null): Promise<CardDto>;
    remove(id: number): Promise<void>;
  };
  settings: {
    /** The last-selected board id, for restoring the view on launch. */
    getLastBoardId(): Promise<number | null>;
    setLastBoardId(boardId: number | null): Promise<void>;
  };
  clipboard: {
    /** Copies text to the OS clipboard via the main process. */
    writeText(text: string): Promise<ClipboardWriteResult>;
  };
};
