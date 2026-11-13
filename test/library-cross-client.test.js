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
test('Mac and cookie client organize the same tree without content sync overwriting it',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'modu-library-cross-'));let server,sync;
 try{
  const data=path.join(root,'data');const store=await new CloudStore(data).init();const account=await store.addUser('cross','correct horse battery');
  const file=path.join(root,'note.md');await fs.writeFile(file,'# Before');
  server=await createCloudServer({dataDir:data,publicDir:path.resolve('cloud/public')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  sync=new CloudSync({userDataDir:path.join(root,'profile')});await sync.init();await sync.saveSettings({serverUrl:base,token:account.syncToken});await sync.addPath(file);await sync.syncAll({reason:'manual'});
  const id=crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0,32);let mac=await sync.getLibrary();assert.equal(mac.library.revision,0);
  mac=await sync.mutateLibrary({revision:0,action:'createFolder',name:'工作',parentId:null});const parent=mac.library.folders.find(f=>f.name==='工作').id;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'cross',password:'correct horse battery'})});assert.equal(login.status,200);const session=await login.json();const cookie=login.headers.getSetCookie()[0].split(';')[0];
  const request=async(body)=>{const r=await fetch(base+'/api/library',{method:body?'PATCH':'GET',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}};
  let ipad=(await request()).data;assert.equal(ipad.library.folders[0].id,parent);
  ipad=(await request({revision:ipad.library.revision,action:'createFolder',name:'项目',parentId:parent})).data;const child=ipad.library.folders.find(f=>f.name==='项目').id;
  ipad=(await request({revision:ipad.library.revision,action:'moveDocument',docId:id,folderId:child})).data;assert.equal(ipad.library.assignments[id],child);
  mac=await sync.getLibrary();assert.equal(mac.library.assignments[id],child);
  await fs.writeFile(file,'# After');await sync.syncAll({reason:'manual'});mac=await sync.getLibrary();assert.equal(mac.library.assignments[id],child);assert.equal(mac.library.revision,ipad.library.revision);assert.match((await store.getDocument(account.user.id,id)).markdown,/After/);
  const stale=await request({revision:0,action:'moveDocument',docId:id,folderId:null});assert.equal(stale.status,409);assert.equal((await sync.getLibrary()).library.assignments[id],child);
  mac=await sync.mutateLibrary({revision:mac.library.revision,action:'renameFolder',folderId:child,name:'新项目'});assert.equal((await request()).data.library.folders.find(f=>f.id===child).name,'新项目');
  mac=await sync.mutateLibrary({revision:mac.library.revision,action:'deleteFolder',folderId:child});assert.equal(mac.library.assignments[id],parent);assert.match((await store.getDocument(account.user.id,id)).markdown,/After/);assert.equal(await fs.readFile(file,'utf8'),'# After');
  const fresh=new CloudStore(data);await fresh.init();assert.equal((await request()).data.library.assignments[id],parent);
 }finally{sync?.dispose();if(server){server.cloudShutdown();await new Promise(r=>server.close(r))}await fs.rm(root,{recursive:true,force:true})}
});
