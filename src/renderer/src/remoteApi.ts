import type {
  AddBoardInput,
  AddBoardResult,
  BoardDto,
  BranchListResult,
  CardDto,
  CardStatus,
  ClipboardWriteResult,
  CreateCardInput,
  TBoardApi,
  UpdateCardInput,
} from '../../shared/api';

/**
 * An HTTP-backed implementation of the same `TBoardApi` the Electron preload
 * exposes. Injected as `window.tBoard` when the renderer runs in a browser
 * (served by src/server), so the entire board UI runs unchanged over HTTP.
 *
 * Auth is the server's session cookie (same-origin). Mutations send the
 * double-submit CSRF token read from the non-HttpOnly `__Host-tboard_csrf`
 * cookie. Live updates use SSE. Web-only limitations: `pickRepoFolder` has no
 * native dialog (returns null → the UI falls back to typing a path), and
 * clipboard uses the browser API.
 */

const CSRF_COOKIE = '__Host-tboard_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export type RemoteAuth = {
  checkSession(): Promise<boolean>;
  login(password: string): Promise<{ ok: boolean; error: string | null }>;
  logout(): Promise<void>;
};

export type RemoteClient = TBoardApi & { auth: RemoteAuth };

export function createRemoteApi(baseUrl = '', onUnauthorized?: () => void): RemoteClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const unsafe = method !== 'GET' && method !== 'HEAD';
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (unsafe) {
      const token = readCookie(CSRF_COOKIE);
      if (token) {
        headers[CSRF_HEADER] = token;
      }
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      // A session that expired mid-use should bounce back to the login gate,
      // but the session/login endpoints report auth state normally.
      if (onUnauthorized && path !== '/api/session' && path !== '/api/login') {
        onUnauthorized();
      }
      throw new UnauthorizedError();
    }
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
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

  return {
    boards: {
      list: () => request<BoardDto[]>('GET', '/api/boards'),
      add: (input: AddBoardInput) => request<AddBoardResult>('POST', '/api/boards', input),
      remove: async (id: number) => {
        await request<{ ok: true }>('DELETE', `/api/boards/${id}`);
      },
      rename: (id: number, name: string) => request<BoardDto>('PATCH', `/api/boards/${id}`, { name }),
      branches: (boardId: number) => request<BranchListResult>('GET', `/api/boards/${boardId}/branches`),
      modules: (boardId: number) => request<string[]>('GET', `/api/boards/${boardId}/modules`),
      // No native folder dialog on the web; the composer falls back to typing.
      pickRepoFolder: () => Promise.resolve(null),
    },
    cards: {
      list: (boardId: number) => request<CardDto[]>('GET', `/api/boards/${boardId}/cards`),
      create: (input: CreateCardInput) => request<CardDto>('POST', '/api/cards', input),
      update: (id: number, input: UpdateCardInput) => request<CardDto>('PATCH', `/api/cards/${id}`, input),
      move: (id: number, status: CardStatus, afterCardId?: number | null) =>
        request<CardDto>('POST', `/api/cards/${id}/move`, { status, afterCardId: afterCardId ?? null }),
      remove: async (id: number) => {
        await request<{ ok: true }>('DELETE', `/api/cards/${id}`);
      },
    },
    settings: {
      getLastBoardId: async () => (await request<{ boardId: number | null }>('GET', '/api/settings/last-board')).boardId,
      setLastBoardId: async (boardId: number | null) => {
        await request<{ ok: true }>('PUT', '/api/settings/last-board', { boardId });
      },
    },
    clipboard: {
      writeText: async (text: string): Promise<ClipboardWriteResult> => {
        try {
          await navigator.clipboard.writeText(text);
          return { copied: true, error: null };
        } catch (error) {
          return { copied: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    onDbChanged: (callback: () => void) => {
      const source = new EventSource(`${baseUrl}/api/events`, { withCredentials: true });
      source.addEventListener('db-changed', () => callback());
      return () => source.close();
    },
    auth: {
      checkSession: async () => (await request<{ authenticated: boolean }>('GET', '/api/session')).authenticated,
      login: async (password: string) => {
        try {
          await request<{ ok: true }>('POST', '/api/login', { password });
          return { ok: true, error: null };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'Login failed' };
        }
      },
      logout: async () => {
        await request<{ ok: true }>('POST', '/api/logout');
      },
    },
  };
}
