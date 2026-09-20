
class Component extends DCLogic {
  state = {
    screen: 'login', loginVariant: 'split', loginRole: 'superadmin',
    role: 'superadmin', nav: 'dashboard', device: 'desktop',
    search: '', filter: 'all', rowStatus: {}, userRoles: {}, requested: false, sidebarCollapsed: false,
    theme: null, notifOpen: false, range: 'This week', rangeOpen: false, skin: 'neumorphic',
    whPanels: {ops:{x:292,y:120,min:false}, work:{x:300,y:548,min:false}, pick:{x:716,y:548,min:false}}, opsOpen:true
  };

  CLS = {
    natural:{label:'Natural', bg:'#E4F0E9', fg:'#2E6B4A', lite:'#5FBF93'},
    aroma:{label:'Aroma chem', bg:'#E5EDF7', fg:'#2D5C8A', lite:'#5C9BDA'},
    base:{label:'Base', bg:'#F6ECD8', fg:'#9A6B1E', lite:'#D6A24A'},
    solvent:{label:'Solvent', bg:'#EBEDF0', fg:'#5A626C', lite:'#9AA3B2'}
  };
  STATUS = {
    pending:{label:'Pending', bg:'#F8EFD8', fg:'#9A6B1E', dot:'#D9A53B'},
    pass:{label:'Pass', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'},
    fail:{label:'Fail', bg:'#FBE6E1', fg:'#C0492E', dot:'#D85A38'},
    approved:{label:'Approved', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'},
    ordered:{label:'Ordered', bg:'#E5EDF7', fg:'#2D5C8A', dot:'#3B7BC0'},
    draft:{label:'Draft', bg:'#EBEDF0', fg:'#5A626C', dot:'#9298A2'},
    received:{label:'Received', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'},
    inprogress:{label:'In progress', bg:'#E5EDF7', fg:'#2D5C8A', dot:'#3B7BC0'},
    hold:{label:'On hold', bg:'#F8EFD8', fg:'#9A6B1E', dot:'#D9A53B'},
    planning:{label:'Planning', bg:'#EBEDF0', fg:'#5A626C', dot:'#9298A2'},
    ok:{label:'In place', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'},
    hazard:{label:'Flammable', bg:'#FBE6E1', fg:'#B6452C', dot:'#C0492E'},
    low:{label:'Low stock', bg:'#F8EFD8', fg:'#9A6B1E', dot:'#D9A53B'},
    filling:{label:'Filling', bg:'#E5EDF7', fg:'#2D5C8A', dot:'#3B7BC0'},
    done:{label:'Filled', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'},
    queued:{label:'Queued', bg:'#EBEDF0', fg:'#5A626C', dot:'#9298A2'},
    released:{label:'Released', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'},
    active:{label:'Active', bg:'#E2F1E9', fg:'#2E7D55', dot:'#34A56F'}
  };
  ICONS = {
    grid:'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    layers:'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    lock:'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    shield:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    clipboard:'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2',
    sliders:'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    truck:'M1 4h13v11H1zM14 8h4l3 3v4h-7zM6 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0M21 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    box:'M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
    flask:'M9 3h6M10 3v6L5 19a1 1 0 0 0 1 1.5h12A1 1 0 0 0 19 19l-5-10V3M7.5 14h9',
    beaker:'M6 3h12M8 3v7l-3 8a1 1 0 0 0 1 1.3h12A1 1 0 0 0 19 18l-3-8V3',
    droplet:'M12 3l5.5 6.5a7 7 0 1 1-11 0z',
    tag:'M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7 7h.01',
    mail:'M3 5h18v14H3zM3 6l9 7 9-7',
    refresh:'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
    check:'M20 6 9 17l-5-5',
    list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    calendar:'M3 5h18v16H3zM3 9h18M8 3v4M16 3v4',
    activity:'M22 12h-4l-3 9L9 3l-3 9H2',
    bell:'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    search:'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    scan:'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18',
    download:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    pause:'M6 4h4v16H6zM14 4h4v16h-4z',
    pkg:'M16 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10',
    building:'M3 21h18M6 21V4h8v17M14 9h4v12M9 8h.01M9 12h.01M9 16h.01',
    panel:'M4 4h16v16H4zM10 4v16',
    sun:'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    moon:'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    chevron:'M6 9l6 6 6-6',
    minus:'M5 12h14',
    expand:'M15 3h6v6M14 10l7-7M9 21H3v-6M10 14l-7 7',
    play:'M6 4l14 8-14 8z',
    shelf:'M3 7h18M3 12h18M3 17h18M7 7v10M17 7v10',
    mappin:'M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11zM12 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
    grip:'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
    alert:'M12 9v4M12 17h.01M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z'
  };

  ROLE_ORDER = ['superadmin','admin','procurement','receiving','qc','warehouse','compounding','filling','packaging','noaccess'];
  ROLE_META = {
    superadmin:{label:'Super Admin', dept:'Controller', user:'Claire Beaumont', desc:'Full visibility · holds the formula index'},
    admin:{label:'Admin', dept:'Access & Governance', user:'Idris Karim', desc:'Manage users, assign roles'},
    procurement:{label:'Procurement', dept:'Procurement', user:'Priya Nair', desc:'Purchase orders & suppliers'},
    receiving:{label:'Receiving', dept:'Receiving', user:'Sofia Marsh', desc:'Deliveries & goods receipt'},
    qc:{label:'QC Laboratory', dept:'Quality Control', user:'Amélie Rousseau', desc:'Batch testing · pass / fail'},
    warehouse:{label:'Warehouse', dept:'Warehouse', user:'Tom Becker', desc:'Storage & shelf map'},
    compounding:{label:'Compounding', dept:'Compounding', user:'Marco Vinci', desc:'Masked worksheets'},
    filling:{label:'Filling', dept:'Filling', user:'Hana Müller', desc:'Fill tickets & line'},
    packaging:{label:'Packaging', dept:'Packaging', user:'Yusuf Demir', desc:'Labels & finished goods'},
    noaccess:{label:'Unassigned user', dept:'No role', user:'Lena Hoffmann', desc:'No role yet · awaiting access'}
  };
  NAV = {
    superadmin:[['dashboard','Dashboard','grid'],['runs','Master runs','layers'],['departments','Departments','building'],['vault','Formula vault','lock'],['users','Users','users'],['audit','Audit log','clipboard'],['settings','Settings','sliders']],
    admin:[['dashboard','Dashboard','grid'],['users','Users','users'],['roles','Roles','shield'],['invites','Invitations','mail'],['audit','Audit log','clipboard'],['settings','Settings','sliders']],
    procurement:[['dashboard','Dashboard','grid'],['pos','Purchase orders','clipboard'],['suppliers','Suppliers','truck'],['materials','Materials','box'],['reorder','Reorder','refresh']],
    receiving:[['dashboard','Dashboard','grid'],['deliveries','Deliveries','truck'],['grns','Goods receipt','clipboard'],['matching','PO matching','check'],['batches','Batches','layers']],
    qc:[['dashboard','Dashboard','grid'],['queue','Test queue','flask'],['reports','Reports','clipboard'],['specs','Specifications','list'],['holds','Holds','pause']],
    warehouse:[['dashboard','Floor map','mappin'],['shelf','Shelf map','shelf'],['stock','Stock','box'],['putaway','Putaway','layers'],['picks','Picks','tag']],
    compounding:[['dashboard','Dashboard','grid'],['worksheets','Worksheets','clipboard'],['batches','Batches','beaker'],['bases','Bases','layers'],['schedule','Schedule','calendar']],
    filling:[['dashboard','Dashboard','grid'],['tickets','Fill tickets','droplet'],['lots','Bulk lots','box'],['schedule','Schedule','calendar'],['output','Output','activity']],
    packaging:[['dashboard','Dashboard','grid'],['orders','Pack orders','box'],['labels','Labels','tag'],['finished','Finished goods','pkg'],['shipments','Shipments','truck']],
    noaccess:[]
  };

  // ---- handlers ----
  pickLoginRole(k){ this.setState({loginRole:k}); }
  setLoginVariant(v){ this.setState({loginVariant:v}); }
  signIn(){ this.setState({screen:'app', role:this.state.loginRole, nav:'dashboard', device:'desktop', search:'', filter:'all'}); }
  switchRole(k){ this.setState({role:k, nav:'dashboard', device:'desktop', search:'', filter:'all'}); }
  setNav(k){ this.setState({nav:k, search:'', filter:'all'}); }
  logout(){ this._session=null; this._live=null; try{ window.dispatchEvent(new CustomEvent('ra-logout')); }catch(e){} this.setState({screen:'login'}); }
  enterAs(role, session){ this._session=session||null; this.setState({screen:'app', role:role, nav:'dashboard', device:'desktop', search:'', filter:'all'}); }
  setLiveData(role, partial){ try{ window.__raLive=window.__raLive||{}; window.__raLive[role]=Object.assign({}, window.__raLive[role]||{}, partial); }catch(e){} try{ this.setState({_liveTick:(this.state._liveTick||0)+1}); }catch(e){} }
  setDevice(d){ this.setState({device:d}); }
  setSearch(v){ this.setState({search:v}); }
  setFilter(f){ this.setState({filter:f}); }
  mark(id, st){ const k=this.state.role+':'+id; this.setState(s=>({rowStatus:{...s.rowStatus,[k]:st}})); }
  assign(id, roleKey){ this.setState(s=>({userRoles:{...s.userRoles,[id]:roleKey}})); }
  requestAccess(){ this.setState({requested:true}); }
  toggleSidebar(){ this.setState(s=>({sidebarCollapsed:!s.sidebarCollapsed})); }
  toggleTheme(){ this.setState(s=>({theme:(s.theme||this.props.sidebarTheme||'light')==='dark'?'light':'dark'})); }
  toggleNotif(){ this.setState(s=>({notifOpen:!s.notifOpen})); }
  setSkin(k){ this.setState({skin:k}); }
  panelDown(id, e){ e.preventDefault(); const p=this.state.whPanels[id]; this._pd={id, ox:e.clientX-p.x, oy:e.clientY-p.y}; }
  panelMin(id){ this.setState(s=>({whPanels:{...s.whPanels,[id]:{...s.whPanels[id],min:!s.whPanels[id].min}}})); }
  componentDidMount(){ try{ window.__raApp=this; window.dispatchEvent(new CustomEvent('ra-app-ready')); }catch(e){} this._mm=(e)=>{ if(this._pd){ const o=this._pd; this.setState(s=>({whPanels:{...s.whPanels,[o.id]:{...s.whPanels[o.id],x:Math.max(2,e.clientX-o.ox),y:Math.max(2,e.clientY-o.oy)}}})); } }; this._mu=()=>{ this._pd=null; }; window.addEventListener('mousemove',this._mm); window.addEventListener('mouseup',this._mu); }
  componentWillUnmount(){ window.removeEventListener('mousemove',this._mm); window.removeEventListener('mouseup',this._mu); }
  cycleRange(){ const r=['This week','This month','This quarter','This year']; this.setState(s=>({range:r[(r.indexOf(s.range)+1)%r.length]})); }
  toggleRange(){ this.setState(s=>({rangeOpen:!s.rangeOpen})); }
  setRange(r){ this.setState({range:r, rangeOpen:false}); }
  barColor(key, dark){ if(key==='hazard') return dark?'#E5805F':'#B6452C'; if(key==='accent') return 'var(--accent)'; const c=this.CLS[key]; return c?(dark?c.lite:c.fg):'var(--accent)'; }
  exportCsv(d, role){
    const txt=(v)=>{ if(v==null) return ''; if(typeof v==='object'){ if(v.text!==undefined) return v.text; if(v.pct!==undefined) return v.pct+'% '+(v.label||''); } return String(v); };
    const head=d.cols.map(c=>c[0]);
    const lines=[head.join(',')].concat(d.rows.map(r=>r[1].map((v,i)=>{ const kind=d.cols[i][1]; let t; if(kind==='class'){ t=this.CLS[v]?this.CLS[v].label:v; } else if(['status','qcaction','approve','accept','release'].includes(kind)){ const s=this.STATUS[this.curStatus(role,r[0],v)]; t=s?s.label:txt(v); } else { t=txt(v); } return '"'+String(t).replace(/"/g,'""')+'"'; }).join(',')));
    const blob=new Blob([lines.join('\n')],{type:'text/csv'}); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=(this.tableTitleFor(role)||'export').replace(/[^a-z0-9]+/gi,'-').toLowerCase()+'.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }

  icon(key, size){
    const d = this.ICONS[key] || this.ICONS.grid;
    return React.createElement('svg',{width:size||18,height:size||18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'},React.createElement('path',{d}));
  }
  spark(arr){ const w=130,h=34,max=Math.max.apply(null,arr),min=Math.min.apply(null,arr),rng=(max-min)||1,dx=w/(arr.length-1);
    return arr.map((v,i)=>(i*dx).toFixed(1)+','+(h-((v-min)/rng)*h).toFixed(1)).join(' '); }
  kpiIcon(label,i){ const l=(label||'').toLowerCase();
    const m=[[/run|active|progress|flight/,'activity'],[/qc|test|queue|pass|fail/,'flask'],[/unit|packed|filled|output|stock|sku|label|print/,'box'],[/po|order|purchase|approv/,'clipboard'],[/supplier/,'truck'],[/user|access|role|invite|defin/,'users'],[/batch|grn|deliver|receiv|match/,'truck'],[/worksheet|yield|mix|base|bottle/,'beaker'],[/ticket|lot|uptime|line/,'droplet'],[/shipment|tag/,'tag'],[/capacity|zone|reorder/,'grid'],[/pending|hold|alert|exception|request/,'bell']];
    for(let j=0;j<m.length;j++){ if(m[j][0].test(l)) return this.icon(m[j][1],20); }
    return this.icon(['activity','box','clipboard','layers'][i%4],20);
  }
  kpiBars(arr, range){ const counts={'This week':7,'This month':5,'This quarter':4,'This year':12}; const N=counts[range]||7;
    const vals=[]; for(let i=0;i<N;i++){ const p=N===1?0:i*(arr.length-1)/(N-1),lo=Math.floor(p),hi=Math.ceil(p); vals.push(arr[lo]+(arr[hi]-arr[lo])*(p-lo)); }
    const max=Math.max.apply(null,vals),min=Math.min.apply(null,vals),rng=(max-min)||1;
    return vals.map((v,i)=>({style:`flex:1;min-width:2px;border-radius:2px 2px 1px 1px;height:${Math.round(5+((v-min)/rng)*17)}px;background:${i===vals.length-1?'var(--accent)':'var(--barmute)'}`})); }
  skinTokens(skin, dark, A){
    if(skin==='glass'){
      if(dark) return `--page:radial-gradient(at 16% 14%, ${A}44, transparent 46%),radial-gradient(at 84% 8%, #3A6FB03a, transparent 42%),radial-gradient(at 74% 90%, #6B4FA83a, transparent 46%),linear-gradient(150deg,#0E131A,#0A0D12);--bg:rgba(40,48,60,.5);--surface:rgba(44,53,66,.46);--well:rgba(14,19,26,.42);--track:rgba(255,255,255,.13);--cbord:rgba(255,255,255,.16);--wbord:rgba(255,255,255,.12);--cblur:blur(20px) saturate(1.4);--border:rgba(255,255,255,.1);--edge:rgba(0,0,0,.5);--rai:0 14px 38px -12px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.14);--rai-lg:0 24px 56px -14px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.14);--rai-sm:0 6px 16px -8px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.1);--ins:inset 0 2px 8px rgba(0,0,0,.42);--ins-sm:inset 0 1px 4px rgba(0,0,0,.36);--t1:#EEF1F6;--t2:#AEB7C3;--t3:#7E8794;--accent:${A};--accent-soft:${A}33;--hov:rgba(255,255,255,.06);--barmute:rgba(255,255,255,.16)`;
      return `--page:radial-gradient(at 16% 14%, ${A}33, transparent 46%),radial-gradient(at 84% 8%, #5FA8FF40, transparent 42%),radial-gradient(at 72% 92%, #B49CFF3a, transparent 46%),linear-gradient(150deg,#EEF3F7,#E3E9F0);--bg:rgba(255,255,255,.5);--surface:rgba(255,255,255,.5);--well:rgba(255,255,255,.32);--track:rgba(255,255,255,.46);--cbord:rgba(255,255,255,.7);--wbord:rgba(255,255,255,.55);--cblur:blur(20px) saturate(1.5);--border:rgba(255,255,255,.55);--edge:rgba(40,60,80,.22);--rai:0 12px 34px -12px rgba(40,60,80,.3),inset 0 1px 0 rgba(255,255,255,.7);--rai-lg:0 22px 52px -14px rgba(40,60,80,.34),inset 0 1px 0 rgba(255,255,255,.7);--rai-sm:0 5px 16px -8px rgba(40,60,80,.24),inset 0 1px 0 rgba(255,255,255,.6);--ins:inset 0 2px 8px rgba(40,60,80,.16);--ins-sm:inset 0 1px 4px rgba(40,60,80,.14);--t1:#1E2A33;--t2:#4F5E6B;--t3:#7C8B98;--accent:${A};--accent-soft:${A}26;--hov:rgba(255,255,255,.4);--barmute:rgba(120,140,160,.32)`;
    }
    if(skin==='skeuomorphic'){
      if(dark) return `--page:radial-gradient(130% 70% at 50% -10%, #2C313B, transparent 70%),linear-gradient(180deg,#1B1F25,#13161C);--bg:linear-gradient(180deg,#2F343D,#272B33);--surface:linear-gradient(180deg,#323843,#262A31);--well:linear-gradient(180deg,#1B1E24,#272B32);--track:linear-gradient(180deg,#141115,#22262C);--cbord:#13161B;--wbord:#13161B;--cblur:none;--border:rgba(255,255,255,.06);--edge:rgba(0,0,0,.5);--rai:0 3px 7px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);--rai-lg:0 9px 20px rgba(0,0,0,.52),inset 0 1px 0 rgba(255,255,255,.06);--rai-sm:0 2px 4px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.05);--ins:inset 0 2px 6px rgba(0,0,0,.5),inset 0 -1px 0 rgba(255,255,255,.04);--ins-sm:inset 0 1px 4px rgba(0,0,0,.46);--t1:#E9ECF1;--t2:#A3ABB7;--t3:#727A86;--accent:${A};--accent-soft:${A}33;--hov:rgba(255,255,255,.05);--barmute:rgba(255,255,255,.14)`;
      return `--page:radial-gradient(130% 70% at 50% -8%, #EDF1F5, transparent 70%),linear-gradient(180deg,#DFE3E9,#CACFD9);--bg:linear-gradient(180deg,#FCFDFF,#ECEFF3);--surface:linear-gradient(180deg,#FDFEFF,#ECEFF4);--well:linear-gradient(180deg,#DFE3EA,#EFF2F6);--track:linear-gradient(180deg,#C9CFD8,#DDE2E8);--cbord:#C3C9D3;--wbord:#C3C9D3;--cblur:none;--border:rgba(40,52,68,.13);--edge:rgba(40,52,68,.22);--rai:0 2px 3px rgba(40,52,68,.16),0 7px 16px -6px rgba(40,52,68,.2),inset 0 1px 0 rgba(255,255,255,.9);--rai-lg:0 9px 22px -5px rgba(40,52,68,.26),inset 0 1px 0 #fff;--rai-sm:0 1px 2px rgba(40,52,68,.2),inset 0 1px 0 rgba(255,255,255,.9);--ins:inset 0 2px 5px rgba(40,52,68,.2),inset 0 -1px 0 rgba(255,255,255,.85);--ins-sm:inset 0 1px 3px rgba(40,52,68,.18);--t1:#272D38;--t2:#5C6573;--t3:#8A94A1;--accent:${A};--accent-soft:${A}1f;--hov:rgba(40,52,68,.05);--barmute:rgba(120,135,155,.36)`;
    }
    if(dark) return `--page:#24272F;--bg:#24272F;--surface:#282C35;--well:#24272F;--track:#1C1F26;--cbord:transparent;--wbord:transparent;--cblur:none;--border:rgba(255,255,255,.07);--edge:rgba(0,0,0,.5);--rai:6px 6px 15px rgba(0,0,0,.5),-6px -6px 15px rgba(255,255,255,.05);--rai-lg:11px 11px 28px rgba(0,0,0,.5),-11px -11px 28px rgba(255,255,255,.05);--rai-sm:4px 4px 9px rgba(0,0,0,.5),-4px -4px 9px rgba(255,255,255,.05);--ins:inset 4px 4px 10px rgba(0,0,0,.5),inset -4px -4px 10px rgba(255,255,255,.05);--ins-sm:inset 3px 3px 6px rgba(0,0,0,.5),inset -3px -3px 6px rgba(255,255,255,.05);--t1:#ECEEF3;--t2:#A6ADBA;--t3:#727A86;--accent:${A};--accent-soft:${A}33;--hov:rgba(255,255,255,.04);--barmute:rgba(255,255,255,.13)`;
    return `--page:#E7EAF0;--bg:#E7EAF0;--surface:#EAEDF3;--well:#E7EAF0;--track:#D7DCE7;--cbord:transparent;--wbord:transparent;--cblur:none;--border:rgba(120,134,162,.2);--edge:rgba(158,171,197,.5);--rai:6px 6px 15px rgba(158,171,197,.55),-6px -6px 15px rgba(255,255,255,.95);--rai-lg:11px 11px 28px rgba(158,171,197,.55),-11px -11px 28px rgba(255,255,255,.95);--rai-sm:4px 4px 9px rgba(158,171,197,.55),-4px -4px 9px rgba(255,255,255,.95);--ins:inset 4px 4px 10px rgba(158,171,197,.55),inset -4px -4px 10px rgba(255,255,255,.95);--ins-sm:inset 3px 3px 6px rgba(158,171,197,.55),inset -3px -3px 6px rgba(255,255,255,.95);--t1:#2E3543;--t2:#697182;--t3:#98A1B2;--accent:${A};--accent-soft:${A}1f;--hov:rgba(120,134,162,.07);--barmute:rgba(150,165,185,.4)`;
  }

  // raw per-role data (mock), overlaid by any live data in the instance-independent window.__raLive
  // store (the DC runtime may render on a different instance, so we read a global, not this._live)
  data(){ const d=this._mockData(); const L=(typeof window!=='undefined'&&window.__raLive)?window.__raLive:null; if(L){ for(const k in L){ d[k]=Object.assign({}, d[k]||{}, L[k]); } } return d; }
  _mockData(){ return {
    superadmin:{
      title:'Production control', sub:'The only place a run is tied to its real product. Everything below the vault is anonymised.',
      kpis:[['Active runs','14','+3',true,[6,7,7,9,8,11,14]],['Batches in QC','9','-2',false,[12,11,13,10,11,9,9]],['Units packed today','4,820','+12%',true,[3,4,4,6,5,7,8]],['Access requests','3','+1',true,[0,1,0,2,1,2,3]]],
      cols:[['Run','code','left'],['Product','text','left'],['Stage','text','left'],['Batch','code','left'],['Target','text','left'],['Status','status','left']],
      rows:[['r1',['V-001','Atlas Noir','Compounding','F24-0815','250 kg','inprogress']],['r2',['V-002','Bois Citadelle','Filling','F24-0822','300 kg','inprogress']],['r3',['V-003','Rose Ivoire','QC','F24-0830','180 kg','hold']],['r4',['V-004','Ambre Sel','Packaging','F24-0840','220 kg','inprogress']],['r5',['V-005','Solène','Procurement','—','260 kg','planning']],['r6',['V-006','Cèdre Verdict','Receiving','F24-0851','240 kg','inprogress']]],
      side:{type:'pipeline', title:'Production pipeline', sub:'Units in flight across the floor', items:[['Planning',2],['Procurement',3],['Receiving',2],['QC',9],['Masking',4],['Storage',12],['Compounding',2],['Filling',3],['Packaging',4]]}
    },
    admin:{
      title:'Access & governance', sub:'Assign departments to people. Admins manage access but never see formulas or product identities.',
      kpis:[['Total users','42','+4',true,[34,36,37,39,40,41,42]],['Active','38','+2',true,[31,33,34,35,36,37,38]],['Pending invites','3','+1',true,[1,2,1,2,2,3,3]],['Roles defined','9','0',true,[9,9,9,9,9,9,9]]],
      cols:[['User','text','left'],['Department','text','left'],['Role','roleselect','left'],['Status','status','left'],['Last active','text','left']],
      rows:[['u1',[{text:'Amélie Rousseau',sub:'a.rousseau@rawaroma.co'},'Quality Control','qc','active','2m ago']],['u2',[{text:'Marco Vinci',sub:'m.vinci@rawaroma.co'},'Compounding','compounding','active','14m ago']],['u3',[{text:'Priya Nair',sub:'p.nair@rawaroma.co'},'Procurement','procurement','active','1h ago']],['u4',[{text:'Tom Becker',sub:'t.becker@rawaroma.co'},'Warehouse','warehouse','active','3h ago']],['u5',[{text:'Lena Hoffmann',sub:'l.hoffmann@rawaroma.co'},'Unassigned','noaccess','pending','—']],['u6',[{text:'Yusuf Demir',sub:'y.demir@rawaroma.co'},'Packaging','packaging','active','Yesterday']]],
      side:{type:'feed', title:'Audit log', sub:'Recent governance events', items:[['Role “QC” granted to A. Rousseau','#34A56F','2m ago'],['Invitation sent to L. Hoffmann','#3B7BC0','22m ago'],['Admin appointed by Super Admin','#9A6B1E','1h ago'],['Password reset · T. Becker','#9298A2','3h ago'],['Role “Packaging” granted to Y. Demir','#34A56F','Yesterday']]}
    },
    procurement:{
      title:'Procurement', sub:'Raise purchase orders from reference codes. You see real materials — never which perfume they’re for.',
      kpis:[['Open POs','7','+2',true,[4,5,5,6,6,7,7]],['Pending approvals','3','+1',true,[1,2,1,2,3,2,3]],['Active suppliers','18','0',true,[18,18,17,18,18,18,18]],['Reorder alerts','4','+2',true,[1,1,2,2,3,3,4]]],
      cols:[['PO','code','left'],['Material','text','left'],['Supplier','text','left'],['Class','class','left'],['Qty','text','left'],['Action','approve','left']],
      rows:[['p1',['PO-2406-204','Methyl dihydrojasmonate','Firmenich','aroma',{text:'25.0 kg',sub:'padded across runs'},'pending']],['p2',['PO-2406-205','Bergamot oil · Calabria','Robertet','natural','40.0 kg','approved']],['p3',['PO-2406-206','Dipropylene glycol','IFF','solvent','120.0 kg','ordered']],['p4',['PO-2406-207','Iso E Super','IFF','aroma','55.0 kg','pending']],['p5',['PO-2406-208','Ambroxan','Givaudan','base','18.0 kg','approved']],['p6',['PO-2406-209','Hedione HC','Firmenich','aroma','30.0 kg','draft']]],
      side:{type:'bars', title:'Spend by class', sub:'This month, share of PO value', items:[['Aroma chem','42%',42,'aroma'],['Base','24%',24,'base'],['Natural','18%',18,'natural'],['Solvent','16%',16,'solvent']]}
    },
    receiving:{
      title:'Receiving', sub:'Check deliveries against the PO, raise a GRN, and assign a batch number that anchors traceability for life.',
      kpis:[['Deliveries today','5','+1',true,[3,4,3,5,4,5,5]],['GRNs to raise','3','-1',false,[5,4,4,3,4,3,3]],['Match exceptions','1','0',true,[2,1,1,0,1,1,1]],['Batches assigned','12','+4',true,[6,7,8,9,10,11,12]]],
      cols:[['GRN','code','left'],['Against PO','code','left'],['Material','text','left'],['Qty recv','text','left'],['Batch','code','left'],['Action','accept','left']],
      rows:[['g1',['GRN-2406-018','PO-2406-204','Methyl dihydrojasmonate','25.0 kg','F24-0815','received']],['g2',['GRN-2406-019','PO-2406-205','Bergamot oil','40.0 kg','F24-0816','pending']],['g3',['GRN-2406-020','PO-2406-206','Dipropylene glycol','120.0 kg','F24-0817','pending']],['g4',['GRN-2406-021','PO-2406-208','Ambroxan','18.0 kg','F24-0818','received']],['g5',['GRN-2406-022','PO-2406-209','Hedione HC','30.0 kg','F24-0819','pending']]],
      side:{type:'feed', title:'Dock activity', sub:'Inbound, latest first', items:[['F24-0815 received & batched','#34A56F','8m ago'],['Match exception cleared · PO-2406-206','#9A6B1E','40m ago'],['Truck arrived · Robertet','#3B7BC0','1h ago'],['GRN-2406-018 raised','#34A56F','1h ago'],['Quantity short noted · Givaudan','#D85A38','2h ago']]}
    },
    qc:{
      title:'Quality control', sub:'Test each batch against fixed parameters. A fail never reaches a shelf — record the result against the batch number.',
      kpis:[['In queue','—','live',true,[6,5,7,6,5,6,6]],['Passed today','—','live',true,[8,9,9,10,11,11,11]],['Failed today','—','live',false,[0,1,0,1,1,0,1]],['Pass rate','—','live',true,[92,94,95,93,96,95,96]]],
      cols:[['Batch','code','left'],['Code','code','left'],['Class','class','left'],['Test','text','left'],['Result','qcaction','left']],
      rows:[['q1',['F24-0815','RM-00117','aroma','Olfactive · turbidity','pending']],['q2',['F24-0816','RM-00042','natural','Density · 0.998','pending']],['q3',['F24-0830','RM-00231','aroma','10% in DPG','pass']],['q4',['F24-0840','BASE-7741','base','Colour · pale straw','pending']],['q5',['F24-0851','RM-00500','solvent','Clarity','pass']],['q6',['F24-0860','RM-00231','aroma','Olfactive','fail']]],
      side:{type:'donut', title:'Batch results', sub:'Today’s testing outcomes'}
    },
    warehouse:{
      title:'Warehouse', sub:'Bottles live as anonymous, colour-coded units. The shelf reveals a class and an address — never an identity.',
      kpis:[['SKUs stored','312','+8',true,[290,295,300,303,307,310,312]],['Putaways pending','8','+3',true,[3,4,5,6,6,7,8]],['Open picks','5','-2',false,[8,7,7,6,6,5,5]],['Zone capacity','78%','+4',true,[70,72,73,74,76,77,78]]],
      cols:[['Code','code','left'],['Class','class','left'],['Location','text','left'],['On hand','text','left'],['Status','status','left']],
      rows:[['w1',['RM-00117','aroma','Z3 · R3 · B2','24 units','ok']],['w2',['BASE-7741','base','Z2 · R8 · B1','12 units','ok']],['w3',['RM-00042','natural','Z3 · R1 · A4','40 units','ok']],['w4',['RM-00500','solvent','Z4 · R2 · C1','60 units','hazard']],['w5',['RM-00231','aroma','Z3 · R6 · B5','8 units','low']],['w6',['RM-00088','base','Z2 · R9 · A1','30 units','ok']]],
      side:{type:'bars', title:'Zone occupancy', sub:'Capacity used per storage zone', items:[['Z1 · Citrus','64%',64,'natural'],['Z2 · Amber','78%',78,'base'],['Z3 · Florals','91%',91,'aroma'],['Z4 · Flammables','56%',56,'hazard']]}
    },
    compounding:{
      title:'Compounding', sub:'Follow ratios you cannot decode. Split batching and pre-made bases mean no one sees the whole formula.',
      kpis:[['Worksheets open','4','+1',true,[2,3,3,4,3,4,4]],['Batches mixing','2','0',true,[2,1,2,2,2,2,2]],['Bases in stock','9','-1',false,[11,10,10,9,9,9,9]],['Yield','98%','+1',true,[95,96,96,97,97,98,98]]],
      cols:[['Worksheet','code','left'],['Line code','code','left'],['Class','class','left'],['Weight','text','left'],['Progress','progress','left']],
      rows:[['c1',['P-7742','BASE-7741','base','100.0 g',{pct:100,label:'added'}]],['c2',['P-7742','RM-00117','aroma','42.0 g',{pct:100,label:'added'}]],['c3',['P-7742','RM-00042','natural','28.5 g',{pct:60,label:'dosing'}]],['c4',['P-7742','RM-00231','aroma','55.0 g',{pct:0,label:'queued'}]],['c5',['P-7742','RM-00500','solvent','24.5 g',{pct:0,label:'queued'}]]],
      side:{type:'bars', title:'Batch progress', sub:'Worksheets in the mixing room', items:[['P-7742','62%',62,'aroma'],['P-7740','100%',100,'natural'],['P-7745','20%',20,'base'],['P-7748','5%',5,'solvent']]}
    },
    filling:{
      title:'Filling & maturation', sub:'Work from finished juice and a target volume. The line sees a code and a quantity — never a recipe.',
      kpis:[['Fill tickets','3','0',true,[3,2,3,3,2,3,3]],['Units filled today','2,400','+9%',true,[3,4,4,5,6,7,8]],['Bulk lots','5','+1',true,[3,4,4,5,5,5,5]],['Line uptime','94%','+2',true,[88,90,91,92,93,93,94]]],
      cols:[['Ticket','code','left'],['Bulk lot','code','left'],['Volume','text','left'],['Units','text','left'],['Status','status','left']],
      rows:[['f1',['F-3391','JL-2407-06','100 ml','2,400','filling']],['f2',['F-3390','JL-2407-05','50 ml','3,000','done']],['f3',['F-3389','JL-2407-04','100 ml','1,800','done']],['f4',['F-3392','JL-2407-07','200 ml','900','queued']]],
      side:{type:'feed', title:'Line activity', sub:'Filling line, latest first', items:[['F-3391 started · JL-2407-06','#3B7BC0','12m ago'],['F-3390 completed · 3,000 units','#34A56F','1h ago'],['Maturation tank 2 released','#9A6B1E','2h ago'],['Volume calibration check','#9298A2','3h ago'],['F-3389 completed','#34A56F','Yesterday']]}
    },
    packaging:{
      title:'Packaging', sub:'The product name surfaces for the first time — here, to print the label, and nowhere else upstream.',
      kpis:[['Pack orders','4','+1',true,[2,3,3,4,3,4,4]],['Units packed today','4,820','+12%',true,[3,4,5,5,6,7,8]],['Labels printed','5,000','+10%',true,[3,4,4,5,6,6,7]],['Shipments ready','2','0',true,[2,1,2,2,2,2,2]]],
      cols:[['Order','code','left'],['Product','text','left'],['Units','text','left'],['Label','text','left'],['Action','release','left']],
      rows:[['k1',['PK-5512','Atlas Noir','2,400','Printed','queued']],['k2',['PK-5513','Bois Citadelle','1,800','Printed','released']],['k3',['PK-5514','Rose Ivoire','900','Pending','queued']],['k4',['PK-5515','Ambre Sel','3,000','Printed','released']]],
      side:{type:'feed', title:'Packaging activity', sub:'Finished goods, latest first', items:[['PK-5513 released to shipping','#34A56F','18m ago'],['Label batch printed · Bois Citadelle','#3B7BC0','35m ago'],['PK-5512 labels approved','#9A6B1E','1h ago'],['Carton spec updated','#9298A2','2h ago'],['PK-5515 released','#34A56F','Yesterday']]}
    }
  };}

  curStatus(role,id,def){ return this.state.rowStatus[role+':'+id] || def; }
  roleOptions(){ return this.ROLE_ORDER.map(k=>({value:k, label:this.ROLE_META[k].label})); }

  buildCell(col, v, rowId, role, density, dark){
    const pad = density==='compact' ? '12px 24px' : '16px 24px';
    const base = {tdStyle:`padding:${pad};border-bottom:1px solid var(--border);text-align:${col[2]};vertical-align:middle;white-space:nowrap`};
    const kind = col[1];
    const btn=(bg,fg,bd)=>`padding:7px 14px;border-radius:11px;font-size:12px;font-weight:700;cursor:pointer;background:${bg};color:${fg};border:1px solid ${bd};box-shadow:var(--rai-sm)`;
    if(kind==='text'){ const o=(v&&v.text!==undefined)?v:{text:v,sub:''}; return {...base,isText:true,text:o.text,sub:o.sub,textStyle:'font-weight:600;font-size:13.5px;color:var(--t1)'}; }
    if(kind==='code'){ return {...base,isCode:true,text:v}; }
    if(kind==='class'){ const c=this.CLS[v]; const cbg=dark?`${c.lite}22`:c.bg, cfg=dark?c.lite:c.fg; return {...base,isClass:true,text:c.label,chipStyle:`display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.01em;background:${cbg};color:${cfg}`}; }
    if(kind==='status'){ return this.statusCell(base, this.curStatus(role,rowId,v), dark); }
    if(kind==='progress'){ const col2 = v.pct>=100?this.barColor('natural',dark):(v.pct>0?'var(--accent)':'var(--t3)'); return {...base,isProgress:true,label:v.label,barStyle:`width:${v.pct}%;height:100%;background:${col2};border-radius:4px`}; }
    if(kind==='roleselect'){ const cur=this.state.userRoles[rowId]||v; return {...base,isSelect:true,value:cur,onChange:(e)=>this.assign(rowId,e.target.value),options:this.roleOptions(),selectStyle:'padding:8px 12px;border-radius:10px;border:none;background:var(--bg);box-shadow:var(--ins-sm);font-size:12.5px;font-weight:700;color:var(--t1);cursor:pointer'}; }
    if(kind==='qcaction'){ const stt=this.curStatus(role,rowId,v); if(stt==='pending'){ return {...base,isActions:true,buttons:[{label:'Pass',style:btn(dark?'rgba(52,165,111,.18)':'#E2F1E9',dark?'#5EC08C':'#2E7D55',dark?'transparent':'#BFE0CD'),hoverStyle:'background:#2E7D55;color:#fff',onClick:()=>this.mark(rowId,'pass')},{label:'Fail',style:btn(dark?'rgba(216,90,56,.18)':'var(--surface)',dark?'#E58266':'#C0492E',dark?'transparent':'#F0CFC6'),hoverStyle:'background:#C0492E;color:#fff',onClick:()=>this.mark(rowId,'fail')}]}; } return this.statusCell(base, stt, dark); }
    if(kind==='approve'){ const stt=this.curStatus(role,rowId,v); if(stt==='pending'){ return {...base,isActions:true,buttons:[{label:'Approve',style:btn('var(--accent)','#fff','transparent'),hoverStyle:'filter:brightness(1.08)',onClick:()=>this.mark(rowId,'approved')}]}; } return this.statusCell(base, stt, dark); }
    if(kind==='accept'){ const stt=this.curStatus(role,rowId,v); if(stt==='pending'){ return {...base,isActions:true,buttons:[{label:'Accept',style:btn('var(--accent)','#fff','transparent'),hoverStyle:'filter:brightness(1.08)',onClick:()=>this.mark(rowId,'received')}]}; } return this.statusCell(base, stt, dark); }
    if(kind==='release'){ const stt=this.curStatus(role,rowId,v); if(stt==='queued'){ return {...base,isActions:true,buttons:[{label:'Release',style:btn('var(--accent)','#fff','transparent'),hoverStyle:'filter:brightness(1.08)',onClick:()=>this.mark(rowId,'released')}]}; } return this.statusCell(base, stt, dark); }
    return {...base,isText:true,text:String(v)};
  }
  statusCell(base, key, dark){ const s=this.STATUS[key]||this.STATUS.queued; const bg=dark?`${s.dot}26`:s.bg, fg=dark?s.dot:s.fg; return {...base,isStatus:true,text:s.label,pillStyle:`display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:700;background:${bg};color:${fg}`,dotStyle:`width:6px;height:6px;border-radius:50%;background:${s.dot};flex:none`}; }

  rowPrimaryStatus(cols, row, role){ for(let i=0;i<cols.length;i++){ const k=cols[i][1]; if(['status','qcaction','approve','accept','release'].includes(k)) return this.curStatus(role,row[0],row[1][i]); } return null; }

  buildFlow(out, dark){
    const ic=(k)=>this.icon(k,15);
    const lab=(lx,ly,t)=>({style:`position:absolute;left:${lx}px;top:${ly}px;transform:translate(-50%,-50%);font:600 9.5px 'JetBrains Mono',monospace;color:var(--t3);background:var(--surface);border:1px solid var(--cbord);padding:1px 6px;border-radius:6px;white-space:nowrap`,text:t});
    out.refreshIcon=this.icon('refresh',16); out.expandIcon=this.icon('expand',15); out.minusIcon=this.icon('minus',16); out.plusIcon=this.icon('plus',16); out.saveIcon=this.icon('download',15); out.loadIcon=this.icon('box',15); out.playIcon=this.icon('play',12); out.flowHubIcon=this.icon('droplet',22);
    out.flowNodes=[
      {hub:true, wrap:'left:500px;top:8px;width:60px;height:60px'},
      {group:true, wrap:'left:20px;top:60px;width:182px', icon:ic('clipboard'), title:'Procurement', items:[{code:'V-001',sub:'run opened'},{code:'PO ×12',sub:'materials ordered'}]},
      {group:true, wrap:'left:20px;top:200px;width:182px', icon:ic('flask'), title:'Receiving · QC', items:[{code:'RM-00117',sub:'aroma · masked'},{code:'BASE-7741',sub:'base · masked'}]},
      {group:true, wrap:'left:300px;top:114px;width:186px', icon:ic('beaker'), title:'Compounding', items:[{code:'P-7742',sub:'62% · mixing'},{code:'+ 4 codes',sub:'split batch'}]},
      {group:true, wrap:'left:548px;top:114px;width:172px', icon:ic('droplet'), title:'Filling', items:[{code:'F-3391',sub:'2,400 units'},{code:'JL-2407-06',sub:'bulk juice lot'}]},
      {group:true, wrap:'left:752px;top:114px;width:172px', icon:ic('tag'), title:'Packaging', items:[{code:'Atlas Noir',sub:'◆ identity surfaces'},{code:'PK-5512',sub:'sealed & labelled'}]}
    ];
    out.flowEdges=[
      {d:'M202,104 C 250,104 254,150 300,150', color:'var(--accent)', dash:'0'},
      {d:'M202,242 C 256,242 256,176 300,176', color:'var(--accent)', dash:'0'},
      {d:'M486,160 C 517,160 517,160 548,160', color:'var(--accent)', dash:'0'},
      {d:'M720,160 C 736,160 736,160 752,160', color:'var(--accent)', dash:'0'},
      {d:'M524,66 C 470,90 412,102 393,114', color:'var(--t3)', dash:'5 5'},
      {d:'M540,62 C 700,36 822,70 838,114', color:'var(--t3)', dash:'5 5'}
    ];
    out.flowLabels=[lab(252,120,'V-001 → P-7742'),lab(252,210,'RM-00117 masked'),lab(517,146,'P-7742 → F-3391'),lab(736,146,'F-3391 → reveal'),lab(450,92,'holds index'),lab(706,44,'re-links codes'),lab(530,84,'Formula Vault')];
    const seq=[42,60,54,76,68,90,82,64,95,70,86];
    out.throughBars=seq.map((v)=>{ const hi=Math.round(v*0.26),md=Math.round(v*0.32),lo=Math.max(4,v-hi-md);
      return {segs:[{style:`height:${hi}px;background:#D85A38;border-radius:4px 4px 0 0`},{style:`height:${md}px;background:#E0A33B`},{style:`height:${lo}px;background:var(--accent);border-radius:0 0 4px 4px`}]}; });
    out.throughTimes=[{t:'06:00'},{t:'09:00'},{t:'12:00'},{t:'15:00'},{t:'18:00'}];
    const SR=[['V-001','Atlas Noir','Compounding','Filling','inprogress','250 kg','aroma'],['V-002','Bois Citadelle','Filling','Packaging','inprogress','300 kg','base'],['V-003','Rose Ivoire','QC','Compounding','hold','180 kg','aroma'],['V-004','Ambre Sel','Packaging','Shipping','inprogress','220 kg','base'],['V-006','C\u00e8dre Verdict','Receiving','QC','inprogress','240 kg','natural']];
    out.serviceRows=SR.map(r=>{ const s=this.STATUS[r[4]]; const c=this.CLS[r[6]]; const bg=dark?`${s.dot}26`:s.bg, fg=dark?s.dot:s.fg;
      return {run:r[0],product:r[1],from:r[2],to:r[3],units:r[5],dot:dark?c.lite:c.fg,statusText:s.label,statusStyle:`display:inline-flex;align-items:center;padding:3px 11px;border-radius:999px;font-size:11px;font-weight:700;background:${bg};color:${fg}`}; });
    out.timeTicks=[{t:'06:00'},{t:'08:00'},{t:'10:00'},{t:'12:00'},{t:'14:00'},{t:'16:00'},{t:'18:00'}];
    out.timeMarkers=[{s:'left:13%;background:#D85A38'},{s:'left:25%;background:var(--accent)'},{s:'left:37%;background:#E0A33B'},{s:'left:50%;background:var(--accent)'},{s:'left:62%;background:#D85A38'},{s:'left:75%;background:var(--accent)'},{s:'left:87%;background:#E0A33B'}];
  }
  buildWarehouse(out, dark){
    const ic=(k)=>this.icon(k,15); const C=this.CLS; const col=(k)=>dark?C[k].lite:C[k].fg;
    out.whPlus=this.icon('plus',16); out.whMinus=this.icon('minus',16); out.whExpand=this.icon('expand',15); out.whSearchIcon=this.icon('search',15); out.whTaskIcon=this.icon('box',15); out.whInIcon=ic('truck'); out.whOutIcon=ic('tag');
    out.whStats=[
      {value:'312',label:'SKUs stored',bars:this.kpiBars([290,296,301,305,308,310,312],'This week'),dot:'var(--accent)'},
      {value:'8',label:'Putaways',bars:this.kpiBars([3,4,5,6,6,7,8],'This week'),dot:'#E0A33B'},
      {value:'5',label:'Open picks',bars:this.kpiBars([8,7,7,6,6,5,5],'This week'),dot:'var(--accent)'},
      {value:'78%',label:'Capacity',bars:this.kpiBars([70,72,73,75,76,77,78],'This week'),dot:'#D85A38'}
    ];
    const stPill=(s)=>{ const m={Done:['#2E7D55','#E2F1E9','#34A56F'],Hold:['#9A6B1E','#F8EFD8','#D9A53B'],Low:['#C0492E','#FBE6E1','#D85A38']}; const x=m[s]||m.Done; const bg=dark?`${x[2]}26`:x[1],fg=dark?x[2]:x[0]; return `display:inline-block;padding:2px 9px;border-radius:999px;font-size:10px;font-weight:700;background:${bg};color:${fg}`; };
    const T=[
      {code:'PA-2561',name:'Putaway cart A',state:'Active',sc:'var(--accent)',fill:72,open:true,rows:[['RM-00117','Z3\u00b7R3','24','Done'],['BASE-7741','Z2\u00b7R8','12','Done'],['RM-00500','Z4\u00b7R2','60','Hold']]},
      {code:'PA-9645',name:'Pick cart B',state:'Picking',sc:'#3B7BC0',fill:34,open:true,rows:[['RM-00042','Z3\u00b7R1','40','Done'],['RM-00231','Z3\u00b7R6','8','Low']]},
      {code:'PA-5721',name:'Putaway cart C',state:'Idle',sc:'var(--t3)',fill:90,open:false,rows:[]},
      {code:'PA-2841',name:'Pick cart D',state:'Charging',sc:'#E0A33B',fill:18,open:false,rows:[]}
    ];
    out.whTasks=T.map(t=>({code:t.code,name:t.name,state:t.state,stateDot:`width:7px;height:7px;border-radius:50%;background:${t.sc};flex:none`,fill:String(t.fill),fillBar:`width:${t.fill}%;height:100%;background:${t.fill<25?'#D85A38':(t.fill<50?'#E0A33B':'var(--accent)')};border-radius:4px`,open:t.open,rows:t.rows.map(r=>({sym:r[0],zone:r[1],qty:r[2],st:r[3],stStyle:stPill(r[3])}))}));
    const cellsN=(n,k)=>{ const a=[]; for(let i=0;i<16;i++){ a.push({style:i<n?('background:'+col(k)):('background:var(--well);border:1px solid var(--wbord)')}); } return a; };
    const sh9=(n)=>{ const a=[]; for(let i=0;i<9;i++){ a.push({style:i<n?('background:'+col('natural')):('background:var(--well);border:1px solid var(--wbord)')}); } return a; };
    const rk=[['Z1 · Citrus','natural',62,40,9,'64%',false],['Z2 · Amber','base',62,196,12,'78%',false],['Z3 · Florals','aroma',290,40,15,'91%',false],['Z3 · Florals B','aroma',290,196,10,'58%',false],['Z4 · Flammables','solvent',518,40,7,'56%',true],['Z2 · Amber B','base',518,196,13,'80%',false]];
    out.whRacks=rk.map(r=>({wrap:`left:${r[2]}px;top:${r[3]}px;width:196px;height:130px`,name:r[0],band:r[1]==='solvent'?'#D85A38':col(r[1]),cells:cellsN(r[4],r[1]==='solvent'?'solvent':r[1]),cap:r[5],alert:r[6]}));
    const sd=[['A',62,378,6],['B',200,378,9],['C',338,378,4],['D',476,378,7],['E',614,378,5],['F',752,378,8]];
    out.whShelves=sd.map(s=>({wrap:`left:${s[1]}px;top:${s[2]}px;width:124px;height:106px`,label:'Aisle '+s[0],cells:sh9(s[3])}));
    out.whRoutes=[
      {d:'M52,256 C 110,256 110,104 158,104',color:'var(--accent)',dash:'0'},
      {d:'M52,256 C 110,256 110,260 158,260',color:'var(--accent)',dash:'0'},
      {d:'M52,256 C 220,256 360,256 486,256',color:'var(--accent)',dash:'0'},
      {d:'M386,170 C 386,300 386,300 386,378',color:'var(--accent)',dash:'0'},
      {d:'M160,260 C 124,260 124,378 124,378',color:'var(--accent)',dash:'0'},
      {d:'M714,104 C 800,104 800,250 858,250',color:'#D85A38',dash:'5 5'},
      {d:'M714,170 C 714,300 676,378 676,378',color:'var(--accent)',dash:'0'},
      {d:'M486,262 C 560,262 560,378 538,378',color:'var(--accent)',dash:'0'},
      {d:'M858,256 C 802,256 802,378 814,378',color:'var(--accent)',dash:'0'},
      {d:'M486,104 C 504,104 504,104 518,104',color:'var(--accent)',dash:'0'}
    ];
    out.whCarts=[{style:'left:122px;top:178px',l:'H-26'},{style:'left:340px;top:300px',l:'H-54'},{style:'left:560px;top:178px',l:'H-12'},{style:'left:676px;top:300px',l:'H-09'},{style:'left:250px;top:256px',l:'H-41'},{style:'left:800px;top:248px',l:'H-77'},{style:'left:470px;top:256px',l:'H-33'}];
    const dock=(s,kind,label)=>{ const m={in:['background:var(--accent);color:#fff',out.whInIcon],out:['background:var(--surface);border:1px solid var(--cbord);color:var(--accent)',out.whOutIcon],charge:['background:var(--surface);border:1px solid var(--cbord);color:#E0A33B',this.icon('refresh',16)]}[kind]; return {style:s,label,boxStyle:m[0],icon:m[1]}; };
    out.whDocks=[dock('left:6px;top:232px','in','Inbound'),dock('left:862px;top:120px','out','Dispatch'),dock('left:862px;top:332px','charge','Charging')];
    out.whAlerts=[{style:'left:606px;top:34px'},{style:'left:400px;top:430px'}];
    const wl=[40,55,48,70,62,80,72,58,88,66,78,60]; out.whWorkBars=wl.map(v=>({style:`flex:1;height:${Math.round(8+v*0.9)}px;background:var(--accent);border-radius:3px 3px 0 0;opacity:.85`}));
    const pk=[30,42,38,55,48,66,60,72,68,82,78,90]; const W=300,H=86,mx=95,mn=20; const pts=pk.map((v,i)=>`${(i*(W/(pk.length-1))).toFixed(0)},${(H-((v-mn)/(mx-mn))*H).toFixed(0)}`);
    out.whPickLine=pts.join(' '); out.whPickArea=`0,${H} `+pts.join(' ')+` ${W},${H}`;
    const P=this.state.whPanels; const wrap=(p,z)=>`position:fixed;left:${p.x}px;top:${p.y}px;z-index:${z};${p.min?'display:none':'display:flex'};flex-direction:column`;
    out.opsWrap=wrap(P.ops,33); out.opsDown=(e)=>this.panelDown('ops',e); out.opsMin=()=>this.panelMin('ops');
    out.workWrap=wrap(P.work,32); out.workDown=(e)=>this.panelDown('work',e); out.workMin=()=>this.panelMin('work');
    out.pickWrap=wrap(P.pick,32); out.pickDown=(e)=>this.panelDown('pick',e); out.pickMin=()=>this.panelMin('pick');
    out.minIcon=this.icon('minus',16); out.dragIcon=this.icon('grid',13);
    const lab={ops:'Putaway & picks',work:'Storage workload',pick:'Daily picks'}; const ico={ops:'box',work:'activity',pick:'tag'};
    out.whMinimized=Object.keys(P).filter(k=>P[k].min).map(k=>({label:lab[k],icon:this.icon(ico[k],14),onClick:()=>this.panelMin(k)}));
    out.whHasMin=out.whMinimized.length>0;
    out.opsOpen=this.state.opsOpen; out.toggleOps=()=>this.setState(s=>({opsOpen:!s.opsOpen})); out.opsChevron='color:var(--t3);display:grid;place-items:center;transition:transform .2s;transform:rotate('+(this.state.opsOpen?0:180)+'deg)';
  }
  renderVals(){
    const accent = this.props.accent || '#117C66';
    const density = this.props.density || 'comfortable';
    const st = this.state;
    const meta = this.ROLE_META[st.role];
    const initials = (n)=>n.split(' ').map(w=>w[0]).slice(0,2).join('');

    // skin + light/dark tokens
    const dark = (st.theme || this.props.sidebarTheme || 'light')==='dark';
    const skin = st.skin || 'neumorphic';
    const rootStyle = this.skinTokens(skin, dark, accent)+";font-family:'Urbanist',system-ui,sans-serif;color:var(--t1);min-height:100vh;color-scheme:"+(dark?'dark':'light');

    const out = {
      rootStyle, brandMark:this.icon('droplet',18), checkIcon:this.icon('check',14), logoutIcon:this.icon('logout',16),
      bellIcon:this.icon('bell',18), searchIcon:this.icon('search',15), viewIcon:this.icon('eye',15),
      calIcon:this.icon('calendar',15), exportIcon:this.icon('download',15), usersIcon:this.icon('users',18),
      lockBigIcon:this.icon('lock',30), scanIcon:this.icon('scan',26),
      brandMarkLg:this.icon('droplet',26), themeIcon:this.icon(dark?'sun':'moon',18), toggleTheme:()=>this.toggleTheme(), dark,
      isLogin: st.screen==='login', isApp: st.screen==='app',
      roleKey:st.role, allRoles:this.ROLE_ORDER.map(k=>({key:k,label:this.ROLE_META[k].label})),
      onRoleSwitch:(e)=>this.switchRole(e.target.value),
      logout:()=>this.logout(),
      userName:meta.user, userInitials:initials(meta.user), roleName:meta.label,
    };
    out.skin = skin;
    out.styleSwitch=[['neumorphic','Neuro'],['glass','Glass'],['skeuomorphic','Skeuo']].map(([k,l])=>({key:k,label:l,onClick:()=>this.setSkin(k),
      style:`padding:7px 12px;border-radius:9px;font-size:11.5px;font-weight:700;cursor:pointer;border:none;white-space:nowrap;background:${skin===k?'var(--accent)':'transparent'};color:${skin===k?'#fff':'var(--t3)'}`}));

    // ---- login (minimal) ----
    if(st.screen==='login'){
      const roleIcon={superadmin:'shield',admin:'users',procurement:'clipboard',receiving:'truck',qc:'flask',warehouse:'box',compounding:'beaker',filling:'droplet',packaging:'tag',noaccess:'lock'};
      out.doSignIn=()=>this.signIn();
      out.loginRoleKey=st.loginRole;
      out.loginRoleDesc=this.ROLE_META[st.loginRole].desc;
      out.loginRoleIcon=this.icon(roleIcon[st.loginRole]||'shield',18);
      out.onLoginSelect=(e)=>this.pickLoginRole(e.target.value);
      out.loginRoles=this.ROLE_ORDER.map(k=>({key:k,label:this.ROLE_META[k].label}));
      return out;
    }

    // ---- app (neumorphic) ----
    const collapsed = st.sidebarCollapsed;
    out.sidebarCollapsed = collapsed; out.showLabels = !collapsed;
    out.toggleSidebar = ()=>this.toggleSidebar(); out.panelIcon = this.icon('panel',18);
    out.brandRowStyle = '';
    out.userRowStyle = collapsed?'flex-direction:column;gap:12px':'';
    out.logoutOpacity = collapsed?'0':'1';
    out.sidebarStyle=`width:${collapsed?84:256}px;flex:none;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);-webkit-backdrop-filter:var(--cblur);padding:${collapsed?'16px 10px 14px':'18px 14px 14px'};display:flex;flex-direction:column;position:sticky;top:14px;height:calc(100vh - 28px);margin:14px 0 14px 14px;border-radius:24px;box-shadow:var(--rai);transition:width .28s cubic-bezier(.4,0,.2,1);z-index:6`;
    out.collapseBtnStyle = collapsed?'display:grid;place-items:center;width:46px;height:42px;margin:0 auto 10px;border-radius:13px;background:var(--accent);color:#fff;box-shadow:var(--rai-sm);cursor:pointer':'display:flex;align-items:center;gap:9px;width:100%;padding:9px 12px;margin-bottom:8px;border-radius:12px;background:var(--well);border:1px solid var(--wbord);box-shadow:var(--ins-sm);color:var(--t2);font-size:11.5px;font-weight:700;cursor:pointer';
    out.sidebarDept=meta.dept;
    out.navItems=(this.NAV[st.role]||[]).map(([key,label,ic])=>{ const on=st.nav===key;
      const shape = collapsed
        ? 'display:flex;align-items:center;justify-content:center;width:52px;height:50px;margin:0 auto;border-radius:16px;'
        : 'display:flex;align-items:center;gap:13px;padding:10px 12px;border-radius:13px;';
      const stt = on
        ? 'color:var(--accent);background:var(--accent-soft);box-shadow:var(--ins-sm);font-weight:700;'
        : 'color:var(--t2);background:transparent;box-shadow:none;font-weight:600;';
      return {label,title:label,showLabel:!collapsed,icon:this.icon(ic,18),onClick:()=>this.setNav(key),
        style:shape+stt+'cursor:pointer;font-size:13.5px;',
        hoverStyle:on?'':'background:var(--well);color:var(--t1)'};
    });

    out.pageTitle=meta.label+' · Dashboard';
    out.pageCrumb='Raw Aroma Chem / '+meta.dept;
    out.showDeviceToggle = (st.role==='qc'||st.role==='warehouse');
    out.setDesktop=()=>this.setDevice('desktop'); out.setMobile=()=>this.setDevice('mobile');
    const tbtn=(on)=>`padding:8px 15px;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;border:none;background:var(--bg);color:${on?'var(--accent)':'var(--t3)'};box-shadow:${on?'var(--ins-sm)':'none'}`;
    out.deskBtnStyle=tbtn(st.device==='desktop'); out.mobBtnStyle=tbtn(st.device==='mobile');
    out.notifOpen=st.notifOpen; out.toggleNotif=()=>this.toggleNotif();
    out.notifItems=[{text:'QC failed · batch F24-0860',time:'4m ago',dot:'#D85A38'},{text:'PO-2406-204 awaiting approval',time:'22m ago',dot:'#D9A53B'},{text:'F24-0815 received & batched',time:'1h ago',dot:'#34A56F'},{text:'New access request · L. Hoffmann',time:'2h ago',dot:'#3B7BC0'}];
    out.rangeLabel=st.range; out.rangeOpen=st.rangeOpen; out.toggleRange=()=>this.toggleRange(); out.chevronIcon=this.icon('chevron',14);
    out.rangeOptions=['This week','This month','This quarter','This year'].map(r=>({label:r,onClick:()=>this.setRange(r),style:`display:block;width:100%;text-align:left;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:${r===st.range?700:600};cursor:pointer;border:none;background:${r===st.range?'var(--accent-soft)':'transparent'};color:${r===st.range?'var(--accent)':'var(--t2)'}`}));

    out.isNoAccess = st.role==='noaccess';
    out.isMobile = st.device==='mobile' && (st.role==='qc'||st.role==='warehouse');
    out.isFlowDash = !out.isNoAccess && !out.isMobile && st.nav==='dashboard' && st.role==='superadmin';
    out.isWarehouseFloor = !out.isNoAccess && !out.isMobile && st.nav==='dashboard' && st.role==='warehouse';
    out.isDash = !out.isNoAccess && !out.isMobile && st.nav==='dashboard' && st.role!=='superadmin' && st.role!=='warehouse';
    out.isPlaceholder = !out.isNoAccess && !out.isMobile && st.nav!=='dashboard';
    if(out.isFlowDash){ this.buildFlow(out, dark); }
    if(out.isWarehouseFloor){ this.buildWarehouse(out, dark); }

    out.requestAccess=()=>this.requestAccess();
    out.requestLabel=st.requested?'Request sent ✓':'Request access';

    if(out.isPlaceholder){ const item=(this.NAV[st.role]||[]).find(n=>n[0]===st.nav); out.placeholderLabel=item?item[1]:'Module'; out.placeholderIcon=this.icon(item?item[2]:'grid',26); }

    if(out.isMobile){ this.buildMobile(out, st.role); }

    if(out.isDash){
      const d=this.data()[st.role];
      out.dashTitle=d.title; out.dashSubtitle=d.sub;
      out.exportCsv=()=>this.exportCsv(d, st.role);
      // KPIs (qc live)
      let kpis=d.kpis;
      if(st.role==='qc'){ kpis=this.qcKpis(d); }
      out.kpis=kpis.map((k,ki)=>{ const isNum=/[1-9]/.test(k[2])&&/^[+\-]?[\d.,]+%?$/.test(k[2]);
        const dGood=dark?'rgba(94,192,140,.16)':'#E2F1E9', dBad=dark?'rgba(229,130,102,.16)':'#FBE6E1', cGood=dark?'#5EC08C':'#2E7D55', cBad=dark?'#E58266':'#C0492E';
        return {label:k[0],value:k[1],icon:this.kpiIcon(k[0],ki),delta:isNum?((k[3]?'▲ ':'▼ ')+k[2]):k[2],
        deltaStyle:isNum?`font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;background:${k[3]?dGood:dBad};color:${k[3]?cGood:cBad}`:`font-size:11px;font-weight:700;padding:4px 9px;border-radius:999px;background:var(--bg);color:var(--t3);box-shadow:var(--ins-sm)`,
        spark:this.spark(k[4]),sparkColor:k[3]?'var(--accent)':'#D08A6E',bars:this.kpiBars(k[4], st.range),pct:this.kpiPct(k[4]),up:k[3]};});
      this.buildCelox(out, st.role, dark);
      // table
      out.tableTitle=d.cols.length?this.tableTitleFor(st.role):'';
      out.tableCols=d.cols.map(c=>({label:c[0],thStyle:`padding:14px 24px;text-align:${c[2]};font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--t3);border-bottom:1px solid var(--border);white-space:nowrap`}));
      // filter chips
      const statuses=[]; d.rows.forEach(r=>{ const s=this.rowPrimaryStatus(d.cols,r,st.role); if(s&&!statuses.includes(s))statuses.push(s); });
      out.hasFilters=statuses.length>1;
      out.filterChips=[{key:'all',label:'All'}].concat(statuses.map(s=>({key:s,label:this.STATUS[s].label}))).map(c=>{ const onF=st.filter===c.key; return {label:c.label,onClick:()=>this.setFilter(c.key),
        style:`padding:8px 15px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid var(--wbord);background:var(--bg);color:${onF?'var(--accent)':'var(--t2)'};box-shadow:${onF?'var(--ins-sm)':'var(--rai-sm)'}`};});
      // rows filtered
      const q=st.search.trim().toLowerCase();
      const rows=d.rows.filter(r=>{
        if(st.filter!=='all'){ if(this.rowPrimaryStatus(d.cols,r,st.role)!==st.filter) return false; }
        if(q){ const txt=r[1].map(v=>(v&&v.text!==undefined)?v.text+' '+(v.sub||''):(v&&v.pct!==undefined?v.label:String(v))).join(' ').toLowerCase(); if(!txt.includes(q)) return false; }
        return true;
      });
      out.search=st.search; out.onSearch=(e)=>this.setSearch(e.target.value);
      out.tableCount=rows.length+' of '+d.rows.length;
      out.tableRows=rows.map(r=>({cells:d.cols.map((c,i)=>this.buildCell(c,r[1][i],r[0],st.role,density,dark))}));
      this.buildSide(out, d.side, st.role, dark);
    }
    return out;
  }

  tableTitleFor(role){ return {superadmin:'Master run index',admin:'Users & roles',procurement:'Purchase orders',receiving:'Inbound deliveries',qc:'Test queue',warehouse:'Stock — masked codes',compounding:'Compounding worksheet · P-7742',filling:'Fill tickets',packaging:'Packaging orders'}[role]||'Records'; }

  qcKpis(d){
    const rows=d.rows; let pend=0,pass=0,fail=0;
    rows.forEach(r=>{ const s=this.curStatus('qc',r[0],r[1][4]); if(s==='pending')pend++; else if(s==='pass')pass++; else if(s==='fail')fail++; });
    const passBase=11, failBase=1;
    const totalPass=passBase+ (pass), totalFail=failBase+ fail;
    const rate=Math.round(totalPass/((totalPass+totalFail)||1)*100);
    return [['In queue',String(pend),'live',pend<=3,[6,5,7,6,5,6,pend]],
      ['Passed today',String(totalPass),pass?('+'+pass):'today',true,[8,9,9,10,11,11,totalPass]],
      ['Failed today',String(totalFail),fail?('+'+fail):'none',totalFail<=1,[0,1,0,1,1,0,totalFail]],
      ['Pass rate',rate+'%','95% target',rate>=95,[92,94,95,93,96,95,rate]]];
  }

  kpiPct(arr){ const mx=Math.max.apply(null,arr); const avg=arr.reduce((a,b)=>a+b,0)/arr.length; return Math.max(8,Math.min(98,Math.round(avg/(mx||1)*100))); }
  buildCelox(out, role, dark){
    const k=out.kpis||[];
    const NOTE={procurement:'Purchasing is ahead of plan — three reorders cleared early and supplier lead times are holding steady.',receiving:'Inbound is flowing — most deliveries matched their POs on the first pass with no holds raised.',qc:'Quality is on target — pass rate sits above the 95% threshold with only one batch awaiting retest.',compounding:'Compounding is tracking to schedule — the lead worksheet crossed the halfway mark on time.',filling:'Filling output is up — line throughput improved against last period with no bulk-lot shortfalls.',packaging:'Packaging is keeping pace — finished-goods releases rose while open pack orders fell.',admin:'Access is healthy — active users are stable and no role changes are pending review.'};
    const hero=k[0]||{label:'Throughput',value:'—',delta:'',bars:[],pct:0,up:true};
    out.cxHero=hero; out.cxHeroNote=NOTE[role]||'Live operational summary for your stage in the production line.';
    out.cxMetrics=[k[1],k[2],k[3]].filter(Boolean).map((m,i)=>({label:m.label,value:m.value,delta:m.delta,deltaStyle:m.deltaStyle,dotStyle:`width:8px;height:8px;border-radius:3px;background:${['#D85A38','#E0A33B','var(--accent)'][i]};flex:none`}));
    out.cxSpark=(k[1]&&k[1].bars)||hero.bars||[];
    const mColor=(up)=>up?'var(--accent)':'#D08A6E';
    out.cxMeters=[k[2],k[3]].filter(Boolean).map(m=>({label:m.label,value:m.value,pct:m.pct+'%',barStyle:`width:${m.pct}%;height:100%;background:${mColor(m.up)};border-radius:6px`}));
    const g=(k[3]&&k[3].pct!=null)?k[3].pct:(hero.pct||60); const C=2*Math.PI*52;
    out.cxGaugePct=g+'%'; out.cxGaugeLabel=(k[3]&&k[3].label)||'Completion';
    out.cxGaugeDash=`${(C*g/100).toFixed(1)} ${C.toFixed(1)}`;
    out.cxGaugeColor=g>=70?'var(--accent)':(g>=40?'#E0A33B':'#D85A38');
    out.cxGaugeSide=[k[1],k[2]].filter(Boolean).map((m,i)=>({rank:['Top','Med'][i]||'',label:m.label,value:m.value}));
    out.cxBadgeInsight=this.icon('activity',15); out.cxBadgeAlert=this.icon('alert',15); out.cxBadgeOut=this.icon('layers',15);
  }
  buildSide(out, side, role, dark){
    out.sideTitle=side.title; out.sideSub=side.sub;
    out.sideIsDonut=side.type==='donut'; out.sideIsBars=side.type==='bars'; out.sideIsPipeline=side.type==='pipeline'; out.sideIsFeed=side.type==='feed';
    if(side.type==='donut'){
      const d=this.data().qc.rows; let pass=0,fail=0,pend=0;
      d.forEach(r=>{ const s=this.curStatus('qc',r[0],r[1][4]); if(s==='pass')pass++; else if(s==='fail')fail++; else pend++; });
      const total=pass+fail+pend; const pct=Math.round(pass/((pass+fail)||1)*100);
      const C=2*Math.PI*58; const len=(pct/100)*C;
      out.donutColor='var(--accent)'; out.donutDash=len.toFixed(1)+' '+C.toFixed(1); out.donutCenter=pct+'%';
      out.donutLegend=[{label:'Pass',value:pass,color:'#34A56F'},{label:'Fail',value:fail,color:'#D85A38'},{label:'Pending',value:pend,color:'#D9A53B'}];
    }
    if(side.type==='bars'){ out.barItems=side.items.map(it=>({label:it[0],value:it[1],barStyle:`width:${it[2]}%;height:100%;background:${this.barColor(it[3],dark)};border-radius:5px`})); }
    if(side.type==='pipeline'){ const max=Math.max.apply(null,side.items.map(i=>i[1])); out.pipeItems=side.items.map(it=>({label:it[0],count:it[1],barStyle:`width:${Math.round(it[1]/max*100)}%;height:100%;background:var(--accent);opacity:.85;border-radius:5px`})); }
    if(side.type==='feed'){ out.feedItems=side.items.map(it=>({text:it[0],dot:it[1],time:it[2]})); }
  }

  buildMobile(out, role){
    if(role==='qc'){
      out.mobileTitle='QC bench scan'; out.mobileSub='Test the batch in your hand';
      out.mobileScanLabel='Scan batch label'; out.mobileScanCode='F24-0815 · RM-00117';
      out.mobileListLabel='Queue';
      const rows=this.data().qc.rows;
      out.mobileItems=rows.slice(0,4).map(r=>{ const stk=this.curStatus('qc',r[0],r[1][4]); const s=this.STATUS[stk];
        return {code:r[1][0],sub:r[1][1]+' · '+r[1][3],tag:s.label,tagStyle:`padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:${s.bg};color:${s.fg};flex:none`,
          showActions:stk==='pending',
          actions:[{label:'Pass',style:'flex:1;padding:9px;border-radius:9px;background:#E2F1E9;color:#2E7D55;font-weight:700;font-size:12.5px;cursor:pointer',onClick:()=>this.mark(r[0],'pass')},{label:'Fail',style:'flex:1;padding:9px;border-radius:9px;background:#FBE6E1;color:#C0492E;font-weight:700;font-size:12.5px;cursor:pointer',onClick:()=>this.mark(r[0],'fail')}]};
      });
    } else {
      out.mobileTitle='Putaway scan'; out.mobileSub='Confirm shelf locations';
      out.mobileScanLabel='Scan bottle code'; out.mobileScanCode='RM-00117 → Z3 · R3 · B2';
      out.mobileListLabel='Pending putaways';
      const rows=this.data().warehouse.rows;
      out.mobileItems=rows.slice(0,4).map((r,i)=>{ const id='wm'+i; const done=this.state.rowStatus['warehouse:'+id]==='ok'; 
        return {code:r[1][0],sub:r[1][2]+' · '+r[1][3],tag:done?'Placed':'To shelve',tagStyle:`padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:${done?'#E2F1E9':'#F8EFD8'};color:${done?'#2E7D55':'#9A6B1E'};flex:none`,
          showActions:!done,
          actions:[{label:'Confirm location',style:'flex:1;padding:9px;border-radius:9px;background:var(--accent);color:#fff;font-weight:700;font-size:12.5px;cursor:pointer',onClick:()=>this.mark(id,'ok')}]};
      });
    }
  }
}
