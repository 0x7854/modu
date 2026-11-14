import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {CloudStore} from '../cloud/lib/store.js';
import {createCloudServer} from '../cloud/server.js';
const {CloudSync}=createRequire(import.meta.url)('../electron/cloud-sync.cjs');

test('mobile import appears in the existing Mac cloud library without overwriting its same-named local file',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'modu-import-cross-'));let server,sync;
 try{
  const data=path.join(root,'data');const store=await new CloudStore(data).init();const account=await store.addUser('cross','correct horse battery');
  const file=path.join(root,'中文文稿.md');await fs.writeFile(file,'# Mac original');
  server=await createCloudServer({dataDir:data,publicDir:path.resolve('cloud/public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  sync=new CloudSync({userDataDir:path.join(root,'profile')});await sync.init();await sync.saveSettings({serverUrl:base,token:account.syncToken});await sync.addPath(file);await sync.syncAll({reason:'manual'});
  const originalId=crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0,32);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'cross',password:'correct horse battery'})});const session=await login.json();const cookie=login.headers.getSetCookie()[0].split(';')[0];
  const issue=await fetch(base+'/api/import/token',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':session.csrfToken}});assert.equal(issue.status,200);const {token}=await issue.json();
  const markdown='# iPad 新文件\n\n"引号" 和 \\ 与 📚';
  const response=await fetch(base+'/api/import/documents',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'中文文稿.md',markdown,requestId:'a'.repeat(32)})});assert.equal(response.status,201);const result=await response.json();assert.notEqual(result.doc.id,originalId);
  const mac=await sync.getLibrary();assert.equal(mac.documents.length,2);assert.ok(mac.documents.some(d=>d.id===result.doc.id));assert.equal(mac.library.assignments[result.doc.id],undefined);
  const reader=await fetch(base+`/api/documents/${result.doc.id}`,{headers:{Cookie:cookie}});assert.equal(reader.status,200);assert.equal((await reader.json()).doc.markdown,markdown);
  assert.equal(await fs.readFile(file,'utf8'),'# Mac original');assert.equal((await store.getDocument(account.user.id,originalId)).markdown,'# Mac original');
  const forbidden=await fetch(base+'/api/sync/library',{headers:{Authorization:`Bearer ${token}`}});assert.equal(forbidden.status,401);
 }finally{sync?.dispose();if(server){server.cloudShutdown();await new Promise(r=>server.close(r))}await fs.rm(root,{recursive:true,force:true})}
});
