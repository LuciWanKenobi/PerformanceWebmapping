const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const C=require('../dist/core.js');
// A minimal document adapter exercises the application rendering paths without a browser.
// It deliberately cannot validate browser layout, image decoding, or file downloads.
function app(){
  const elements=new Map(),events={};
  const element=id=>{if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,style:{},setAttribute(){},querySelector(){return {style:{}};},querySelectorAll(){return [];},addEventListener(name,fn){events[id+':'+name]=fn;}});return elements.get(id);};
  const document={getElementById:element,querySelectorAll:()=>[],addEventListener(){}};
  const context={window:{},document,BenchmarkCore:C,Intl,Date,console,setTimeout,clearTimeout};
  vm.createContext(context);
  for(const file of ['dataset.js','app.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist',file),'utf8'),context,{filename:file});
  return {element,events};
}
test('initial dashboard renders all chart types and 180 completed records',()=>{
  const {element}=app();
  assert.equal(element('importError').hidden,true);
  assert.match(element('selectionSummary').textContent,/180 of 184/);
  assert.match(element('stats').innerHTML,/180 completed/);
  for(const id of ['comparison','distribution','latency','memory'])assert.match(element(id).innerHTML,/^<svg/);
  assert.equal((element('tableBody').innerHTML.match(/<tr>/g)||[]).length,15);
  assert.equal((element('memory').innerHTML.match(/data-tip=/g)||[]).length,180);
});
test('metric, line mode and aggregation controls regenerate charts',()=>{
  const {element}=app();
  element('metric').onchange({target:{value:'heapPeakBytes'}});
  assert.equal(element('comparisonTitle').textContent,'Peak JavaScript heap by scene');
  assert.match(element('comparison').innerHTML,/MIB/);
  element('lineMode').onclick();assert.match(element('comparison').innerHTML,/<polyline/);
  element('aggregation').onchange({target:{value:'median'}});
  assert.match(element('comparison').innerHTML,/Median:/);
  assert.match(element('latency').innerHTML,/Median:/);
});
test('failure-only filtering exposes partial data without inventing FPS',()=>{
  const {element,events}=app();
  events['filters:change']({target:{dataset:{filter:'recordType'},tagName:'SELECT',value:'failed'}});
  assert.match(element('selectionSummary').textContent,/1 of 184/);
  assert.match(element('comparison').innerHTML,/No measured values/);
  assert.match(element('tableBody').innerHTML,/failed/);
  element('resetFilters').onclick();assert.match(element('selectionSummary').textContent,/180 of 184/);
});
test('zero-result filters show empty state and disable export',()=>{
  const {element,events}=app();
  events['filters:change']({target:{dataset:{filter:'sceneId'},tagName:'INPUT'}});
  assert.equal(element('emptyState').hidden,false);assert.equal(element('chartGrid').hidden,true);assert.equal(element('exportReport').disabled,true);
});
test('search and numeric sort operate on the filtered records',()=>{
  const {element}=app();
  element('tableSearch').oninput({target:{value:'nonexistent-search-token'}});
  assert.equal(element('pageInfo').textContent,'0 records');
  element('tableSearch').oninput({target:{value:''}});
  element('tableHead').onclick({target:{closest:()=>({dataset:{sort:'rafFps'}})}});
  assert.match(element('tableBody').innerHTML,/14\.9/);
});
if(process.env.WRITE_CHART_QA==='1'){
  const {element}=app(),dir=path.join(__dirname,'../.qa');fs.mkdirSync(dir,{recursive:true});
  for(const id of ['comparison','distribution','latency','memory'])fs.writeFileSync(path.join(dir,id+'.svg'),element(id).innerHTML);
}
