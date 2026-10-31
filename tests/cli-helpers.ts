import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve('.');
export function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(packageRoot, 'src/cli.ts'), ...args, '--root', root, '--json'], { cwd: packageRoot, encoding: 'utf8' });
}
export function app(source = 'export default function Page() { return <main>Ready</main>; }') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hexbound-cli-'));
  mkdirSync(path.join(root, 'app'));
  mkdirSync(path.join(root, 'node_modules'));
  for (const name of ['next', 'react', 'react-dom', 'typescript', 'eslint', 'typescript-eslint', 'zod', 'server-only', '@types']) {
    symlinkSync(path.join(packageRoot, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
  }
  symlinkSync(packageRoot, path.join(root, 'node_modules/hexbound'), 'dir');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acceptance-app', private: true, scripts: {}, dependencies: { next: '16.4.3', react: '19.2.0', 'react-dom': '19.2.0' }, devDependencies: { typescript: '6.0.3', eslint: '9.39.5', hexbound: '0.1.0' } }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'acceptance-app', lockfileVersion: 3, packages: {} }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2023', 'DOM'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true }, include: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'], exclude: ['node_modules'] }));
  writeFileSync(path.join(root, 'app/page.tsx'), source);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
