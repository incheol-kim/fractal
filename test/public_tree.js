// The public tree's mark, read in one place by the tests (tools/public_tree.py is the Python side).
// The public repository is generated from a private source repository without what it does not publish
// (among them docs/, prompts/, the reference originals, the DAW project, the mixes, the final WAV among
// them, the original collage pieces in assets/collage/, and the tooling that generates it); the generated
// tree has a file PUBLIC_TREE at its root. A test that needs one of those files skips there, saying what
// is missing, and only there: in the source repository the same absence is a failure, so a skip never
// hides a damaged tree.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = 'PUBLIC_TREE';

// whether root is the public tree (its marker at the root)
export function isPublicTree(root = ROOT) {
  return existsSync(path.join(root, MARKER));
}

// node:test's skip option for a test that needs rel (a path from the root, '/' between folders): in the
// public tree without rel, the reason (rel, the marker and `what`, the words saying what rel is); else
// false, and the test runs (and fails if rel is missing).
export function skipUnpublished(rel, what, root = ROOT) {
  if (!isPublicTree(root) || existsSync(path.join(root, ...rel.split('/')))) return false;
  return `${rel} is not in the public tree (${MARKER}): ${what}`;
}
