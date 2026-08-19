// Shared types between the Electron main process, preload bridge, renderer, and
// the standalone MCP server. tBoard is a Kanban board PER GIT REPO: a board is a
// git repo the user adds, cards belong to a board and carry a git branch.

export type CardStatus = 'backlog' | 'in_progress' | 'in_review' | 'done';

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
  status: CardStatus;
  priority: CardPriority;
  /** Git branch this card is associated with, or null. */
  branch: string | null;
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
  status?: CardStatus;
  priority?: CardPriority;
  branch?: string | null;
  source?: CardSource;
  createdBy?: string;
};

export type UpdateCardInput = {
  title?: string;
  description?: string | null;
  status?: CardStatus;
  priority?: CardPriority;
  branch?: string | null;
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
    /** Lists local git branches for a board's repo. */
    branches(boardId: number): Promise<BranchListResult>;
    /** Opens a native folder picker; returns the chosen path or null. */
    pickRepoFolder(): Promise<string | null>;
  };
  cards: {
    list(boardId: number): Promise<CardDto[]>;
    create(input: CreateCardInput): Promise<CardDto>;
    update(id: number, input: UpdateCardInput): Promise<CardDto>;
    move(id: number, status: CardStatus): Promise<CardDto>;
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
