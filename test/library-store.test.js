import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CloudStore } from '../cloud/lib/store.js';

const DOC_A = 'a'.repeat(32);
const DOC_B = 'b'.repeat(32);

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modu-library-store-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const store = await new CloudStore(root, { maxDocBytes: 64 * 1024 }).init();
  const alice = await store.addUser('alice', 'correct horse battery');
  const bob = await store.addUser('bob', 'another good password');
  return { root, store, alice: alice.user, bob: bob.user };
}

async function expectError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.stack);
    assert.equal(error.status, status, error.stack);
    return true;
  });
}

test('legacy absence is an empty read without creating a library file', async (t) => {
  const { root, store, alice } = await setup(t);
  const library = await store.getLibrary(alice.id);
  assert.deepEqual(library, { revision: 0, folders: [], assignments: {} });
  assert.equal('version' in library, false, 'storage version must not leak into the API payload');
  assert.equal(
    await fsp.access(path.join(root, 'libraries', `${alice.id}.json`)).then(() => true, () => false),
    false,
    'reading a legacy account must not create a library file',
  );
  assert.equal(
    await fsp.access(path.join(root, 'libraries')).then(() => true, () => false),
    false,
    'reading a legacy account must not create a library directory',
  );

  const created = await store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: '  工作  ',
    parentId: null,
  });
  assert.equal(created.revision, 1);
  assert.equal(created.folders.length, 1);
  assert.equal(created.folders[0].name, '工作', 'folder names are stored trimmed');
  assert.equal(created.folders[0].parentId, null);
  assert.deepEqual(created.assignments, {});

  // A second store instance (for example after a server restart) sees the same
  // committed data.
  const restarted = await new CloudStore(root).init();
  assert.deepEqual(await restarted.getLibrary(alice.id), created);
});

test('folder validation covers names, parents, duplicates, depth and the 200 folder cap', async (t) => {
  const { store, alice } = await setup(t);
  const library = await store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Root',
    parentId: null,
  });
  const rootFolder = library.folders[0];

  await expectError(store.mutateLibrary(alice.id, {
    revision: library.revision,
    action: 'createFolder',
    name: 'Root',
    parentId: null,
  }), 'FOLDER_EXISTS', 409);

  for (const badName of ['', '   ', 'a/b', 'a\\b', 'a\u0000b', 'x'.repeat(81), 42, null]) {
    await expectError(store.mutateLibrary(alice.id, {
      revision: library.revision,
      action: 'createFolder',
      name: badName,
      parentId: null,
    }), 'INVALID_NAME', 400);
  }

  await expectError(store.mutateLibrary(alice.id, {
    revision: library.revision,
    action: 'createFolder',
    name: 'orphan',
    parentId: 'f'.repeat(16),
  }), 'FOLDER_NOT_FOUND', 404);

  let current = await store.mutateLibrary(alice.id, {
    revision: library.revision,
    action: 'createFolder',
    name: 'Child',
    parentId: rootFolder.id,
  });
  const child = current.folders.find((folder) => folder.name === 'Child');
  await expectError(store.mutateLibrary(alice.id, {
    revision: current.revision,
    action: 'createFolder',
    name: 'Child',
    parentId: rootFolder.id,
  }), 'FOLDER_EXISTS', 409);

  // Root is level 1, so a chain of eight folders is allowed and the ninth is
  // rejected. Depth is also rechecked when moving a whole subtree.
  let parentId = child.id;
  for (let depth = 3; depth <= 8; depth += 1) {
    current = await store.mutateLibrary(alice.id, {
      revision: current.revision,
      action: 'createFolder',
      name: `Level ${depth}`,
      parentId,
    });
    parentId = current.folders.find((folder) => folder.name === `Level ${depth}`).id;
  }
  await expectError(store.mutateLibrary(alice.id, {
    revision: current.revision,
    action: 'createFolder',
    name: 'Level 9',
    parentId,
  }), 'FOLDER_DEPTH_EXCEEDED', 400);

  // Fill the remaining slots and verify the cap, using a fresh account so the
  // depth test above cannot interfere.
  const carol = await store.addUser('carol', 'carol good password');
  let state = await store.getLibrary(carol.user.id);
  for (let index = 0; index < 200; index += 1) {
    state = await store.mutateLibrary(carol.user.id, {
      revision: state.revision,
      action: 'createFolder',
      name: `Folder ${index}`,
      parentId: null,
    });
  }
  assert.equal(state.folders.length, 200);
  await expectError(store.mutateLibrary(carol.user.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'One too many',
    parentId: null,
  }), 'LIBRARY_FULL', 400);
});

test('cycles and invalid moves are rejected, and deletes reparent without touching documents', async (t) => {
  const { store, alice, bob } = await setup(t);
  await store.upsertDocument(alice.id, DOC_A, { name: 'a.md', markdown: '# A\n' });
  await store.upsertDocument(alice.id, DOC_B, { name: 'b.html', kind: 'html', content: '<h1>B</h1>' });

  let state = await store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Parent',
    parentId: null,
  });
  const parent = state.folders[0];
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'Child',
    parentId: parent.id,
  });
  const child = state.folders.find((folder) => folder.name === 'Child');
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'Grandchild',
    parentId: child.id,
  });
  const grandchild = state.folders.find((folder) => folder.name === 'Grandchild');

  await expectError(store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'moveFolder',
    folderId: parent.id,
    parentId: parent.id,
  }), 'CYCLE', 400);
  await expectError(store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'moveFolder',
    folderId: parent.id,
    parentId: grandchild.id,
  }), 'CYCLE', 400);
  await expectError(store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'moveFolder',
    folderId: 'f'.repeat(16),
    parentId: null,
  }), 'FOLDER_NOT_FOUND', 404);
  await expectError(store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'renameFolder',
    folderId: 'f'.repeat(16),
    name: 'Nope',
  }), 'FOLDER_NOT_FOUND', 404);

  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'moveDocument',
    docId: DOC_A,
    folderId: child.id,
  });
  assert.equal(state.assignments[DOC_A], child.id);

  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'moveDocument',
    docId: DOC_B,
    folderId: parent.id,
  });
  assert.equal(state.assignments[DOC_B], parent.id);

  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'deleteFolder',
    folderId: child.id,
  });
  assert.equal(state.folders.some((folder) => folder.id === child.id), false);
  assert.equal(state.folders.find((folder) => folder.id === grandchild.id).parentId, parent.id);
  assert.equal(state.assignments[DOC_A], parent.id, 'directly assigned docs move up one level');

  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'deleteFolder',
    folderId: parent.id,
  });
  assert.deepEqual(state.folders, [{ id: grandchild.id, name: 'Grandchild', parentId: null }]);
  assert.deepEqual(state.assignments, {}, 'deleting a root folder clears assignments to root/unfiled');
  assert.deepEqual(
    (await store.listDocuments(alice.id)).map((doc) => doc.id).sort(),
    [DOC_A, DOC_B].sort(),
    'deleting folders must never delete documents',
  );

  // Sibling-name collision while reparenting is rejected before any mutation.
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'Left',
    parentId: null,
  });
  const left = state.folders.find((folder) => folder.name === 'Left');
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'Same',
    parentId: left.id,
  });
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'Right',
    parentId: left.id,
  });
  const right = state.folders.find((folder) => folder.name === 'Right');
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'createFolder',
    name: 'Same',
    parentId: right.id,
  });
  const beforeDelete = state;
  await expectError(store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'deleteFolder',
    folderId: right.id,
  }), 'FOLDER_EXISTS', 409);
  assert.deepEqual(await store.getLibrary(alice.id), beforeDelete, 'failed delete must not mutate');

  // Assignment checks reject unknown docs, and every folder lookup is scoped to
  // the authenticated user's own library.
  await expectError(store.mutateLibrary(alice.id, {
    revision: beforeDelete.revision,
    action: 'moveDocument',
    docId: 'c'.repeat(32),
    folderId: left.id,
  }), 'DOCUMENT_NOT_FOUND', 404);
  await expectError(store.mutateLibrary(alice.id, {
    revision: beforeDelete.revision,
    action: 'moveDocument',
    docId: DOC_A,
    folderId: 'e'.repeat(16),
  }), 'FOLDER_NOT_FOUND', 404);
  await expectError(store.mutateLibrary(bob.id, {
    revision: 0,
    action: 'renameFolder',
    folderId: left.id,
    name: 'Stolen',
  }), 'FOLDER_NOT_FOUND', 404);
  await expectError(store.mutateLibrary(bob.id, {
    revision: 0,
    action: 'moveDocument',
    docId: DOC_A,
    folderId: null,
  }), 'DOCUMENT_NOT_FOUND', 404);
});

test('stale revisions conflict without mutation and concurrent edits have one winner', async (t) => {
  const { store, alice } = await setup(t);
  const first = await store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Base',
    parentId: null,
  });
  await expectError(store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Stale',
    parentId: null,
  }), 'LIBRARY_CONFLICT', 409);
  assert.deepEqual(await store.getLibrary(alice.id), first);

  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => store.mutateLibrary(alice.id, {
      revision: first.revision,
      action: 'createFolder',
      name: `Concurrent ${index}`,
      parentId: null,
    })),
  );
  const winners = attempts.filter((entry) => entry.status === 'fulfilled');
  const conflicts = attempts.filter((entry) => (
    entry.status === 'rejected' && entry.reason.code === 'LIBRARY_CONFLICT'
  ));
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 11);

  const final = await store.getLibrary(alice.id);
  assert.equal(final.revision, first.revision + 1);
  assert.equal(final.folders.length, 2);
  assert.equal(final.folders.filter((folder) => folder.name.startsWith('Concurrent')).length, 1);
});

test('document upload and position writes never overwrite library organization', async (t) => {
  const { store, alice } = await setup(t);
  await store.upsertDocument(alice.id, DOC_A, { name: 'a.md', markdown: '# One\n' });
  let state = await store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Work',
    parentId: null,
  });
  const work = state.folders[0];
  state = await store.mutateLibrary(alice.id, {
    revision: state.revision,
    action: 'moveDocument',
    docId: DOC_A,
    folderId: work.id,
  });
  const libraryRevision = state.revision;

  const position = await store.updatePosition(alice.id, DOC_A, {
    anchor: 'b:marker:0',
    ratio: 0.4,
    scrollTop: 120,
  });
  assert.equal(position.ratio, 0.4);
  const upload = await store.upsertDocument(alice.id, DOC_A, {
    name: 'renamed.md',
    markdown: '# Two\n',
  });
  assert.equal(upload.doc.revision, 2);

  const after = await store.getLibrary(alice.id);
  assert.deepEqual(after, state, 'position/upload writes must leave revision and assignment untouched');
  assert.equal(after.revision, libraryRevision);
  assert.equal(after.assignments[DOC_A], work.id);
  const doc = await store.getDocument(alice.id, DOC_A);
  assert.equal(doc.revision, 2);
  assert.equal(doc.name, 'renamed.md');
  assert.equal(doc.position.ratio, 0.4);
  assert.equal(doc.position.anchor, 'b:marker:0');
});

test('corrupt library files fail closed instead of being silently reset', async (t) => {
  const { root, store, alice } = await setup(t);
  await store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Keep',
    parentId: null,
  });
  const file = path.join(root, 'libraries', `${alice.id}.json`);
  await fsp.writeFile(file, '{ not json', 'utf8');
  await expectError(store.getLibrary(alice.id), 'LIBRARY_CORRUPT', 500);
  await expectError(store.mutateLibrary(alice.id, {
    revision: 0,
    action: 'createFolder',
    name: 'Reset attempt',
    parentId: null,
  }), 'LIBRARY_CORRUPT', 500);
  assert.equal(await fsp.readFile(file, 'utf8'), '{ not json');

  await fsp.writeFile(file, JSON.stringify({
    version: 1,
    revision: 3,
    folders: [{ id: 'orphan', name: 'Orphan', parentId: 'missing' }],
    assignments: {},
  }), 'utf8');
  await expectError(store.getLibrary(alice.id), 'LIBRARY_CORRUPT', 500);

  await fsp.writeFile(file, JSON.stringify({
    version: 1,
    revision: 3,
    folders: [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ],
    assignments: {},
  }), 'utf8');
  await expectError(store.getLibrary(alice.id), 'LIBRARY_CORRUPT', 500);
});
