import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, LOCAL, TEMP, VIDEO, MODELS, LOSSLESS, PUBLIC, EDGE_PROFILES, inTemp } from '../tools/paths.mjs';

const under = (parent, p) => {
  const rel = path.relative(parent, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

test('every folder is a named folder under local-only/, and temp is under it', () => {
  assert.equal(LOCAL, path.join(ROOT, 'local-only'));
  assert.ok(under(LOCAL, TEMP));
  for (const p of [TEMP, VIDEO, MODELS, LOSSLESS, PUBLIC]) assert.ok(under(LOCAL, p), p);
  assert.equal(new Set([TEMP, VIDEO, MODELS, LOSSLESS, PUBLIC]).size, 5);
  // the public tree is kept material, never in the temp folder
  assert.equal(inTemp(PUBLIC), false);
  // the browsers' profiles: in the temp folder, never the system's (nor the repository, without TEMP)
  assert.ok(inTemp(EDGE_PROFILES), EDGE_PROFILES);
});

test('headless Edge keeps its profile in the project\'s temp folder, not in the system\'s', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'browser.mjs'), 'utf8');
  assert.match(src, /path\.join\(EDGE_PROFILES, `edge-shot-\$\{port\}`\)/);
  assert.doesNotMatch(src, /process\.env\.TEMP|os\.tmpdir|tmpdir\(\)/);
});

test('inTemp takes paths under TEMP and refuses everything else', () => {
  assert.equal(inTemp(path.join(TEMP, 'shots')), true);
  assert.equal(inTemp(path.join(TEMP, 'a', 'b', 'c.png')), true);
  assert.equal(inTemp(path.join('local-only', 'temp', 'shots')), true); // relative: from ROOT
  assert.equal(inTemp(TEMP), false); // TEMP itself is not "under" it
  assert.equal(inTemp(LOCAL), false);
  assert.equal(inTemp(VIDEO), false);
  assert.equal(inTemp(path.join(ROOT, 'docs', 'review')), false);
  assert.equal(inTemp(path.join(TEMP, '..', 'video')), false);
  assert.equal(inTemp(path.join(TEMP, 'a', '..', '..', 'models', 'x')), false);
  assert.equal(inTemp(path.join(ROOT, 'local-only', 'temp-not')), false); // a name that only starts like it
});

test('no tool, test or the Vite config spells the old scratch folder', () => {
  // built from pieces, so that this file does not match itself
  const old = ['asse' + 'ts', 'wo' + 'rk'];
  const forms = [old.join('/'), old.join(path.win32.sep), old.map((s) => `'${s}'`).join(', '), old.map((s) => `"${s}"`).join(', ')];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__pycache__') walk(f);
      } else if (/\.(mjs|js|py)$/.test(e.name)) files.push(f);
    }
  };
  for (const d of ['tools', 'src', 'test']) walk(path.join(ROOT, d));
  files.push(path.join(ROOT, 'vite.config.js'));
  const hits = files.filter((f) => {
    const text = fs.readFileSync(f, 'utf8');
    return forms.some((x) => text.includes(x));
  });
  assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), []);
});
