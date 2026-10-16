import assert from 'node:assert/strict';

/** Real browser -> authenticated Main -> desktop opener. The caller supplies a
 * disposable host and confirms the resulting native window on that host. */
export async function verifyWorkspaceFolder(page,{url,projectRoot}){
 await page.goto(url);
 await page.getByRole('button',{name:'Select project',exact:true}).click();
 await page.getByRole('menuitem',{name:'Create project',exact:true}).click();
 await page.getByLabel('Project folder',{exact:true}).fill(projectRoot);
 await page.getByRole('button',{name:'Create project',exact:true}).click();
 const button=page.getByRole('button',{name:'Open workspace folder in system file manager',exact:true});
 await button.waitFor();
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/open-folder')&&r.request().method()==='POST');
 await button.focus();await button.press('Enter');
 const response=await responsePromise;
 assert.equal(response.status(),200,await response.text());
 assert.deepEqual(await response.json(),{opened:true});
 await button.waitFor();assert.equal(await button.getAttribute('aria-disabled'),'false');
 const route=new URL(response.url()).pathname;
 const crossOrigin=await page.request.post(response.url(),{headers:{Origin:'http://other.invalid'},data:{}});
 assert.equal(crossOrigin.status(),403);
 const missingOrigin=await page.request.post(response.url(),{data:{}});assert.equal(missingOrigin.status(),403);
 const checks=await page.evaluate(async route=>{
  const post=async(path,body,credentials='same-origin')=>{const r=await fetch(path,{method:'POST',credentials,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  return {unauthenticated:await post(route,{},'omit'),arbitraryPath:await post(route,{path:'/tmp'}),unknownNode:await post(route.replace(/\/nodes\/[^/]+\//,'/nodes/00000000-0000-4000-8000-000000000000/'),{})};
 },route);
 assert.equal(checks.unauthenticated.status,401);assert.equal(checks.arbitraryPath.status,400);assert.equal(checks.unknownNode.status,404);
 return {route,projectRoot,checks,crossOrigin:crossOrigin.status(),missingOrigin:missingOrigin.status()};
}

/** A missing real workspace reports a concise failure; restoring it makes the
 * same mounted button usable again without refreshing or recreating the view. */
export async function verifyFolderRecovery(page,changeAvailability){
 const button=page.getByRole('button',{name:'Open workspace folder in system file manager',exact:true});
 await changeAvailability(false);
 try{
  const failed=page.waitForResponse(r=>r.url().endsWith('/open-folder'));
  await button.click();const response=await failed;
  assert.equal(response.status(),503);
  const message=(await response.json()).error.message;
  assert.match(message,/Check that the folder exists/);
  assert.doesNotMatch(message,/Command failed|stderr|\/nodes\//);
  await page.getByRole('alert').filter({hasText:message}).waitFor();
 }finally{await changeAvailability(true);}
 const retried=page.waitForResponse(r=>r.url().endsWith('/open-folder'));
 await button.click();assert.equal((await retried).status(),200);
 assert.equal(await page.getByRole('alert').filter({hasText:'The workspace folder could not be opened'}).count(),0);
 return {failure:503,retry:200};
}
