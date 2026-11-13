import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createCloudServer} from '../cloud/server.js';import {CloudStore} from '../cloud/lib/store.js';
test('bootstrap authenticates, selects only own documents, and returns no-store single-screen payload',async()=>{
const root=await fs.mkdtemp(path.join(os.tmpdir(),'modu-bootstrap-'));let server;
try{const store=await new CloudStore(root).init();const a=await store.addUser('alice','correct horse battery');const b=await store.addUser('bob','another good password');
const own='a'.repeat(32),other='b'.repeat(32);await store.upsertDocument(a.user.id,own,{name:'own.md',markdown:'# Own'});await store.upsertDocument(b.user.id,other,{name:'other.md',markdown:'# Other Secret'});
server=await createCloudServer({dataDir:root,publicDir:new URL('../cloud/public/',import.meta.url).pathname});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
assert.equal((await fetch(base+'/api/bootstrap')).status,401);assert.equal((await fetch(base+'/api/bootstrap',{headers:{Authorization:`Bearer ${a.syncToken}`}})).status,401);
const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'alice',password:'correct horse battery'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
const res=await fetch(base+'/api/bootstrap?doc='+other,{headers:{Cookie:cookie}});assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');const data=await res.json();assert.equal(data.user.username,'alice');assert.equal(data.documents.length,1);assert.equal(data.doc.id,own);assert.equal(data.doc.markdown,'# Own');assert(data.csrfToken);assert(!JSON.stringify(data).includes('Other Secret'));
assert.equal((await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie,Origin:'https://evil.invalid'}})).status,403);
const empty=await store.addUser('empty','empty good password');const l=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:empty.user.username,password:'empty good password'})});const e=await fetch(base+'/api/bootstrap',{headers:{Cookie:l.headers.get('set-cookie').split(';')[0]}});const ed=await e.json();assert.equal(ed.doc,null);assert.deepEqual(ed.documents,[]);
}finally{if(server){server.cloudShutdown();await new Promise(r=>server.close(r))}await fs.rm(root,{recursive:true,force:true});}
});
