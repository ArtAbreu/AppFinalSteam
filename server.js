#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const candidateEntries = [
  path.join(__dirname, 'backend', 'server.cjs'),
  path.join(__dirname, 'server.cjs'),
  path.join(__dirname, 'dist', 'server.cjs')
];

const entry = candidateEntries.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch (error) {
    return false;
  }
});

if (!entry) {
  console.error('\n❌ Não foi possível localizar o servidor. Certifique-se de que o build foi gerado e que o arquivo backend/server.cjs está disponível.');
  process.exit(1);
}

require(entry);
