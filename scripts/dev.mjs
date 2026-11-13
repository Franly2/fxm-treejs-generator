import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], { stdio: 'inherit', cwd: root });
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
  stdio: 'inherit',
  cwd: root,
});

const stop = () => {
  server.kill();
  vite.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', () => vite.kill());
vite.on('exit', () => server.kill());

