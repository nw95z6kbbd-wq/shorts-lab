// Reverse only exact reviewed additions before the existing historical proofs.
// Renderer, recorder, mixer, DTO, database and ZIP retain their original hashes.
'use strict';
const assert=require('node:assert/strict'),bridges=require('./fixtures/editor-audio/bridges.json');
module.exports=(name,source)=>{
 if(name==='tests/safari-product.py')for(const line of ['from editor_export_native import check_native_editor_export\n','            check_native_editor_export(ROOT,script,command,click)\n']){assert.equal(source.split(line).length,2,'exact export native test inclusion');source=source.replace(line,'');}
 if(name==='index.html')for(const module of ['export-inspector','editor-export']){const line='  <script src="js/'+module+'.js" defer></script>\n';assert.equal(source.split(line).length,2,'exact export module inclusion');source=source.replace(line,'');}
 if(name==='js/render-session.js')for(const change of require('./fixtures/editor-export/session-bridges.json')){assert.equal(source.split(change.new).length,2,'exact Editor export forwarding');source=source.replace(change.new,change.old);}
 for(const change of bridges[name]||[]){assert.equal(source.split(change.new).length,2,name+' exact Editor audio extension');source=source.replace(change.new,change.old);}
 return source;
};
