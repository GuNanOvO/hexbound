import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Policy } from './types.js';

export const APPLICATION_DIRECTORIES: Readonly<Record<string, true>> = {
  app: true, src: true, components: true, hooks: true, lib: true, domain: true,
  server: true, validation: true, env: true, tests: true, test: true, e2e: true,
  scripts: true, tools: true, types: true, prisma: true,
};

/** Application source cannot disappear through tsconfig exclusion. */
export const APPLICATION_SOURCE_DIRECTORIES: Readonly<Record<string, true>> = {
  app: true, src: true, components: true, hooks: true, lib: true, domain: true,
  server: true, validation: true, env: true, types: true,
};

const IGNORED_DIRECTORIES: Readonly<Record<string, true>> = {
  node_modules: true, '.git': true, dist: true, build: true, out: true, coverage: true,
  '.turbo': true, '.vercel': true, '.superpowers': true, '.worktrees': true,
  '.venv': true, venv: true, __pycache__: true, '3rd_lib': true,
};

export function isIgnoredDirectory(name: string): boolean {
  return Object.hasOwn(IGNORED_DIRECTORIES, name) || name === '.next' || name.startsWith('.next-');
}

export function isExcludedSourcePath(policy: Policy, relative: string): boolean {
  return relative.split('/').some(isIgnoredDirectory)
    || policy.generatedPaths.some(item => relative === item || relative.startsWith(item + '/'));
}

const auxiliaryManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();

/** Separate service packages are not additional application source roots. */
export function isAuxiliarySourcePath(root: string, relative: string): boolean {
  const segments = relative.split('/');
  if (Object.hasOwn(APPLICATION_DIRECTORIES, segments[0] ?? '')) return false;
  for (let index = 1; index <= segments.length; index += 1) {
    const directory = segments.slice(0, index).join('/');
    if (!fs.statSync(path.join(root, directory), { throwIfNoEntry: false })?.isDirectory()) break;
    const filename = path.join(root, directory, 'package.json');
    if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) continue;
    const manifest = auxiliaryManifestSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
    if (manifest.dependencies?.['next'] || manifest.devDependencies?.['next']) {
      throw new Error(`Additional Next application package at ${directory}; select a single application root`);
    }
    return true;
  }
  return false;
}

export function rootJavaScriptCommands(scripts: Readonly<Record<string, string>>): ReadonlySet<string> {
  const files = new Set<string>();
  for (const script of Object.values(scripts)) {
    const commands = /(?:^|[;&|]\s*|\s)(?:node|tsx)\s+(?:--[\w-]+(?:=[^\s]+)?\s+)*(["']?)([^\s"';&|]+\.(?:mjs|cjs|js))\1(?=\s|$)/g;
    for (const match of script.matchAll(commands)) {
      const filename = match[2];
      if (filename) files.add(path.posix.normalize(filename));
    }
  }
  return files;
}

export function isToolingJavaScript(relative: string, commands: ReadonlySet<string>): boolean {
  if (!/\.(?:js|mjs|cjs)$/.test(relative)) return false;
  if (/^(?:tools|scripts|tests|test|e2e)\//.test(relative)) return true;
  if (/^[^/]+\.config\.(?:js|mjs|cjs)$/.test(relative)) return true;
  return !relative.includes('/') && commands.has(relative);
}
