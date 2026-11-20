import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRetry } from '../src/assets.js';

// A stand-in for fetch: each call takes the next step of the script (the last one repeats).
//   'reject'            no answer (fetch rejects, as for net::ERR_ABORTED)
//   { status, type, body, bodyFails }   an answer; bodyFails: reading its body rejects
function fakeFetch(script) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const s = script[Math.min(calls.length - 1, script.length - 1)];
    if (s === 'reject') throw new TypeError('Failed to fetch');
    return {
      ok: s.status >= 200 && s.status < 300,
      status: s.status,
      statusText: s.statusText || '',
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? s.type : null) },
      blob: async () => {
        if (s.bodyFails) throw new TypeError('network error');
        return new Blob([s.body || '']);
      },
    };
  };
  return { fn, calls };
}
const ok = (body = '{"a":1}', type = 'application/json') => ({ status: 200, type, body });
const quiet = () => {
  const said = [];
  return { warn: (...a) => said.push(a.join(' ')), said };
};

test('fetchRetry: a request that gets no answer is sent once more, with a warning naming the file', async () => {
  const f = fakeFetch(['reject', ok('{"x":2}')]);
  const w = quiet();
  const r = await fetchRetry('/score.json', { fetch: f.fn, warn: w.warn, wait: 0 });
  assert.deepEqual(f.calls, ['/score.json', '/score.json']);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/json');
  assert.equal(await r.blob.text(), '{"x":2}');
  assert.equal(w.said.length, 1);
  assert.ok(w.said[0].includes('/score.json') && w.said[0].includes('Failed to fetch'), w.said[0]);
});

test('fetchRetry: a body cut off while it is read is fetched again (the read is inside the retried part)', async () => {
  const f = fakeFetch([{ ...ok(), bodyFails: true }, ok('RIFF')]);
  const w = quiet();
  const r = await fetchRetry('/collage/b01_002.webp', { fetch: f.fn, warn: w.warn, wait: 0 });
  assert.equal(f.calls.length, 2);
  assert.equal(await r.blob.text(), 'RIFF');
  assert.equal(w.said.length, 1);
  assert.ok(w.said[0].includes('/collage/b01_002.webp'), w.said[0]);
});

test('fetchRetry: after one retry it gives up with an error naming the file and the tries', async () => {
  const f = fakeFetch(['reject']);
  const w = quiet();
  await assert.rejects(fetchRetry('/key_hires.png', { fetch: f.fn, warn: w.warn, wait: 0 }), (e) => {
    assert.ok(e.message.includes('/key_hires.png') && e.message.includes('tried 2 times'), e.message);
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert.equal(w.said.length, 1);
  const g = fakeFetch([{ ...ok(), bodyFails: true }]);
  await assert.rejects(fetchRetry('/x.json', { fetch: g.fn, warn: () => {}, wait: 0 }), /\/x\.json.*tried 2 times/);
});

test('fetchRetry: an answer is not retried, whatever its status (the caller decides)', async () => {
  const f = fakeFetch([{ status: 404, statusText: 'Not Found', type: 'text/html', body: '<!doctype html>' }]);
  const w = quiet();
  const r = await fetchRetry('/collage/b00_000.webp', { fetch: f.fn, warn: w.warn, wait: 0 });
  assert.equal(f.calls.length, 1);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.statusText, 'Not Found');
  assert.equal(r.type, 'text/html');
  assert.equal(w.said.length, 0);
});
