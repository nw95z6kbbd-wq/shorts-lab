// Reverse only exact reviewed additions before the existing historical proofs.
// Renderer, recorder, mixer, DTO, database and ZIP retain their original hashes.
'use strict';
const assert=require('node:assert/strict'),bridges=require('./fixtures/editor-audio/bridges.json');
module.exports=(name,source)=>{
 for(const change of bridges[name]||[]){assert.equal(source.split(change.new).length,2,name+' exact Editor audio extension');source=source.replace(change.new,change.old);}
 return source;
};
