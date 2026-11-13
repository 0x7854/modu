import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {CloudStore} from '../cloud/lib/store.js';
import {createCloudServer} from '../cloud/server.js';
import {webkit} from 'playwright';

test('HTML authenticated preview, real WebKit interaction/isolation, switching, failure/retry and responsive layout', {timeout:60000}, async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'modu-html-cloud-'));
 const store=await new CloudStore(dir).init();
 const a=await store.addUser('alice','correct horse battery');
 const b=await store.addUser('bob','another good password');
 const H='a'.repeat(32),M='b'.repeat(32);let hits=0;
 const attacker=http.createServer((q,r)=>{hits++;r.end('oops')});await new Promise(r=>attacker.listen(0,'127.0.0.1',r));
 const bad=`http://127.0.0.1:${attacker.address().port}/bad`;
 const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:24px;font:18px sans-serif;box-sizing:border-box}button{padding:20px}#long{height:1400px}</style></head><body><h1>交互检查</h1><button id="counter">0</button><button id="attack">检查隔离</button><pre id="result"></pre><div id="long"></div><p id="end">页面底部</p><script>let n=0;document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent=++n;document.querySelector('#attack').onclick=()=>{const r={};for(const [k,fn] of Object.entries({parent:()=>parent.document.body.innerHTML,cookie:()=>document.cookie,storage:()=>localStorage.getItem('x')})){try{fn();r[k]='allowed'}catch(e){r[k]=e.name}}document.querySelector('#result').textContent=JSON.stringify(r);fetch('${bad}').catch(()=>{});fetch('/api/documents').catch(()=>{});new Image().src='${bad}';try{window.open('${bad}')}catch{};try{top.location='${bad}'}catch{}};</script></body></html>`;
 await store.upsertDocument(a.user.id,H,{name:'page.html',kind:'html',content:html});
 await store.upsertDocument(a.user.id,M,{name:'note.md',markdown:'# Markdown remains\n\nMARKER'});
 const server=await createCloudServer({dataDir:dir,pollMs:1000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const login=async(username,password)=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});return r.headers.get('set-cookie').split(';')[0]};
 let browser;
 try{
  const cookie=await login('alice','correct horse battery'),bob=await login('bob','another good password');
  assert.equal((await fetch(base+`/api/documents/${H}/preview`)).status,401);
  assert.equal((await fetch(base+`/api/documents/${H}/preview`,{headers:{Cookie:bob}})).status,404);
  const meta=await (await fetch(base+`/api/documents/${H}`,{headers:{Cookie:cookie}})).json();
  assert.equal(meta.doc.kind,'html');assert.equal(meta.doc.html,undefined);assert.equal(meta.doc.markdown,undefined);
  const prev=await fetch(base+meta.doc.previewUrl,{headers:{Cookie:cookie}});
  assert.match(prev.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.doesNotMatch(prev.headers.get('content-security-policy'),/allow-same-origin/);assert.match(prev.headers.get('cache-control'),/no-store/);assert.match(await prev.text(),/modu-preview-ready/);
  const sync=await fetch(base+`/api/sync/documents/${H}`,{method:'PUT',headers:{Authorization:`Bearer ${a.syncToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:'page.html',kind:'html',content:html})});assert.equal(sync.status,200);
  browser=await webkit.launch();const context=await browser.newContext({viewport:{width:834,height:1194},serviceWorkers:'block'});const page=await context.newPage();let previewRequests=0;
  page.on('request',r=>{if(r.url().includes('/preview'))previewRequests++});
  await page.goto(base+`/#doc-${H}`);await page.locator('#login-user').fill('alice');await page.locator('#login-pass').fill('correct horse battery');await page.locator('#login-submit').click();
  const frame=page.frameLocator('#html-frame');await frame.locator('#counter').click();assert.equal(await frame.locator('#counter').textContent(),'1');await page.locator('#doc-loading').waitFor({state:'hidden'});
  await frame.locator('#attack').click();assert.deepEqual(JSON.parse(await frame.locator('#result').textContent()),{parent:'SecurityError',cookie:'SecurityError',storage:'SecurityError'});
  await page.waitForTimeout(1300);assert.equal(hits,0);assert.equal(previewRequests,1);assert.equal(await frame.locator('#counter').textContent(),'1');
  for(const viewport of [{width:834,height:1194},{width:1194,height:834},{width:390,height:844}]){
   await page.setViewportSize(viewport);const box=await page.locator('#html-frame').boundingBox();assert.ok(box.height>300);assert.ok(box.y>=0&&box.y+box.height<=viewport.height+1);await frame.locator('#end').scrollIntoViewIfNeeded();assert.ok(await frame.locator('#end').isVisible());
  }
  await store.upsertDocument(a.user.id,H,{name:'page.html',kind:'html',content:html.replace('交互检查','更新后页面')});
  await frame.locator('h1').filter({hasText:'更新后页面'}).waitFor({timeout:10000});
  assert.equal(await frame.locator('#counter').textContent(),'0');
  const select=async id=>{const item=page.locator(`[data-doc-id="${id}"]`);if((await item.boundingBox()).x < 0)await page.locator('#library-toggle').click();await item.click()};
  await select(M);await page.locator('#cloud-doc').filter({hasText:'MARKER'}).waitFor();assert.equal(await page.locator('#html-frame').count(),0);
  let deny=true;await page.route('**/api/documents/*/preview*',async route=>deny?route.fulfill({status:500,contentType:'text/plain',body:'failed'}):route.continue());
  await select(H);await page.locator('#html-frame-error').waitFor({state:'visible',timeout:16000});await page.locator('#doc-loading').waitFor({state:'hidden'});deny=false;await page.locator('#html-retry').click();await frame.locator('#counter').click();assert.equal(await frame.locator('#counter').textContent(),'1');await page.locator('#doc-loading').waitFor({state:'hidden'});
  await page.locator('#logout-button').click();await page.locator('#auth-screen').waitFor({state:'visible'});assert.equal(await page.locator('#html-frame').count(),0);await context.close();
 }finally{await browser?.close();server.cloudShutdown();await new Promise(r=>server.close(r));await new Promise(r=>attacker.close(r));await fs.rm(dir,{recursive:true,force:true})}
});
