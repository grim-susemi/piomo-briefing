import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cardsFile, readJson } from './helpers/profiles-cards-fixture.mjs';
import { cardAuditSnapshot, assertCardApplyAudit } from './helpers/profiles-card-editor-audit.mjs';
import {
  openEditorBrowser, openProfiles, openEditor, fill, click, marker, base,
  profilesResponse, saved, sizes, settle, capture,
} from './helpers/profiles-card-editor-browser.mjs';

const longSummary = '깊은 ' + 'A'.repeat(156);
const shortPhrase = '깊은 구현·검토';
const shortSummary = 'A'.repeat(21) + ' ' + shortPhrase;
const viewports = [{ width: 375, height: 800, mobile: true, deviceScaleFactor: 3 }, ...sizes];
const cardSummary = '[data-pf="select-profile"][data-profile="' + base + '"] .pf-card-sum';
const detailSummary = '.pf-detail > .pf-du';

async function measure(page, phrase) {
  return page.eval(`(() => {
    const rect = r => ({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom});
    const result = [];
    for (const selector of ${JSON.stringify([cardSummary, detailSummary])}) {
      const p=document.querySelector(selector), box=p.getBoundingClientRect(), cs=getComputedStyle(p);
      const keep=[...p.querySelectorAll('.pf-keep')].find(n=>n.textContent===${JSON.stringify(phrase)});
      const glyphs=[], walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const n=walker.currentNode;
        for(let i=0;i<n.length;i++) {
          if(!n.data[i].trim()) continue;
          const range=document.createRange();range.setStart(n,i);range.setEnd(n,i+1);
          for(const r of range.getClientRects()) if(r.width && r.height)
            glyphs.push({text:n.data[i],inPhrase:keep.contains(n),...rect(r)});
        }
      }
      const lineHeight=parseFloat(cs.lineHeight), rows=[];
      for(const g of glyphs.filter(g=>g.inPhrase)) {
        const middle=g.y+g.height/2;
        if(!rows.some(y=>Math.abs(y-middle)<lineHeight/2)) rows.push(middle);
      }
      let previous=null;
      if(keep.previousSibling?.nodeType===Node.TEXT_NODE) {
        const n=keep.previousSibling, end=n.data.trimEnd().length;
        if(end) {const r=document.createRange();r.setStart(n,end-1);r.setEnd(n,end);
          previous=rect(r.getBoundingClientRect());}
      }
      const ks=getComputedStyle(keep);
      result.push({selector,text:p.textContent,phrase:keep.textContent,box:rect(box),
        clientWidth:p.clientWidth,scrollWidth:p.scrollWidth,phraseBox:rect(keep.getBoundingClientRect()),
        phraseRows:rows,previous,glyphs,fontSize:cs.fontSize,fontFamily:cs.fontFamily,
        fontWeight:cs.fontWeight,lineHeight:cs.lineHeight,overflowX:cs.overflowX,
        overflowY:cs.overflowY,clipPath:cs.clipPath,phraseOverflowX:ks.overflowX,
        phraseOverflowY:ks.overflowY,phraseClipPath:ks.clipPath});
    }
    const main=document.getElementById('main'), root=document.querySelector('[data-pf-root]');
    return {paragraphs:result,mainOverflow:main.scrollWidth-main.clientWidth,
      documentOverflow:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth,
      mainScroll:getComputedStyle(main).overflowY,busy:root.dataset.pfBusy,
      selected:[...root.querySelectorAll('[data-pf="select-profile"][aria-pressed="true"]')].map(n=>n.dataset.profile),
      current:[...root.querySelectorAll('.pf-current')].map(n=>n.textContent.trim()),
      targets:[...document.querySelector(${JSON.stringify(cardSummary)}).closest('.pf-card')
        .querySelectorAll('button[data-pf]')].map(n=>({action:n.dataset.pf,disabled:n.disabled,
          text:n.textContent,rect:rect(n.getBoundingClientRect())}))};
  })()`);
}

// R: legal metadata can match an arbitrarily long preserved phrase. Existing
// maximum-description tests do not exercise this prefix or the detail's actual glyph bounds.
test('legal saved descriptions wrap fully while short semantic compounds remain atomic when they fit',
  { timeout: 180000 }, async t => {
    assert.equal(longSummary.length, 159);
    assert.equal([...longSummary].length, 159);
    const b=await openEditorBrowser(t), active=b.fx.store.state().activeProfile;
    console.log('WRAP_RESOURCES '+JSON.stringify({chromePid:b.page.pid,chromeProfile:b.page.profileDir,
      chromePort:b.page.port,serverPort:Number(new URL(b.url).port),fixtureRoot:b.fx.root}));
    console.log('WRAP_BROWSER '+JSON.stringify(await b.page.client.send('Browser.getVersion')));
    for(const [index, data] of [
      {name:'legal159',text:longSummary,phrase:longSummary},
      {name:'short-compound',text:shortSummary,phrase:shortPhrase},
    ].entries()) {
      const before=cardAuditSnapshot(b.fx);
      await openEditor(b.page);
      await fill(b.page,'card-summary',data.text);
      const response=profilesResponse(b.page);
      await click(b.page,marker('save-profile-card'));
      const status=(await response).status;
      assert.equal(status,200,'real metadata setter accepts the legal description');
      await saved(b.page);
      assert.equal(b.posts[index].changes[0].kind,'setProfileCard');
      assert.equal(b.posts[index].changes[0].summary,data.text);
      const stored=readJson(path.join(b.fx.home,cardsFile)).cards[base].summary;
      assert.equal(stored,data.text,'exact persisted summary');
      assertCardApplyAudit(before,cardAuditSnapshot(b.fx),b.posts[index]);
      assert.deepEqual(b.fx.reopen().state().activeProfile,active);
      console.log('WRAP_SETTER '+JSON.stringify({name:data.name,status,unicodeLength:[...stored].length,
        jsLength:stored.length,summary:stored,change:b.posts[index].changes[0]}));
      for(const size of viewports) for(const theme of ['light','dark']) {
        await t.test(`${data.name} ${size.width} ${theme}`,async()=>{
          await b.page.client.send('Emulation.setDeviceMetricsOverride',size);
          await b.page.client.send('Emulation.setTouchEmulationEnabled',{enabled:size.mobile});
          await b.page.client.send('Emulation.setEmulatedMedia',{
            features:[{name:'prefers-color-scheme',value:theme}],
          });
          await openProfiles(b.page,b.url);
          await settle(b.page);
          const actual=await measure(b.page,data.phrase);
          const name=data.name+'-'+size.width+'-'+theme;
          for(const [surface,selector] of [['card',cardSummary],['detail',detailSummary]]) {
            await b.page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
            await capture(b.page,name+'-'+surface);
          }
          if(process.env.OMO_CARD_EDITOR_EVIDENCE) fs.writeFileSync(
            path.join(process.env.OMO_CARD_EDITOR_EVIDENCE,name+'.measurement.json'),
            JSON.stringify(actual,null,2)+'\n');
          console.log('WRAP_MEASUREMENT '+JSON.stringify({name,mainOverflow:actual.mainOverflow,
            documentOverflow:actual.documentOverflow,paragraphs:actual.paragraphs.map(p=>({
              selector:p.selector,clientWidth:p.clientWidth,scrollWidth:p.scrollWidth,
              rows:p.phraseRows.length,outside:p.glyphs.filter(g=>g.x<p.box.x-1 || g.right>p.box.right+1).length,
            }))}));
          for(const p of actual.paragraphs) {
            assert.equal(p.text,data.text,'all original characters survive rendering');
            assert.equal(p.phrase,data.phrase);
            assert.equal(p.overflowX,'visible','description is not clipped or scroll-wrapped');
            assert.equal(p.overflowY,'visible');
            assert.equal(p.clipPath,'none');
            assert.equal(p.phraseOverflowX,'visible');
            assert.equal(p.phraseOverflowY,'visible');
            assert.equal(p.phraseClipPath,'none');
            assert.ok(p.scrollWidth<=p.clientWidth+1,'description stays inside its content width');
            assert.deepEqual(p.glyphs.filter(g=>g.x<p.box.x-1 || g.right>p.box.right+1 ||
              g.y<p.box.y-1 || g.bottom>p.box.bottom+1),[],'every rendered glyph fits the description');
            if(data.name==='short-compound') {
              assert.equal(p.phraseRows.length,1,'a short compound fitting the paragraph stays together');
              if(p.previous && p.box.right-p.previous.right<p.phraseBox.width-1)
                assert.ok(p.phraseBox.y>p.previous.y+1,'insufficient remaining space moves the whole compound');
            }
          }
          assert.equal(actual.mainOverflow,0,'legal summary creates no horizontal main scroll');
          assert.equal(actual.documentOverflow,0);
          assert.match(actual.mainScroll,/auto|scroll/);
          assert.deepEqual(actual.selected,[base]);
          assert.equal(actual.busy,'false');
        });
      }
    }
    assert.equal(b.posts.length,2,'only the two legal metadata setters write');
  });
