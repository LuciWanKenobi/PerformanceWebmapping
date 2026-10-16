const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../dist/core.js');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/dataset.js'),'utf8'),context);
const parsed = C.parseCSV(context.window.BENCHMARK_SOURCE.csv);
test('source rows and nested JSON survive CSV parsing without splitting quoted commas',()=>{
  assert.equal(parsed.rows.length,184);assert.equal(parsed.headers.length,292);
  assert.equal(parsed.rows.filter(r=>r.recordType==='completed').length,180);
  assert.equal(parsed.rows.filter(r=>r.recordType==='failed').length,1);
  assert.equal(parsed.rows.filter(r=>r.recordType==='aborted').length,3);
  assert.equal(JSON.parse(parsed.rows[0].rasterLayers)[0].mode,'xyz');
});
test('CSV handles BOM, CRLF, escaped quotes, embedded newlines, and an empty last field',()=>{
  const csv='\uFEFFrecordType,rafFps,note,empty\r\ncompleted,0,"hello, ""quoted""\r\nworld",\r\n';
  const {rows}=C.parseCSV(csv);assert.equal(rows[0].note,'hello, "quoted"\r\nworld');assert.equal(rows[0].empty,'');assert.equal(rows[0].rafFps,'0');
});
test('rejects malformed CSV and incompatible schemas',()=>{
  for(const csv of ['x,y\n1,2','recordType,rafFps\ncompleted,"2','recordType,rafFps\ncompleted,5,6','recordType,recordType,rafFps\ncompleted,completed,2'])assert.throws(()=>C.parseCSV(csv));
});
test('missing measurements remain missing while real zeroes are retained',()=>{
  for(const value of ['',null,undefined,' ','NaN','Infinity'])assert.equal(C.number(value),null);
  assert.equal(C.number('0'),0);assert.equal(C.aggregate([]),null);
  assert.equal(C.aggregate([0,10,null]),5);
});
test('aggregation uses equal trial weights and interpolated percentiles',()=>{
  assert.equal(C.aggregate([1,2,3,100],'mean'),26.5);
  assert.equal(C.aggregate([1,2,3,100],'median'),2.5);
  assert.ok(Math.abs(C.aggregate([1,2,3,100],'p95')-85.45)<1e-9);
  assert.equal(C.quantile([10],.95),10);
});
test('filters combine, empty selection stays empty, warmup config does not discard measured trials',()=>{
  assert.equal(C.filterRows(parsed.rows,{recordType:['completed']}).length,180);
  assert.equal(C.filterRows(parsed.rows,{recordType:['completed'],mapCount:['1'],sceneId:['I'],suiteRasterPath:['xyz']}).length,5);
  assert.equal(C.filterRows(parsed.rows,{sceneId:[]}).length,0);
  assert.equal(C.filterRows(parsed.rows,{recordType:['failed']}).length,1);
});
test('grouping omits missing measurements and returns the true sample count',()=>{
  const data=[{x:'a',s:'one',m:'0'},{x:'a',s:'one',m:''},{x:'a',s:'one',m:'10'},{x:'b',s:'one',m:''}];
  const groups=C.groups(data,'x','s','m','mean',2);
  assert.deepEqual(groups[0].values[0],{series:'one',n:2,value:2.5});assert.deepEqual(groups[1].values[0],{series:'one',n:0,value:null});
});
test('all completed configuration groups have five measured repetitions',()=>{
  const rows=C.filterRows(parsed.rows,{recordType:['completed']});
  const grouped=C.groups(rows,'configurationIndex','suiteRasterPath','rafFps','mean');
  assert.equal(grouped.length,36);assert.equal(grouped.flatMap(x=>x.values).filter(x=>x.n).length,36);
  assert.ok(grouped.flatMap(x=>x.values).every(x=>x.n===0||x.n===5));
});
