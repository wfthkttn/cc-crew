import assert from 'node:assert/strict'
import { test } from 'node:test'

import { folderOf } from '../../cc-providers/adapters/access.ts'
import * as theirs from '../../cc-providers/adapters/paths.ts'
import * as ours from '../hooks/paths.ts'

/** Plugins share no code files, so crew carries its own copy of these. */
const PATHS = ['/', '/a', '/a/', '/a/b', 'a/b', '..', 'C:\\', 'C:/', 'c:\\X\\', 'C:/x/y', 'C:\\x\\..\\y', '\\\\srv\\share', '\\\\srv\\share\\', '\\\\srv\\share\\x', '//srv/share/x']

test("crew's path helpers answer as cc-providers' do", () => {
  for (const a of PATHS) {
    assert.equal(ours.isWindowsPath(a), theirs.isWindowsPath(a), `isWindowsPath ${a}`)
    assert.equal(ours.isAbsolute(a), theirs.isAbsolute(a), `isAbsolute ${a}`)
    assert.equal(ours.parentOf(a), theirs.parentOf(a), `parentOf ${a}`)
    assert.equal(ours.folderOf(a, [a]), folderOf(a, [a]), `folderOf ${a}`)
    assert.equal(ours.folderOf(a, []), folderOf(a, []), `folderOf ${a}`)
    for (const b of PATHS) {
      assert.equal(ours.isInside(a, b), theirs.isInside(a, b), `isInside ${a} ${b}`)
      assert.equal(ours.join(a, b), theirs.join(a, b), `join ${a} ${b}`)
    }
  }
})
