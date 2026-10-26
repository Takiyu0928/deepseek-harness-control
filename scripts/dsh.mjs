#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createTools, TOOLS } from './lib/tools.mjs';
import { redact } from './lib/harness.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

try {
  const [action = '--help', ...rest] = process.argv.slice(2);
  if (action === '--help') {
    console.log('Usage: node dsh.mjs <action> [--input <JSON-file|->]');
    console.log('       node dsh.mjs --describe <action>');
    console.log('\n' + TOOLS.map(t => `${t.name}: ${t.description}`).join('\n'));
  } else if (action === '--describe') {
    if (rest.length !== 1) throw new Error('Expected exactly one action name after --describe.');
    const tool = TOOLS.find(t => t.name === rest[0]);
    if (!tool) throw new Error('Unknown action. Use --help to list actions.');
    console.log(JSON.stringify(tool.inputSchema, null, 2));
  } else {
    if (!TOOLS.some(t => t.name === action)) throw new Error('Unknown action. Use --help to list actions.');
    if (rest.length !== 0 && !(rest.length === 2 && rest[0] === '--input' && rest[1])) throw new Error('Expected --input <JSON-file|->, or no arguments.');
    let args = {};
    if (rest.length) {
      let source;
      if (rest[1] === '-') {
        const chunks = []; let bytes = 0;
        for await (const chunk of process.stdin) {
          bytes += chunk.length;
          if (bytes > MAX_INPUT_BYTES) throw new Error('JSON input exceeds 1 MiB.');
          chunks.push(chunk);
        }
        source = Buffer.concat(chunks).toString('utf8');
      } else {
        if ((await stat(rest[1])).size > MAX_INPUT_BYTES) throw new Error('JSON input exceeds 1 MiB.');
        source = await readFile(rest[1], 'utf8');
      }
      args = JSON.parse(source.replace(/^\uFEFF/, ''));
    }
    const result = await createTools()(action, args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(redact(error.message) + '\n');
  process.exitCode = 1;
}
