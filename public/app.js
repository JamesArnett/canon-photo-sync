const main = document.querySelector('#main');
const connection = document.querySelector('#connection');
const notice = document.querySelector('#notice');
const signIn = document.querySelector('#signin');
const logout = document.querySelector('#logout');
let csrf, refresh, timer, generation = 0, currentDevice, noticeTimer;
let filter = new URLSearchParams();
let offset = 0;
const views = ['dashboard','cameras','activity','settings'];
const formats = ['jpg','jpeg','cr3','hif','heif','heic','mp4','mov'];
const layouts = ['flat','date','camera','camera-date'];
const eventNames = {
  completed:'Synchronization completed',completedErrors:'Synchronization completed with errors',transferFailed:'Transfer failed after retries',
  connected:'Camera connected',disconnected:'Camera disconnected',interrupted:'Camera interrupted during synchronization',
  stalled:'Synchronization stalled',lowBattery:'Low camera battery',cameraSpace:'Camera storage nearly full',nasSpace:'NAS storage nearly full',
  destination:'Destination unavailable',cameraError:'Camera connectivity or authentication error',applicationError:'Application error'
};
const defaultPush = new Set(['completed','completedErrors','transferFailed','interrupted','stalled','nasSpace','destination','cameraError','applicationError']);
const element = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
};
const add = (parent,...children) => { parent.append(...children.filter(Boolean)); return parent; };
const time = value => value ? new Date(value).toLocaleString() : '—';
const bytes = value => {
  if (value == null) return 'Unavailable';
  const i = Math.min(4,Math.floor(Math.log(Math.max(1,value))/Math.log(1024)));
  return new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(value/1024**i)+' '+['B','KiB','MiB','GiB','TiB'][i];
};
const seconds = value => value == null ? '—' : new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(value)+' s';
const announce = text => {
  notice.textContent=text;
  clearTimeout(noticeTimer);
  noticeTimer=setTimeout(()=>{notice.textContent='';},5000);
};
async function api(path, method='GET', data) {
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),30000);
  try {
    const response = await fetch(path,{method,cache:'no-store',headers:method==='GET'?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf??''},
      body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal});
    const value=await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error??'Request failed'),{status:response.status});
    return value;
  } finally {
    clearTimeout(deadline);
  }
}
function button(label, action, className) {
  const item=element('button',label,className);
  item.type='button';
  item.addEventListener('click',async()=>{
    item.disabled=true;
    try { await action(); } catch(error) { announce(error.message); }
    finally { item.disabled=false; }
  });
  return item;
}
function field(label,name,value,type='text',options=[]) {
  const wrapper=element('label',undefined,type==='checkbox'?'check':'field');
  const input=element(type==='select'?'select':'input');
  input.name=name;
  if (type==='select') {
    for(const option of options) {
      const [key,text]=Array.isArray(option)?option:[option,option];
      const item=element('option',text);item.value=key;input.append(item);
    }
  } else input.type=type;
  if (type==='checkbox') {input.checked=Boolean(value);add(wrapper,input,label);}
  else {input.value=value??'';add(wrapper,label,input);}
  return wrapper;
}
function editor(title,fields,submit) {
  const form=element('form');
  const save=element('button','Save','primary');save.type='submit';
  add(form,element('h2',title),add(element('div',undefined,'fields'),...fields),save);
  form.addEventListener('submit',async event=>{
    event.preventDefault();save.disabled=true;
    try {await submit(form.elements,new FormData(form));announce('Saved');} catch(error){announce(error.message);}
    finally{save.disabled=false;}
  });
  return form;
}
const section = (title,...content)=>add(element('section',undefined,'panel'),element('h2',title),...content);
const commands = (...items)=>add(element('div',undefined,'actions'),...items);
const entry = (title,...content)=>add(element('article',undefined,'tile'),element('h3',title),...content);
const command = (text,path,method='POST',data={})=>button(text,async()=>{await api(path,method,data);announce('Request accepted');await refresh?.();});
const href = (text,url,style)=>{const link=element('a',text,style);link.href=url;return link;};
const values = (form,keys) => Object.fromEntries(keys.map(key=>[key,form.get(key)]));
function statusPanel(title,value) {return add(element('div',undefined,'tile'),element('div',value,'metric'),element('div',title,'muted'));}
async function dashboard(epoch) {
  refresh=async()=>{
    const status=await api('/api/status');
    if(epoch!==generation)return;
    connection.textContent='Connected';
    if (!document.activeElement?.closest('#dashboard-controls, #camera-status')) render(status);
    else updateTransferStatus(status);
  };
  function updateTransferStatus(status) {
    const target=main.querySelector('#current-transfers');
    if(target)target.replaceChildren(status.active.length?add(element('div',undefined,'grid'),...status.active.map(item=>{
      const bar=element('progress');
      if(item.size){bar.max=item.size;bar.value=item.bytes;}
      bar.setAttribute('aria-label','Transfer progress');
      return entry(item.name,element('p',status.cameras.find(camera=>camera.id===item.camera)?.name??'Camera'),
        bar,element('small',bytes(item.bytes)+' / '+bytes(item.size)+' · '+bytes(item.speed)+'/s · '+seconds(item.elapsed)+' elapsed · '+seconds(item.remaining)+' remaining'));
    })):element('p','No active transfers','muted'));
  }
  function render(status) {
    const count=state=>status.counts.find(item=>item.status===state)?.count??0;
    const done=status.counts.find(item=>item.status==='done');
    const controls=commands(command('Synchronize now','/api/sync'),button(status.paused?'Resume all':'Pause all',async()=>{
      const {settings}=await api('/api/settings');
      await api('/api/settings','PUT',{...settings,paused:!status.paused});await renderView();
    }),command('Retry failed','/api/retry'),href('View activity','#activity','button'));
    controls.id='dashboard-controls';
    const cameraGrid=element('div',undefined,'grid');cameraGrid.id='camera-status';
    for(const camera of status.cameras) {
      const counts=state=>status.cameraCounts.find(row=>row.camera===camera.id&&row.status===state)?.count??0;
      cameraGrid.append(entry(camera.name,element('p',camera.status,'pill'),element('p',(camera.identity?.model??'Model pending')+' · '+camera.address,'muted'),
        element('p','Queued '+counts('queued')+' · Failed '+(counts('failed')+counts('review'))),
        element('p','Last connection '+time(camera.lastConnection)+' · Last synchronization '+time(camera.lastSync),'muted'),
        camera.identity?.battery!=null&&element('p','Battery '+camera.identity.battery+'%'),
        camera.identity?.free!=null&&element('p','Camera storage '+bytes(camera.identity.free)),
        camera.estimate&&element('p','Latest discovery · '+camera.estimate.files+' files · '+bytes(camera.estimate.bytes)+(camera.estimate.unknown?' + unknown sizes':'')),
        camera.error&&element('p',camera.error,'danger'),
        commands(command('Sync camera','/api/sync','POST',{camera:camera.id}),button(camera.paused?'Resume camera':'Pause camera',async()=>{
          const row=(await api('/api/cameras')).find(row=>row.id===camera.id);
          const {id,created,...config}=row;
          await api('/api/cameras/'+id,'PUT',{...config,paused:!config.paused});await renderView();
        }))));
    }
    const previews=add(element('div',undefined,'grid'),...status.recent.map(item=>{
      const preview=element(item.thumbnail?'img':'div',item.thumbnail?undefined:item.kind.toUpperCase(),item.thumbnail?'preview':'preview placeholder');
      if(item.thumbnail){preview.src='/api/thumbnail/'+item.thumbnail;preview.alt='';preview.loading='lazy';}
      const media=JSON.parse(item.media);
      return add(element('article',undefined,'tile'),preview,element('h3',item.name),
        element('p',(status.cameras.find(row=>row.id===item.camera)?.name??'Archived camera')+' · '+item.kind.toUpperCase()),
        element('small',(media.captured?'Captured '+time(media.captured):'Camera file modified '+time(media.modified))+' · Imported '+time(item.completed)+' · '+item.status+' · '+item.verification));
    }));
    const current=element('div');current.id='current-transfers';
    main.replaceChildren(add(element('div',undefined,'heading'),element('h1','Dashboard'),controls),
      add(element('div',undefined,'grid metrics'),statusPanel('Service uptime',seconds(status.uptime/1000)),statusPanel('Connected cameras',status.cameras.filter(row=>['connected','synchronizing','busy'].includes(row.status)).length),
        statusPanel('Pending',count('queued')),statusPanel('Active',status.active.length),statusPanel('Failed or needs review',count('failed')+count('review')),
        statusPanel('Imported files',done?.count??0),statusPanel('Imported data',bytes(done?.bytes??0)),statusPanel('Destination free',bytes(status.free))),
      element('p','Last completed import '+time(done?.last),'muted'),element('h2','Cameras'),
      status.cameras.length?cameraGrid:element('p','Add a camera to begin importing.','muted'),
      section('Current transfers',current),element('h2','Recent photographs'),
      status.recent.length?previews:element('p','Imported photographs will appear here.','muted'));
    updateTransferStatus(status);
  }
  await refresh();
}
function eventFields(config, inherit, defaults=false) {
  return add(element('fieldset'),element('legend','Notification events'),
    ...Object.entries(eventNames).map(([event,label])=>inherit?
      field(label,'event-'+event,config[event]===undefined?'inherit':String(config[event]),'select',[['inherit','Use global setting'],['true','On'],['false','Off']]):
      field(label,'event-'+event,config[event]??(defaults?defaultPush.has(event):true),'checkbox')));
}
function eventValues(form, inherit) {
  return Object.fromEntries(Object.keys(eventNames).flatMap(event=>{
    const selection=form.get('event-'+event);
    return inherit?(selection==='inherit'?[]:[[event,selection==='true']]):[[event,selection==='on']];
  }));
}
function directoryField(label,value) {
  const wrapper=field(label,'destination',value);
  const input=wrapper.querySelector('input');
  return add(element('div'),wrapper,commands(button('Browse directories',()=>browse(input)),button('Test destination',async()=>{
    const {free}=await api('/api/directories','POST',{path:input.value});announce(bytes(free)+' free and writable');
  })));
}
async function browse(input) {
  const dialog=element('dialog');
  const list=element('div',undefined,'dir-list');
  add(dialog,element('h2','Select import directory'),list,button('Close',()=>dialog.close()));
  document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  const {roots}=await api('/api/directories');
  async function open(path) {
    if(!path){list.replaceChildren(...roots.map(root=>button(root,()=>open(root))));return;}
    const data=await api('/api/directories?path='+encodeURIComponent(path));
    const folder=field('New subdirectory name','folder','');
    const parent=path.substring(0,path.lastIndexOf('/'));
    list.replaceChildren(element('p',path),element('small',bytes(data.free)+' free'),
      commands(button('Up',()=>open(roots.includes(path)?undefined:parent)),button('Select this directory',()=>{input.value=path;dialog.close();})),
      ...data.directories.map(name=>button(name,()=>open(path+'/'+name))),
      folder,button('Create subdirectory',async()=>{
        const name=folder.querySelector('input').value;
        if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\'))throw Error('Enter a single directory name');
        await api('/api/directories','POST',{path:path+'/'+name,create:true});await open(path+'/'+name);
      }));
  }
  await open();dialog.showModal();
}
async function camerasView(epoch) {
  const cameras=await api('/api/cameras');
  if(epoch!==generation)return;
  function cameraEditor(camera={}) {
    const cardRecording=field('Canon card recording','cardRecording',camera.cardRecording??'all','select',[
      ['all','Scan both cards'],['duplicate-stills','Duplicate stills (prefer card 1)']]);
    const recordingHint=element('small','Use Duplicate stills with Rec. to multiple for photos. Matching folders and filenames use card 1. Card 2 is checked for unmatched files and videos.');
    recordingHint.id='card-recording-help-'+(camera.id??'new');
    cardRecording.querySelector('select').setAttribute('aria-describedby',recordingHint.id);
    const timeZone=field('Camera time zone (Canon)','timeZone',camera.timeZone);
    const timeZoneInput=timeZone.querySelector('input');
    timeZoneInput.placeholder='America/Los_Angeles';
    const timeZoneHint=element('small','Enter the named time zone your camera clock follows. Newer than setup and date folders use its rules for each file’s date.');
    timeZoneHint.id='camera-time-zone-help-'+(camera.id??'new');
    timeZoneInput.setAttribute('aria-describedby',timeZoneHint.id);
    const fields=[
      field('Friendly name','name',camera.name),field('Address including scheme and port','address',camera.address,'url'),
      field('Expected serial number','serial',camera.serial),field('Credential or certificate profile','secretRef',camera.secretRef),
      directoryField('Import directory override',camera.destination),field('Directory organization','layout',camera.layout??'','select',[['','Use default'],...layouts]),
      field('Media extensions override, comma separated','media',camera.media?.join(',')),field('Poll seconds override','poll',camera.poll,'number'),
      add(element('div'),cardRecording,recordingHint),
      field('Concurrent transfers (custom adapter only)','concurrency',camera.concurrency??1,'number'),field('Priority (0–10)','priority',camera.priority??5,'number'),
      field('First import','mode',camera.mode??'all','select',[['all','Import all existing media'],['new','Newer than setup (camera file time)']]),
      add(element('div'),timeZone,timeZoneHint),
      field('Enabled','enabled',camera.enabled??true,'checkbox'),field('Paused','paused',camera.paused,'checkbox'),eventFields(camera.notifications??{},true)
    ];
    const form=editor(camera.id?'Camera settings':'Add a camera',fields,async(_,data)=>{
      const config={...values(data,['name','address','serial','mode','cardRecording']),concurrency:Number(data.get('concurrency')),
        priority:Number(data.get('priority')),enabled:data.has('enabled'),paused:data.has('paused'),notifications:eventValues(data,true)};
      for(const key of ['destination','layout','secretRef'])if(data.get(key))config[key]=data.get(key);
      const zone=String(data.get('timeZone')??'').trim();
      if(zone)config.timeZone=zone;
      if(data.get('media'))config.media=String(data.get('media')).split(',').map(value=>value.trim().toLowerCase());
      if(data.get('poll'))config.poll=Number(data.get('poll'));
      await api('/api/cameras'+(camera.id?'/'+camera.id:''),camera.id?'PUT':'POST',config);
      await renderView();
    });
    if(camera.id) {
      form.elements.serial.readOnly=true;
      form.append(commands(button('Test connectivity',async()=>{
        const result=await api('/api/cameras/'+camera.id+'/test','POST',{});
        announce(result.matches?result.identity.model+' identity confirmed':'Camera serial does not match');
      }),button('Estimate matching media',async()=>{
        const result=await api('/api/cameras/'+camera.id+'/estimate','POST',{});
        announce(result.files+' matching files · '+bytes(result.bytes)+(result.unknown?' + '+result.unknown+' unknown sizes':''));
      }),button('Remove configuration',async()=>{
        if(!window.confirm('Remove this camera configuration? Transfer history is retained.'))return;
        await api('/api/cameras/'+camera.id,'DELETE',{});await renderView();
      },'danger')));
    }
    return form;
  }
  main.replaceChildren(element('h1','Cameras'),...cameras.map(camera=>add(element('details',undefined,'panel'),element('summary',camera.name+' · '+(camera.enabled?'Enabled':'Disabled')),cameraEditor(camera))),cameraEditor());
}
async function activity(epoch) {
  const [history,cameras,recent]=await Promise.all([api('/api/history?'+new URLSearchParams([...filter,['offset',offset]])),api('/api/cameras'),api('/api/events')]);
  if(epoch!==generation)return;
  const filters=editor('Filter transfers',[
    field('Filename','search',filter.get('search')),field('Camera','camera',filter.get('camera')??'','select',[['','All cameras'],...cameras.map(row=>[row.id,row.name])]),
    field('Status','status',filter.get('status')??'','select',[['','All statuses'],'queued','downloading','publishing','done','duplicate','failed','review','cancelled']),
    field('Media type','kind',filter.get('kind')??'','select',[['','All formats'],...formats]),
    field('From','from',filter.get('from'),'date'),field('To','to',filter.get('to'),'date')
  ],async(_,data)=>{filter=new URLSearchParams([...data].filter(([,value])=>value));offset=0;await renderView();});
  filters.querySelector('[type=submit]').textContent='Apply filters';
  const entries=history.items.map(row=>add(element('tr'),
    add(element('td'),add(element('details'),element('summary',row.name+' · '+row.status),
      element('p','Source '+JSON.parse(row.media).path),row.destination&&element('p','Destination '+row.destination),
      element('p',(row.verification??'Verification pending')+' · Attempts '+row.attempts+' · Duration '+seconds(row.duration==null?null:row.duration/1000)),
      row.hash&&element('p','SHA-256 '+row.hash),row.error&&element('p',row.error,'danger'),
      row.status==='failed'&&command('Retry','/api/retry','POST',{id:row.id}),
      ['done','duplicate'].includes(row.status)&&button('Reimport original',async()=>{
        if(window.confirm('Queue a separate copy of this original?')){await api('/api/reimport','POST',{id:row.id});announce('Reimport queued');}
      }))),
    element('td',cameras.find(camera=>camera.id===row.camera)?.name??'Archived camera','history-meta'),
    element('td',row.kind.toUpperCase()+' · '+bytes(row.size),'history-meta'),element('td',time(row.completed),'history-meta')));
  const headers=['File and status','Camera','Format and size','Imported'].map(text=>{
    const cell=element('th',text);cell.scope='col';return cell;
  });
  const table=add(element('table'),add(element('thead'),add(element('tr'),...headers)),add(element('tbody'),...entries));
  main.replaceChildren(element('h1','Activity'),filters,commands(href('Export CSV','/api/export?'+new URLSearchParams([...filter,['format','csv']]),'button'),
    href('Export JSON','/api/export?'+new URLSearchParams([...filter,['format','json']]),'button'),command('Retry failed','/api/retry')),
    section('Transfers',entries.length?table:element('p','No matching transfers.'),
      commands(offset>0&&button('Previous page',async()=>{offset-=50;await renderView();}),history.more&&button('Next page',async()=>{offset+=50;await renderView();}))),
    section('Recent events',...recent.items.map(item=>element('p',time(item.time)+' · '+item.message)),
      element('h2','Push submissions'),...recent.delivery.map(item=>element('p',time(item.time)+' · '+item.device+' · '+item.state))));
}
const subscriptionKey = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));
async function notificationDevices(vapid) {
  const devices=await api('/api/devices');
  const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
  if('serviceWorker' in navigator && 'PushManager' in window) {
    const registration=await navigator.serviceWorker.getRegistration();
    const subscription=await registration?.pushManager.getSubscription();
    if(subscription){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subscription.endpoint));
      currentDevice=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    } else currentDevice=undefined;
  }
  const panel=section('Notifications',element('p',ios&&!standalone?
    'On iPhone or iPad, open Safari’s Share menu, choose Add to Home Screen, then enable notifications from the installed app.':
    'Notifications can arrive away from home. Opening the dashboard requires a connection to your home network or existing VPN.','muted'),
    element('p','Browser permission · '+(window.Notification?.permission??'Unavailable')));
  const device=devices.find(row=>row.id===currentDevice);
  const form=editor(device?'This device':'Register this device',[
    field('Device name','name',device?.name??'This browser'),field('Use quiet hours','quiet',Boolean(device?.quiet),'checkbox'),
    field('Quiet hours start (0–23)','from',device?.quiet?.from??22,'number'),field('Quiet hours end (0–23)','to',device?.quiet?.to??7,'number'),
    field('Allow urgent events during quiet hours','urgent',device?.quiet?.allowUrgent??true,'checkbox'),eventFields(device?.events??{},false)
  ],async(_,data)=>{
    if(!('Notification' in window)||!('serviceWorker' in navigator)||!('PushManager' in window)||(ios&&!standalone)) throw Error('Install the PWA on a supported browser first');
    if(await Notification.requestPermission()!=='granted')throw Error('Notification permission was not granted');
    const registration=await navigator.serviceWorker.getRegistration();
    if(!registration?.active)throw Error('Reload after the service worker is installed');
    const subscription=await registration.pushManager.getSubscription()??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:subscriptionKey(vapid)});
    await api('/api/devices','PUT',{name:data.get('name'),subscription:subscription.toJSON(),events:eventValues(data,false),
      quiet:data.has('quiet')?{from:Number(data.get('from')),to:Number(data.get('to')),offset:-new Date().getTimezoneOffset(),allowUrgent:data.has('urgent')}:undefined});
    await renderView();
  });
  form.querySelector('[type=submit]').textContent=device?'Save device preferences':'Enable notifications';
  panel.append(form,command('Send test notification','/api/push-test'));
  for(const item of devices)panel.append(commands(element('span',item.name),button('Remove device',async()=>{
    await api('/api/devices/'+item.id,'DELETE',{});
    if(item.id===currentDevice){const reg=await navigator.serviceWorker.getRegistration();await (await reg?.pushManager.getSubscription())?.unsubscribe();}
    await renderView();
  })));
  return panel;
}
async function settingsView(epoch) {
  const [{settings,bootstrap,vapid,system},status]=await Promise.all([api('/api/settings'),api('/api/status')]);
  const devices=await notificationDevices(vapid);
  if(epoch!==generation)return;
  const numbers={concurrency:'Global concurrency',poll:'Default poll interval (seconds)',retries:'Retries per transfer',minimumBytes:'Free-space reserve (bytes)',
    thumbnailBytes:'Thumbnail cache (bytes)',batchSeconds:'Batch quiet period (seconds)',eventDays:'Event retention (days)',
    batteryThreshold:'Camera battery alert (%)',cameraMinimumBytes:'Camera free-space alert (bytes)'};
  const general=editor('General settings',[directoryField('Default import directory',settings.destination),
    field('Folder organization','layout',settings.layout,'select',layouts),field('Default media extensions','media',settings.media.join(',')),
    ...Object.entries(numbers).map(([key,label])=>field(label,key,settings[key],'number')),
    field('Appearance','appearance',settings.appearance,'select',['system','light','dark']),
    field('Pause synchronization','paused',settings.paused,'checkbox'),field('Hide lock-screen transfer details','privatePush',settings.privatePush,'checkbox'),
    eventFields(settings.notifications,false,true)],async(_,data)=>{
    const next={...settings,...values(data,['destination','layout','appearance']),
      ...Object.fromEntries(Object.keys(numbers).map(key=>[key,Number(data.get(key))])),
      media:String(data.get('media')).split(',').map(value=>value.trim().toLowerCase()),paused:data.has('paused'),privatePush:data.has('privatePush'),notifications:eventValues(data,false)};
    await api('/api/settings','PUT',next);document.documentElement.dataset.theme=next.appearance;await renderView();
  });
  main.replaceChildren(element('h1','Settings'),general,devices,section('System',
    element('p','Canon Photo Sync '+status.version+' · Node '+status.runtime+' · Memory '+bytes(status.rss)),
    element('p','Uptime '+seconds(status.uptime/1000)+' · Destination free '+bytes(status.free)),
    element('p','OIDC issuer '+bootstrap.issuer+' · '+system.oidc),element('p','Database '+system.database+' · Push devices '+system.pushDevices),element('p','Infrastructure settings are loaded at daemon startup.')));
}
function clearProtected(message) {
  csrf=undefined;refresh=undefined;currentDevice=undefined;filter=new URLSearchParams();offset=0;
  document.documentElement.removeAttribute('data-theme');
  for(const dialog of document.querySelectorAll('dialog'))dialog.remove();
  main.replaceChildren(element('h1','Canon Photo Sync'),element('p',message,'muted'));
  logout.hidden=true;
}
async function renderView() {
  const epoch=++generation;
  refresh=undefined;
  const name=views.includes(location.hash.slice(1))?location.hash.slice(1):'dashboard';
  for(const link of document.querySelectorAll('nav a'))link.getAttribute('href')==='#'+name?link.setAttribute('aria-current','page'):link.removeAttribute('aria-current');
  try {
    if(!csrf){
      const session=await api('/api/session');
      if(epoch!==generation)return;
      csrf=session.csrf;
      document.documentElement.dataset.theme=(await api('/api/settings')).settings.appearance;
    }
    if(epoch!==generation)return;
    connection.textContent='Connected';signIn.hidden=true;logout.hidden=false;
    await ({dashboard,cameras:camerasView,activity,settings:settingsView}[name])(epoch);
  } catch(error) {
    if(epoch!==generation)return;
    unavailable(error);
  }
}
function unavailable(error) {
  if(error.status===401){connection.textContent='Signed out';clearProtected('Sign in with Synology SSO to open your dashboard.');signIn.hidden=false;}
  else {connection.textContent='Disconnected';clearProtected('Dashboard unavailable. Connect to your home network or VPN and try again.');signIn.hidden=true;main.append(button('Reconnect',renderView));}
}
function schedule() {
  clearTimeout(timer);
  if(document.hidden)return;
  timer=setTimeout(async()=>{
    try {if(refresh)await refresh();else if(csrf)await api('/api/session');}
    catch(error){unavailable(error);}
    schedule();
  },5000);
}
logout.addEventListener('click',async()=>{
  try{const result=await api('/auth/logout','POST',{});generation++;clearProtected('Signed out.');location.assign(result.redirect);}
  catch(error){announce(error.message);}
});
window.addEventListener('hashchange',()=>void renderView());
window.addEventListener('online',()=>void renderView());
window.addEventListener('offline',()=>{generation++;unavailable(new Error('Offline'));});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&(!csrf||refresh))void renderView();schedule();});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
void renderView();
schedule();
