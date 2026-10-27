'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { authorize } = require('../scripts/pages-publication.cjs');
const root = path.resolve(__dirname, '..');
const checks = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
const publication = fs.readFileSync(path.join(root, '.github/workflows/publish-pages.yml'), 'utf8');
const sha = 'a'.repeat(40);
function request() {
  return {
    env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
      GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'owner/studio', GITHUB_REPOSITORY_OWNER: 'owner',
      GITHUB_ACTOR: 'owner', GITHUB_TRIGGERING_ACTOR: 'owner' },
    event: { inputs: { commit_sha: sha, confirmation: 'PUBLISH' }, sender: { login: 'owner' }, repository: { full_name: 'owner/studio' } }
  };
}
function job(source, name) {
  return source.match(new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  [a-z]+:|$(?![\\s\\S]))', 'm'))?.[1] || '';
}
const deploy = job(publication, 'deploy');
const deployIf = deploy.match(/^    if: (.+)$/m)?.[1];
function admitted(env, event) {
  try { authorize(env, event); return vm.runInNewContext(deployIf, { github: {
    event_name: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, run_attempt: Number(env.GITHUB_RUN_ATTEMPT)
  } }); } catch (_) { return false; }
}

test('push, merge, PR, tags and check reruns cannot publish even with release-like inputs', () => {
  for (const eventName of ['push', 'pull_request', 'pull_request_target', 'release', 'workflow_run']) {
    for (const attempt of ['1', '2']) {
      const { env, event } = request(); env.GITHUB_EVENT_NAME = eventName; env.GITHUB_RUN_ATTEMPT = attempt;
      assert.equal(admitted(env, event), false, eventName + '/' + attempt);
    }
  }
});

test('explicit owner request for the exact main SHA enables the publication route', () => {
  const { env, event } = request();
  assert.deepEqual(authorize(env, event), { repository: 'owner/studio', sha, owner: 'owner' });
  assert.equal(admitted(env, event), true);
  assert.match(publication, /on:\n  workflow_dispatch:/);
  assert.match(publication, /commit_sha:[\s\S]*required: true[\s\S]*confirmation:[\s\S]*required: true/);
  assert.doesNotMatch(publication, /^  (push|pull_request|release|workflow_run|schedule):/m);
});

test('default manual checks, typos, other branches/actors, stale SHA and release reruns fail closed', () => {
  const variants = [
    r => { r.event.inputs = {}; }, r => { r.event.inputs.confirmation = 'publish'; },
    r => { r.event.inputs.commit_sha = 'b'.repeat(40); }, r => { r.event.inputs.commit_sha = 'main'; },
    r => { r.env.GITHUB_REF = 'refs/heads/feat/project-zip-backup'; }, r => { r.env.GITHUB_REF = 'refs/tags/v1.4.0'; },
    r => { r.env.GITHUB_RUN_ATTEMPT = '2'; }, r => { delete r.env.GITHUB_RUN_ATTEMPT; },
    r => { r.env.GITHUB_ACTOR = 'collaborator'; }, r => { r.env.GITHUB_TRIGGERING_ACTOR = 'collaborator'; },
    r => { r.event.sender.login = 'github-actions[bot]'; }, r => { r.event.repository.full_name = 'other/studio'; }
  ];
  for (const mutate of variants) { const r = request(); mutate(r); assert.equal(admitted(r.env, r.event), false); }
});

test('automatic checks keep every browser gate and contain no deployment or privileged Pages permissions', () => {
  assert.match(checks, /push:\n    branches: \[main\]/);
  assert.match(checks, /pull_request:\n    branches: \[main, feat\/browser-video-generator\]/);
  for (const name of ['check', 'webkit', 'safari']) assert.ok(job(checks, name), name);
  assert.doesNotMatch(checks, /actions\/(deploy-pages|configure-pages)|pages: write|id-token: write|^  deploy:/m);
  assert.match(checks, /workflow_call:[\s\S]*upload_pages:[\s\S]*type: boolean\n        default: false/);
  assert.match(checks, /name: Validate publication request before artifact upload\n        if: inputs.upload_pages == true\n        run: node scripts\/pages-publication.cjs/);
  assert.match(checks, /name: Upload static site for explicit publication\n        if: inputs.upload_pages == true\n        uses: actions\/upload-pages-artifact@v3/);
});

test('publication verifies the same commit through all checks before a protected, revalidated deployment', () => {
  assert.match(job(publication, 'checks'), /needs: authorize/);
  assert.match(job(publication, 'checks'), /uses: \.\/\.github\/workflows\/pages.yml/);
  assert.match(job(publication, 'checks'), /upload_pages: true/);
  assert.match(deploy, /needs: \[authorize, checks\]/);
  assert.match(deploy, /environment:\n      name: github-pages/);
  assert.match(deploy, /pages: write\n      id-token: write/);
  assert.match(deploy, /ref: \$\{\{ github.sha \}\}/);
  assert.ok(deploy.indexOf('node scripts/pages-publication.cjs') < deploy.indexOf('actions/configure-pages'));
  assert.match(deploy, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(publication, /continue-on-error|if: always\(\)|workflow_run:/);
});

test('guard CLI is a side-effect-free dry run, rejects invalid events and leaves release metadata unchanged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-publication-'));
  const product = fs.readFileSync(path.join(root, 'js/product.js'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'));
  try {
    const r = request(), file = path.join(directory, 'event.json'); fs.writeFileSync(file, JSON.stringify(r.event));
    const run = env => spawnSync(process.execPath, ['scripts/pages-publication.cjs'], { cwd: root, env: { ...process.env, ...env, GITHUB_EVENT_PATH: file }, encoding: 'utf8' });
    assert.equal(run(r.env).status, 0);
    const rejected = run({ ...r.env, GITHUB_EVENT_NAME: 'push' });
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /Публикация запрещена/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'js/product.js')), product);
    assert.deepEqual(fs.readFileSync(path.join(root, 'CHANGELOG.md')), changelog);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
