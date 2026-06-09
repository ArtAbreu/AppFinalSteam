import { cpSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));
const src = resolve(root, 'frontend', 'dist');
const dest = resolve(root, 'dist');

if (!existsSync(src)) {
  console.error('❌ frontend/dist não encontrado. O build do Vite falhou?');
  process.exit(1);
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}

cpSync(src, dest, { recursive: true });
console.log('✅ dist/ copiado com sucesso');
