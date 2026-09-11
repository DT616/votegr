import { chromium, devices } from 'playwright';
const O='http://127.0.0.1:8801';
const b=await chromium.launch();
// Both ways a lookup happens: Enter on a typed address, and choosing a suggestion.
for (const [tag,ctxOpt] of [['Pixel 7 (phone)',{...devices['Pixel 7']}],['1280 desktop',{viewport:{width:1280,height:900}}],['660x400 landscape',{viewport:{width:660,height:400}}]]) {
  for (const how of ['enter','suggestion']) {
    const ctx=await b.newContext(ctxOpt);
    const p=await ctx.newPage();
    await p.goto(O+'/index.html',{waitUntil:'networkidle'});
    await p.waitForFunction(()=>!document.getElementById('addr').disabled,null,{timeout:90000});
    await p.fill('#addr','300 Monroe Ave NW');
    if (how==='suggestion'){ await p.waitForTimeout(350); const s=await p.$$('.ac-item'); if(s.length) await s[0].click(); else await p.press('#addr','Enter'); }
    else await p.press('#addr','Enter');
    await p.waitForFunction(()=>!document.getElementById('mapBlock').hidden,null,{timeout:30000});
    // let every smooth scroll settle
    await p.waitForFunction(()=>{const y=Math.round(window.scrollY);const s=window.__l===y?(window.__n||0)+1:0;window.__l=y;window.__n=s;return s>=4;},null,{timeout:15000,polling:120});
    const r=await p.evaluate(()=>{
      const g=id=>{const e=document.getElementById(id);return e?Math.round(e.getBoundingClientRect().top):null;};
      // what occupies the middle of the first screen
      const mid=document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
      return {scrollY:Math.round(window.scrollY), vh:innerHeight,
              header:g('siteHeader'), result:g('resultBlock'), dirHead:g('dirHead'),
              map:g('mapBlock'), steps:g('steps'),
              midScreen: mid? (mid.id||mid.className||mid.tagName).toString().slice(0,30):null};
    });
    console.log(tag.padEnd(19), how.padEnd(11), JSON.stringify(r));
    await ctx.close();
  }
}
await b.close();
