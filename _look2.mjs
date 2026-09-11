import { chromium, devices } from 'playwright';
const O='http://127.0.0.1:8801';
const b=await chromium.launch();
for (const [tag,opt] of [['Pixel 7 (phone)',{...devices['Pixel 7']}],['1280 desktop',{viewport:{width:1280,height:900}}]]) {
  const ctx=await b.newContext(opt); const p=await ctx.newPage();
  await p.goto(O+'/index.html',{waitUntil:'networkidle'});
  await p.waitForFunction(()=>!document.getElementById('addr').disabled,null,{timeout:90000});
  const settle=()=>p.waitForFunction(()=>{const y=Math.round(window.scrollY);const s=window.__l===y?(window.__n||0)+1:0;window.__l=y;window.__n=s;return s>=4;},null,{timeout:15000,polling:120});
  const where=()=>p.evaluate(()=>{const g=id=>Math.round(document.getElementById(id).getBoundingClientRect().top);
    return {y:Math.round(scrollY),result:g('resultBlock'),dirHead:g('dirHead'),map:g('mapBlock'),
            infoOnScreen: g('resultBlock')<innerHeight && g('resultBlock')+document.getElementById('resultBlock').getBoundingClientRect().height>0,
            resultTopVisible: g('resultBlock')>=0 && g('resultBlock')<innerHeight};});

  // first lookup
  await p.fill('#addr','300 Monroe Ave NW'); await p.press('#addr','Enter');
  await p.waitForFunction(()=>!document.getElementById('mapBlock').hidden,null,{timeout:30000});
  await settle();
  console.log('\n'+tag);
  console.log('  after 1st lookup     ', JSON.stringify(await where()));

  // reader scrolls down to the directions, as they would to read the route
  await p.evaluate(()=>{const d=document.getElementById('dirHead');window.scrollTo({top:scrollY+d.getBoundingClientRect().top-120});});
  await p.waitForTimeout(500);
  console.log('  reader scrolls to dirs', JSON.stringify(await where()));

  // SECOND lookup from the sticky bar, which is the whole point of it being sticky
  await p.fill('#addr','602 Alexander St SE');
  await p.press('#addr','Enter');
  await p.waitForTimeout(2500);
  await settle();
  console.log('  after 2nd lookup     ', JSON.stringify(await where()));
  await ctx.close();
}
await b.close();
