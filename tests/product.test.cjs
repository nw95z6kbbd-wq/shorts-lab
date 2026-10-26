'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../js/product.js');
const release = require('../scripts/release.cjs');
const root = path.resolve(__dirname, '..');

test('current product version is a valid stable SemVer derived from the newest release', () => {
  assert.match(P.version, /^\d+\.\d+\.\d+$/);
  assert.equal(P.version, P.releases[0].version);
  assert.doesNotThrow(release.validate);
  assert.ok(Object.isFrozen(P) && Object.isFrozen(P.releases));
});

test('changelog exactly matches the authoritative release data and real PR references', () => {
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), release.changelog());
  assert.deepEqual(P.releases.slice(-3).map(entry => entry.pullRequests), [[3], [2], [1]]);
  for (const entry of P.releases) {
    assert.match(entry.commit, /^[a-f0-9]{40}$/);
    assert.ok(entry.changes.length > 0);
    assert.ok(release.changelog().includes(P.repository + '/commit/' + entry.commit));
  }
});

test('runtime files contain no hardcoded copies of release version numbers', () => {
  const files = ['index.html', 'styles.css', 'video.css', 'product.css', ...fs.readdirSync(path.join(root, 'js')).filter(name => name.endsWith('.js') && name !== 'product.js').map(name => 'js/' + name)];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const entry of P.releases) assert.ok(!text.includes(entry.version), `Version duplicated in ${file}`);
  }
});

test('owner and contact remain configurable strings without imposing an application license', () => {
  assert.equal(typeof P.rights.owner, 'string');
  assert.equal(typeof P.rights.contact, 'string');
  assert.equal(P.repository, 'https://github.com/nw95z6kbbd-wq/shorts-lab');
  assert.ok(P.licenseNote.includes('не установлена'));
  assert.ok(!fs.existsSync(path.join(root, 'LICENSE')));
});
