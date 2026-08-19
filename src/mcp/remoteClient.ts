import type {
  AddBoardInput,
  AddBoardResult,
  BoardDto,
  BranchListResult,
  CardDto,
  CardStatus,
  CreateCardInput,
  UpdateCardInput,
} from '../shared/api';

/**
 * A Node HTTP client for a remote tBoard web server, used by the MCP server's
 * remote mode so a local agent can drive a hosted board (e.g.
 * https://board.example.com) over the same authenticated API the browser uses.
 *
 * Auth mirrors the server contract: log in with the shared password to obtain
 * the __Host- session + CSRF cookies, then send the session cookie on every
 * request and the double-submit CSRF token + exact Origin on mutations.
 */
export class RemoteTBoardClient {
  private readonly origin: string;
  private sessionCookie: string | null = null;
  private csrfToken: string | null = null;

  constructor(baseUrl: string, private readonly password: string) {
    // Normalize to a bare origin; it doubles as the required Origin header.
    this.origin = new URL(baseUrl).origin;
  }

  get label(): string {
    return `remote ${this.origin}`;
  }

  /** Authenticates and caches the session + CSRF cookies. Throws on failure. */
  async login(): Promise<void> {
    const response = await fetch(`${this.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.origin },
      body: JSON.stringify({ password: this.password }),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'Remote login failed: wrong password (check TBOARD_REMOTE_PASSWORD).'
          : `Remote login failed (${response.status}).`,
      );
    }
    const jar = parseSetCookies(response);
    const session = jar['__Host-tboard_session'];
    const csrf = jar['__Host-tboard_csrf'];
    if (!session || !csrf) {
      throw new Error('Remote login did not return the expected session cookies.');
    }
    this.sessionCookie = session;
    this.csrfToken = csrf;
  }

  private cookieHeader(): string {
    return `__Host-tboard_session=${this.sessionCookie}; __Host-tboard_csrf=${this.csrfToken}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.sessionCookie) {
      await this.login();
    }
    const send = (): Promise<Response> => {
      const headers: Record<string, string> = { Cookie: this.cookieHeader() };
      const unsafe = method !== 'GET';
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (unsafe) {
        headers.Origin = this.origin;
        if (this.csrfToken) {
          headers['X-CSRF-Token'] = this.csrfToken;
        }
      }
      return fetch(`${this.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    let response = await send();
    // A stale/expired session — log in once more and retry.
    if (response.status === 401) {
      await this.login();
      response = await send();
    }
    if (!response.ok) {
      let message = `Remote request failed (${response.status})`;
      try {
        const data = (await response.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // keep default
      }
      throw new Error(message);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  listBoards(): Promise<BoardDto[]> {
    return this.request<BoardDto[]>('GET', '/api/boards');
  }

  addBoard(input: AddBoardInput): Promise<AddBoardResult> {
    return this.request<AddBoardResult>('POST', '/api/boards', input);
  }

  branches(boardId: number): Promise<BranchListResult> {
    return this.request<BranchListResult>('GET', `/api/boards/${boardId}/branches`);
  }

  modules(boardId: number): Promise<string[]> {
    return this.request<string[]>('GET', `/api/boards/${boardId}/modules`);
  }

  listCards(boardId: number): Promise<CardDto[]> {
    return this.request<CardDto[]>('GET', `/api/boards/${boardId}/cards`);
  }

  createCard(input: CreateCardInput): Promise<CardDto> {
    return this.request<CardDto>('POST', '/api/cards', input);
  }

  updateCard(id: number, input: UpdateCardInput): Promise<CardDto> {
    return this.request<CardDto>('PATCH', `/api/cards/${id}`, input);
  }

  moveCard(id: number, status: CardStatus, afterCardId?: number | null): Promise<CardDto> {
    return this.request<CardDto>('POST', `/api/cards/${id}/move`, { status, afterCardId: afterCardId ?? null });
  }
}

function parseSetCookies(response: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of lines) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) {
      jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return jar;
}
