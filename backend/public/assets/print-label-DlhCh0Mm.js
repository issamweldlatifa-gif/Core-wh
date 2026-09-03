import{E as m,Q as c,B as p}from"./Encoder-BiNMo8QT.js";function g(t,i){const e=new Map([[m.MARGIN,1]]),n=new c().encode(t,p.QR_CODE,0,0,e),o=n.getWidth(),s=n.getHeight();let l="";for(let r=0;r<s;r+=1)for(let d=0;d<o;d+=1)n.get(d,r)&&(l+=`<rect x="${d}" y="${r}" width="1" height="1"/>`);return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o} ${s}" width="${i}" height="${i}" shape-rendering="crispEdges" fill="#000">${l}</svg>`}function a(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function b(t){return`<!doctype html>
<html><head><meta charset="utf-8"><title>AYROVI label</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Courier New', ui-monospace, monospace; background: #fff; color: #000;
         display: flex; flex-wrap: wrap; gap: 8mm; padding: 8mm; }
  .label { width: 100mm; border: 2px solid #000; padding: 6mm; text-align: center;
           page-break-inside: avoid; }
  .kind { font-size: 11px; letter-spacing: 0.25em; border-bottom: 1px solid #000;
          padding-bottom: 3mm; margin-bottom: 3mm; }
  .big { font-size: 34px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
         margin-bottom: 3mm; word-break: break-word; }
  .qr { margin: 2mm 0; }
  .code { font-size: 20px; font-weight: 700; letter-spacing: 0.12em; margin-top: 2mm; }
  .line { display: flex; justify-content: space-between; font-size: 12px; margin-top: 2mm;
          border-top: 1px dashed #999; padding-top: 2mm; }
  .line .k { color: #555; letter-spacing: 0.1em; }
  @media print { body { padding: 0; gap: 4mm; } }
</style></head><body>${t.map(e=>{const n=(e.lines??[]).map(o=>`<div class="line"><span class="k">${a(o.k)}</span><span class="v">${a(o.v)}</span></div>`).join("");return`
  <div class="label">
    <div class="kind">${a(e.kind)}</div>
    ${e.bigLabel?`<div class="big">${a(e.bigLabel)}</div>`:""}
    <div class="qr">${g(e.code,220)}</div>
    <div class="code">${a(e.code)}</div>
    ${n}
  </div>`}).join("")}
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},150);});<\/script>
</body></html>`}function w(t){const i=Array.isArray(t)?t:[t],e=window.open("","_blank","width=480,height=640");e&&(e.document.write(b(i)),e.document.close())}export{w as p};
