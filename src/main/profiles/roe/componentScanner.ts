import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { ScanWarning } from '../../../shared/api';
import { isDirectory, listDirectories } from '../../services/filesystem';
import type { ComponentCandidate, ComponentScan } from '../types';

const EXCLUDED_ROOT_NAMES = new Set([
  'build',
  'gradle',
  'node_modules',
  'out',
  'target',
]);

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_') || EXCLUDED_ROOT_NAMES.has(name.toLowerCase());
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

function unescapeJavaString(value: string): string {
  return value.replace(/\\"/gu, '"').replace(/\\n/gu, '\n').replace(/\\t/gu, '\t');
}

function descriptorNameFromSource(source: string): string | null {
  const annotationIndex = source.indexOf('@PluginDescriptor');
  if (annotationIndex === -1) {
    return null;
  }

  const rest = source.slice(annotationIndex);
  const nameMatch = /\bname\s*=\s*"((?:\\.|[^"\\])*)"/su.exec(rest);
  if (!nameMatch) {
    return null;
  }

  return stripHtml(unescapeJavaString(nameMatch[1]));
}

function packageHintFromSource(source: string): string | null {
  const packageMatch = /package\s+net\.runelite\.client\.plugins\.roe\.([A-Za-z0-9_]+)\s*;/u.exec(source);
  return packageMatch?.[1] ?? null;
}

function fallbackCanonicalName(rootName: string): string {
  return rootName.replace(/^tom_/u, '').toLowerCase();
}

async function findDescriptorFiles(rootPath: string): Promise<string[]> {
  const startPath = path.join(rootPath, 'src', 'main', 'java');
  if (!(await isDirectory(startPath))) {
    return [];
  }

  const files: string[] = [];
  const stack = [startPath];

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

      if (entry.isFile() && entry.name.endsWith('Plugin.java')) {
        files.push(entryPath);
      }
    }
  }

  return files.sort();
}

async function readComponentCandidate(rootPath: string, rootName: string): Promise<ComponentCandidate | null> {
  const descriptorFiles = await findDescriptorFiles(rootPath);

  for (const descriptorPath of descriptorFiles) {
    const source = await readFile(descriptorPath, 'utf8');
    if (!source.includes('@PluginDescriptor')) {
      continue;
    }

    const packageHint = packageHintFromSource(source);
    const descriptorName = descriptorNameFromSource(source);
    const canonicalName = (packageHint ?? fallbackCanonicalName(rootName)).toLowerCase();

    return {
      rootName,
      canonicalName,
      displayName: descriptorName || rootName,
      descriptorName,
      packageHint,
      rootPath,
      descriptorPath,
    };
  }

  return null;
}

export async function scanRoeComponents(repoPath: string, label = repoPath): Promise<ComponentScan> {
  const warnings: ScanWarning[] = [];

  if (!(await isDirectory(repoPath))) {
    return {
      components: [],
      warnings: [
        {
          code: 'repo_missing',
          message: `Repository path does not exist for component scan: ${label}`,
          path: repoPath,
        },
      ],
    };
  }

  const rootNames = (await listDirectories(repoPath)).filter((name) => !shouldSkipDirectory(name));
  const components: ComponentCandidate[] = [];

  for (const rootName of rootNames) {
    const rootPath = path.join(repoPath, rootName);
    const component = await readComponentCandidate(rootPath, rootName);
    if (component) {
      components.push(component);
    }
  }

  return { components, warnings };
}
