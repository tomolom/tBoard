import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'build', 'out', 'target', 'dist', 'bin', 'obj', '.gradle', '.idea', '.vscode']);

const EXCLUDED_FILE_EXTENSIONS = new Set(['.class', '.jar', '.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.pyc', '.zip']);

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_') || EXCLUDED_DIR_NAMES.has(name.toLowerCase());
}

function shouldSkipFile(name: string): boolean {
  return EXCLUDED_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function toRelativePosix(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath).split(path.sep).join('/');
}

export function fromRelativePosix(rootPath: string, relativePath: string): string {
  return path.join(rootPath, ...relativePath.split('/'));
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const contents = await readFile(filePath);
    return createHash('sha256').update(contents).digest('hex');
  } catch {
    return null;
  }
}

export async function walkHashedFileTree(rootPath: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(entryPath);
        }
        continue;
      }

      if (entry.isFile()) {
        if (shouldSkipFile(entry.name)) {
          continue;
        }
        const hash = await hashFile(entryPath);
        if (hash !== null) {
          files.set(toRelativePosix(rootPath, entryPath), hash);
        }
      }
    }
  }

  return files;
}
