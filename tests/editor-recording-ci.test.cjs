'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('branch recording diagnostics call all original browser checks without granting a publication route',()=>{
 const s=fs.readFileSync('.github/workflows/diagnose-editor-recording.yml','utf8');
 assert.match(s,/branches: \[fix\/safari-editor-recording-validation\]/);
 assert.match(s,/permissions:\n  contents: read/);
 assert.match(s,/uses: \.\/\.github\/workflows\/pages.yml\n    with:\n      upload_pages: false/);
 assert.doesNotMatch(s,/continue-on-error|secrets:|contents: write|pages: write|id-token: write|deploy-pages|publish-pages|upload_pages: true/);
});
