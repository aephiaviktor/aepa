const {app,BrowserWindow}=require('electron');const path=require('path'),fs=require('fs');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs')}});const errors=[];w.webContents.on('console-message',(_e,_l,m)=>{if(m.includes('Error'))errors.push(m)});await w.loadFile(path.join(__dirname,'ui/index.html'));await new Promise(r=>setTimeout(r,1000));try{const result=await w.webContents.executeJavaScript(`(async()=>{
const check=(v,m)=>{if(!v)throw Error(m)};
document.getElementById('show-automation').click();
const row=document.querySelector('.automation-fleet-row');check(row,'row missing');
const initialDestination=row.querySelector('[data-field="destination"]');initialDestination.value='belt';initialDestination.dispatchEvent(new Event('change'));
const pick=row.querySelector('.resource-picker');pick.open=true;
for(const box of pick.querySelectorAll('input:checked')) box.click();
const boxes=[...pick.querySelectorAll('input')];check(boxes.length===10,'ten resources');boxes.slice(0,8).forEach(b=>b.click());
check(pick.querySelector('summary').textContent.includes('8/8'),'counter');check(boxes[8].disabled,'ninth disabled');check(!boxes[0].disabled,'selected removable');
boxes[0].click();check(!boxes[8].disabled,'deselect enables');boxes[0].click();
const dest=row.querySelector('[data-field="destination"]');check(dest.options[2].disabled,'cross-system disabled');
dest.value='belt2';dest.dispatchEvent(new Event('change'));check(pick.querySelectorAll('input:checked').length===2,'selection intersection');check(pick.textContent.includes('removed'),'removed notice');
check(row.querySelector('[data-field="home"]').textContent.includes('1-UN'),'number-first neutral');
await document.getElementById('save-assignment').onclick();check(document.querySelector('.resource-picker summary').textContent.includes('2/8'),'save reload');
document.querySelector('.resource-picker').open=true;
return {checks:8,selected:JSON.parse(localStorage.getItem('aepa.automationDrafts.v2'))[0].resourceIds};
})()`);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({result,errors},null,2));await new Promise(r=>setTimeout(r,1000));fs.writeFileSync(path.join(__dirname,'screenshot.png'),(await w.webContents.capturePage()).toPNG());app.exit(0);}catch(e){fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({error:e.message,errors}));app.exit(1)}});
