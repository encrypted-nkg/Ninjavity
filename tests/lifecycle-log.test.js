const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createLifecycleLog,errorMetadata}=require('../src/main/lifecycle-log');

test('lifecycle diagnostics rotate locally and retain structured exit reasons', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clipninja-log-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'lifecycle.log');
  const log=createLifecycleLog(file,1);
  log('started'); log('quit-requested',{reason:'tray-menu'});
  assert.equal(JSON.parse(fs.readFileSync(file+'.1','utf8')).event,'started');
  const entry=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(entry.reason,'tray-menu');
  assert.equal(entry.pid,process.pid);
});
test('an unwritable diagnostic destination cannot crash the app', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clipninja-log-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'blocked');fs.writeFileSync(file,'file');
  assert.doesNotThrow(()=>createLifecycleLog(path.join(file,'log'))('started'));
});
test('error metadata does not include potentially sensitive error messages',()=>{
  const error=new Error('private snippet content');
  const metadata=JSON.stringify(errorMetadata(error));
  assert.equal(metadata.includes('private snippet content'),false);
  assert.equal(JSON.parse(metadata).name,'Error');
});
