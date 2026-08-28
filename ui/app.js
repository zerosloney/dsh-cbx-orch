console.log('cbx-ui: script start, page loaded at', new Date().toISOString());
var allWorkspaces=[];
var currentWorkspace=null;
var selected=null;
var filterStatus='';
// 队列条目的排队滞留原因（jobId → deferReason），refresh 时由 /api/queue 构建：
// 进程级全局并发闸（governance.maxGlobalConcurrent）满时排队任务显示"等待全局并发闸"。
var queueDefer={};

// 主题状态管理：默认淡色简约风格 (light)
var currentTheme = localStorage.getItem('cbx-theme') || 'light';
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('cbx-theme', theme); } catch(e){}
  var btn = document.querySelector('#theme-toggle');
  var txt = document.querySelector('#theme-toggle-text');
  if (btn && txt) {
    if (theme === 'dark') {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg><span id="theme-toggle-text">深色</span>';
    } else {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg><span id="theme-toggle-text">浅色</span>';
    }
  }
}
applyTheme(currentTheme);

document.addEventListener('DOMContentLoaded', function(){
  applyTheme(currentTheme);
  var toggleBtn = document.querySelector('#theme-toggle');
  if(toggleBtn) {
    toggleBtn.addEventListener('click', function(){
      applyTheme(currentTheme === 'light' ? 'dark' : 'light');
      refresh();
    });
  }
});

function rowAttr(id){
  return window.CSS&&CSS.escape?CSS.escape(String(id)):String(id).replace(/[^\w-]/g,function(c){return'\\'+c});
}

function totalJobs(w){
  return Object.values(w.jobsByStatus||{}).reduce(function(a,b){return a+b;},0);
}

function fmt(iso){
  try{return new Date(iso).toLocaleTimeString()}catch(e){return iso}
}

function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#27;');
}

// 状态分组：把粒度状态归并到分布条/过滤用的分组。key 决定颜色与过滤集合。
function getStatusGroups() {
  var isDark = currentTheme === 'dark';
  return [
    {key:'done',label:'完成',color:isDark?'#10b981':'#059669',match:['done']},
    {key:'running',label:'运行中',color:isDark?'#f59e0b':'#d97706',match:['running']},
    {key:'queued',label:'排队',color:isDark?'#60a5fa':'#2563eb',match:['queued']},
    {key:'awaiting_approval',label:'待审批',color:isDark?'#fb923c':'#ea580c',match:['awaiting_approval']},
    {key:'failed',label:'失败',color:isDark?'#ef4444':'#dc2626',match:['failed']},
    {key:'needs_fix',label:'返工',color:isDark?'#f43f5e':'#e11d48',match:['needs_fix','review_failed']},
    {key:'cancelled',label:'已取消',color:isDark?'#94a3b8':'#64748b',match:['cancelled']},
  ];
}

function statusGroupKey(s){
  var groups = getStatusGroups();
  for(var i=0;i<groups.length;i++){
    if(groups[i].match.indexOf(s)>=0)return groups[i].key;
  }
  return '';
}

function matchesFilter(j){
  if(!filterStatus)return true;
  return statusGroupKey(j.status)===filterStatus;
}

function cardEnableFilter(){
  document.querySelectorAll('#cards .card').forEach(function(c){
    c.classList.toggle('clickable',!!c.dataset.filter);
    c.classList.toggle('filter-active',!!c.dataset.filter&&c.dataset.filter===filterStatus);
  });
}

function cbxFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{});
  opts.credentials='same-origin';
  return fetch(url,opts).then(function(res){
    return res;
  });
}

function cbxPost(url,body){
  body=body||{};
  return cbxFetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}

function safeJson(r){
  return r.json().catch(function(){return null});
}

async function refresh(){
  if(allWorkspaces.length === 0){
    await loadWorkspaces();
  }
  var ws=encodeURIComponent(currentWorkspace||'');
  var jobs=await cbxFetch('api/jobs?workspace='+ws).then(safeJson)||[];
  var q=await cbxFetch('api/queue?workspace='+ws).then(safeJson)||{entries:[]};
  queueDefer={};
  (q.entries||[]).forEach(function(e){if(e.deferReason)queueDefer[e.jobId]=e.deferReason;});
  updateCards(jobs,q);
  var filtered=filterStatus?jobs.filter(matchesFilter):jobs;
  document.querySelector('#jobs').innerHTML=filtered.map(rowHtml).join('');
  if(filtered.length===0){
    document.querySelector('#jobs').innerHTML='<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:32px;font-size:13px"><div style="display:inline-flex;flex-direction:column;align-items:center;gap:8px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>没有匹配的'+(filterStatus?'':(jobs.length===0?'任务：在上方输入描述创建第一个任务吧。':'任务。'))+'</span></div></td></tr>';
  }
  if(selected){
    var row=document.querySelector('tr.job[data-id="'+rowAttr(selected)+'"]');
    if(row)row.classList.add('selected');
  }
  renderWorkspaces();
}

function updateCards(jobs,q){
  var total=jobs.length;
  var running=jobs.filter(function(j){return j.status==='running';}).length;
  var failed=jobs.filter(function(j){return j.status==='failed';}).length;
  var needsFix=jobs.filter(function(j){return j.status==='needs_fix'||j.status==='review_failed';}).length;
  var approval=jobs.filter(function(j){return j.status==='awaiting_approval';}).length;
  var done=jobs.filter(function(j){return j.status==='done';}).length;
  var queued=jobs.filter(function(j){return j.status==='queued';}).length;
  var active=(q.entries||[]).filter(function(e){return e.status==='running';}).length;
  var depth=(q.entries||[]).filter(function(e){return['queued','running','awaiting_approval'].indexOf(e.status)>=0;}).length;
  var last=jobs.reduce(function(m,j){return j.updatedAt>m?j.updatedAt:m;},'');

  // 更新卡片
  setCard('c-total',total);
  setCard('c-running',running+' / '+(q.maxConcurrent||'\u2014'),running>0?'s-running':'');
  setCard('c-queued',depth+(q.paused?' (\u6682\u505c)':''),q.paused?'s-running':'');
  setCard('c-approval',approval,approval>0?'s-awaiting_approval':'');
  setCard('c-failed',failed,failed>0?'s-failed':'');
  setCard('c-needs-fix',needsFix,needsFix>0?'s-needs_fix':'');
  setCard('c-done',done,done>0?'s-done':'');
  document.querySelector('#c-last').textContent=last?fmt(last):'\u2014';

  // 健康卡
  setCard('c-health',q.paused?'\u6682\u505c':failed>0?failed+'\u4e2a\u5931\u8d25':active>0?'\u8fd0\u884c\u4e2d':'\u7a7a\u95f2',q.paused?'s-running':failed>0?'s-failed':active>0?'s-running':'s-done');

  // 队列控制按钮
  var pauseBtn=document.querySelector('#btn-pause');
  var resumeBtn=document.querySelector('#btn-resume');
  if(pauseBtn)pauseBtn.hidden=q.paused;
  if(resumeBtn)resumeBtn.hidden=!q.paused;

  // 分布条
  renderDistBar(jobs);

  // 卡片点击过滤
  cardEnableFilter();

  // 过滤指示
  var fb=document.querySelector('#filter-bar');
  if(filterStatus){
    fb.hidden=false;
    var groups = getStatusGroups();
    var group=groups.find(function(g){return g.key===filterStatus})||{};
    document.querySelector('#filter-label').textContent='当前筛选：'+(group.label||filterStatus);
  } else {
    fb.hidden=true;
  }
}

function setCard(id,value,cls){
  var el=document.querySelector('#'+id);
  if(!el)return;
  el.textContent=value;
  el.className='card-value'+(cls?' '+cls:'');
}

function renderDistBar(jobs){
  var bar=document.querySelector('#dist-bar');
  if(!jobs.length){bar.hidden=true;return;}
  var groups = getStatusGroups();
  var counts={};
  groups.forEach(function(g){counts[g.key]=0;});
  jobs.forEach(function(j){var k=statusGroupKey(j.status);if(k)counts[k]++;});
  var total=jobs.length;
  var html='';
  groups.forEach(function(g){
    var c=counts[g.key];
    if(!c)return;
    var pct=Math.round(c/total*100);
    html+='<div class="dist-seg" style="flex:'+c+';background:'+g.color+'" title="'+g.label+': '+c+' ('+pct+'%)"></div>';
  });
  bar.innerHTML=html;
  bar.hidden=false;
}

async function loadWorkspaces(){
  console.log('cbx-ui: loadWorkspaces called');
  try{
    var response=await cbxFetch('api/workspaces');
    if(!response.ok) throw new Error('HTTP '+response.status);
    var data=await response.json();
    allWorkspaces=data.workspaces||[];
    if(!currentWorkspace || !allWorkspaces.some(function(w){return w.path===currentWorkspace;})){
      currentWorkspace=data.default || (allWorkspaces[0] && allWorkspaces[0].path) || '';
    }
    var qs=new URLSearchParams(location.search);
    var req=qs.get('workspace');
    if(req&&allWorkspaces.some(function(w){return w.path===req;}))currentWorkspace=req;
    renderWorkspaces();
  }catch(e){
    console.error('cbx-ui: loadWorkspaces error', e);
    var nameEl = document.querySelector('#ws-name');
    if(nameEl && (nameEl.textContent === '—' || nameEl.textContent === '')) {
      nameEl.textContent = '默认工作区';
    }
  }
}

function renderWorkspaces(){
  var cur=allWorkspaces.find(function(w){return w.path===currentWorkspace;}) || allWorkspaces[0];
  var nameEl=document.querySelector('#ws-name');
  var countEl=document.querySelector('#ws-count');
  if(cur){
    if(nameEl) nameEl.textContent = cur.name || cur.path;
    var t = totalJobs(cur);
    if(countEl) countEl.textContent = t ? '(' + t + ')' : '';
  } else if(currentWorkspace){
    if(nameEl) nameEl.textContent = currentWorkspace;
    if(countEl) countEl.textContent = '';
  } else {
    if(nameEl && nameEl.textContent === '—') nameEl.textContent = '默认工作区';
    if(countEl) countEl.textContent = '';
  }

  var list=document.querySelector('#ws-list');
  if(!list) return;
  if(allWorkspaces.length>1){
    list.hidden=false;
    list.innerHTML=allWorkspaces.map(function(w){
      var t=totalJobs(w);var failed=(w.jobsByStatus&&w.jobsByStatus.failed)||0;
      var dot=failed>0?'#ef4444':(w.activeExecutors>0?'#f59e0b':'#10b981');
      var active=w.path===currentWorkspace?' active':'';
      return '<button type="button" class="ws-chip'+active+'" data-path="'+esc(w.path)+'"><span class="dot" style="background:'+dot+'"></span><span>'+esc(w.name)+'</span><span style="color:var(--text-muted)">'+t+(failed>0?' \u00b7 '+failed+' fail':'')+'</span></button>';
    }).join('');
    list.querySelectorAll('.ws-chip').forEach(function(b){b.addEventListener('click',function(){switchWorkspace(b.dataset.path);});});
  } else {
    list.hidden=true;
  }
}

function switchWorkspace(path){
  if(path===currentWorkspace||!allWorkspaces.some(function(w){return w.path===path;}))return;
  currentWorkspace=path;
  var qs=new URLSearchParams(location.search);qs.set('workspace',path);
  history.replaceState(null,'','?'+qs.toString());
  selected=null;renderWorkspaces();refresh();
  document.querySelector('#detail-body').innerHTML='<p class="hint">\u70b9\u51fb\u4e0a\u65b9\u4efb\u52a1\u884c\u67e5\u770b\u8be6\u60c5</p>';
}

function fmtElapsed(iso) {
  if (!iso) return '\u2014';
  var ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return '\u2014';
  if (ms < 1000) return Math.floor(ms) + 'ms';
  if (ms < 60000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
  return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
}

function rowHtml(j){
  var cls='job'+(selected===j.jobId?' selected':'');
  var terminal=['done','failed','review_failed','cancelled','needs_fix'].indexOf(j.status)>=0;
  var elapsed = terminal && j.totalSeconds != null ? (j.totalSeconds < 60 ? j.totalSeconds + 's' : Math.floor(j.totalSeconds/60) + 'm ' + (j.totalSeconds%60) + 's') : fmtElapsed(j.createdAt);
  var audit = auditBadge(j.__audit);
  var defer=queueDefer[j.jobId];
  var deferHtml=(j.status==='queued'&&defer==='global_cap')
    ? ' <span class="defer-badge" title="进程级全局并发闸（governance.maxGlobalConcurrent）已满：等待其他工作区的任务释放槽位，完成后自动续跑。">⏳ 等待全局并发闸</span>'
    : '';
  return '<tr class="'+cls+'" data-id="'+esc(j.jobId)+'" data-created="'+esc(j.createdAt||'')+'" data-terminal="'+terminal+'">'
    + '<td><button type="button" class="job-select">'+esc(j.jobId)+'</button></td>'
    + '<td class="s-'+esc(j.status)+'"><span class="status-dot"></span>'+esc(j.status)+deferHtml+'</td>'
    + '<td><span class="phase-tag">'+esc(j.phase||'—')+'</span></td>'
    + '<td>'+esc(String(j.attempt))+'</td>'
    + '<td class="v-'+esc(j.reviewVerdict||'')+'">'+esc(j.reviewVerdict||'—')+'</td>'
    + '<td class="elapsed">'+elapsed+'</td>'
    + '<td class="audit '+audit.cls+'">'+audit.text+'</td>'
    + '<td style="color:var(--text-muted);font-size:12px">'+esc(fmt(j.updatedAt))+'</td>'
    + '</tr>';
}

function auditBadge(a){
  if(!a)return {text:'—',cls:'audit-na'};
  if(a.tampered)return {text:'⚠ 篡改!',cls:'audit-tampered'};
  if(a.valid)return {text:'✓ 完整',cls:'audit-ok'};
  return {text:'—',cls:'audit-na'};
}

function selectJob(id){
  selected=(selected===id)?null:id;
  refresh();
  if(selected){
    loadDetail(selected);
  } else {
    document.querySelector('#detail-body').innerHTML='<p class="hint">点击上方任务行查看详情</p>';
  }
}

// 全局一键复制辅助函数
window.copyCode = function(btn, id){
  var el=document.getElementById(id);
  if(!el)return;
  var text=el.innerText||el.textContent;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){
      var orig=btn.innerHTML;
      btn.innerHTML='✓ 已复制';
      btn.classList.add('copied');
      setTimeout(function(){btn.innerHTML=orig;btn.classList.remove('copied');},1500);
    }).catch(function(){});
  }
};

function renderCodeBlock(title, content, idPrefix){
  var id=(idPrefix||'code')+'-'+Math.random().toString(36).slice(2,8);
  return '<div class="code-container">'
    + '<div class="code-header">'
    + '<span class="code-title">'+esc(title)+'</span>'
    + '<button type="button" class="btn-copy" onclick="copyCode(this, \''+id+'\')">📋 复制</button>'
    + '</div>'
    + '<pre class="art-view" id="'+id+'">'+esc(content)+'</pre>'
    + '</div>';
}

async function loadDetail(id){
  var body=document.querySelector('#detail-body');
  body.innerHTML='<p class="hint">加载任务详情中…</p>';
  
  var result=null;
  try{result=JSON.parse(await cbxFetch('api/jobs/'+id+'/artifact/result.json').then(function(r){return r.text()}));}catch(e){}
  var stageHtml='';
  if(result&&result.stages&&result.stages.length){
    stageHtml+='<div class="stages">';
    result.stages.forEach(function(s,i){
      var v=s.reviewVerdict||(s.exitCode===0?(s.testExitCode===0||s.testExitCode===null?'PASS':'FAIL'):'FAIL');
      var cls=v==='PASS'?'st-pass':v==='FAIL'?'st-fail':'st-skip';
      var icon=v==='PASS'?'✓':v==='FAIL'?'✕':'•';
      if(i>0)stageHtml+='<span class="arrow">→</span>';
      stageHtml+='<span class="stage '+cls+'"><span class="stage-icon">'+icon+'</span>'+esc(s.name)+' <span style="opacity:0.65">('+esc(s.executor)+')</span>'+(v?' · <b>'+v+'</b>':'')+'</span>';
    });
    stageHtml+='</div>';
  }
  body.innerHTML=stageHtml+'<div class="tabs" id="detail-tabs"></div><div class="tab-panels" id="detail-panels"></div>';

  (function renderActions(){
    var status=result&&result.status||'';
    var actions=[];
    if(status==='awaiting_approval')actions.push({name:'approve',label:'✓ 批准任务'});
    if(['queued','running'].indexOf(status)>=0)actions.push({name:'cancel',label:'✕ 取消任务'});
    if(['failed','needs_fix','review_failed','cancelled'].indexOf(status)>=0)actions.push({name:'retry',label:'⟳ 重试任务'});
    if(['needs_fix','review_failed'].indexOf(status)>=0)actions.push({name:'continue',label:'➔ 继续修复'});
    if(status && ['done','failed','review_failed','needs_fix','cancelled'].indexOf(status)>=0){
      actions.push({name:'forget',label:'Forget（保留 worktree）',confirm:'确定要 forget '+id+' 吗？state.json / events.ndjson / 全部工件会被删除，worktree 保留。此操作不可撤销。'});
      actions.push({name:'purge',label:'Purge（彻底删除）',confirm:'确定要 purge '+id+' 吗？worktree + state + 全部工件都会删除。此操作不可撤销。'});
    }
    if(!actions.length)return;
    var bar=document.querySelector('#detail-body .job-actions');
    if(!bar){bar=document.createElement('div');bar.className='job-actions';body.insertBefore(bar,body.firstChild);}
    bar.innerHTML=actions.map(function(a){
      var confirmAttr = a.confirm ? ' data-confirm="'+esc(a.confirm)+'"' : '';
      return '<button type="button" class="job-action" data-action="'+a.name+'"'+confirmAttr+'>'+a.label+'</button>';
    }).join('');
    bar.querySelectorAll('.job-action').forEach(function(btn){
      btn.addEventListener('click',async function(){
        var action=btn.dataset.action;
        var confirmMsg=btn.dataset.confirm;
        if(confirmMsg && !window.confirm(confirmMsg))return;
        btn.disabled=true;
        var orig=btn.textContent;
        btn.textContent='处理中…';
        try{
          var res=await cbxPost('api/jobs/'+encodeURIComponent(id)+'/'+action,action==='continue'?{message:'请根据 review.md 修复问题。'}:{});
          if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}
          if(action==='forget'||action==='purge'){selectJob(null);}
          else{loadDetail(id);}
          refresh();
        }catch(e){
          btn.disabled=false;btn.textContent=orig;
          alert('操作失败：'+(e instanceof Error?e.message:String(e)));
        }
      });
    });
  })();

  var tabs=[
    {name:'overview',label:'概览'},
    {name:'timeline',label:'阶段时间线'},
    {name:'executor',label:'执行器'},
    {name:'diff',label:'Diff'},
    {name:'test',label:'Test 日志'},
    {name:'review',label:'Review 审查'},
  ];
  var tabsEl=document.querySelector('#detail-tabs');
  var panelsEl=document.querySelector('#detail-panels');
  tabsEl.innerHTML=tabs.map(function(t,i){return '<button type="button" class="tab'+(i===0?' active':'')+'" data-tab="'+t.name+'">'+t.label+'</button>';}).join('');
  panelsEl.innerHTML=tabs.map(function(t,i){return '<div class="tab-panel'+(i===0?' active':'')+'" data-tab="'+t.name+'">加载中…</div>';}).join('');
  tabsEl.querySelectorAll('.tab').forEach(function(btn){
    btn.addEventListener('click',function(){
      tabsEl.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
      btn.classList.add('active');
      panelsEl.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});
      panelsEl.querySelector('.tab-panel[data-tab="'+btn.dataset.tab+'"]').classList.add('active');
      loadTab(id,btn.dataset.tab,panelsEl,result);
    });
  });

  loadTab(id,'overview',panelsEl,result);
}

async function loadTab(id,tab,panelsEl,result){
  var panel=panelsEl.querySelector('.tab-panel[data-tab="'+tab+'"]');
  if(!panel)return;
  panel.innerHTML='<p class="hint">加载中…</p>';
  try{
    if(tab==='overview'){
      var html='';
      if(result){
        html+='<div style="display:flex;flex-direction:column;gap:10px">';
        html+='<div style="font-size:14px"><b>任务状态：</b><span class="s-'+esc(result.status||'')+'" style="font-weight:600">'+esc(result.status||'—')+'</span></div>';
        if(result.auditIntegrity){
          var ai=result.auditIntegrity;
          var badge=ai.tampered?'<b style="color:var(--status-failed)">⚠ 篡改!</b> 事件日志与 SQLite 镜像不一致（执行器可能篡改了 events.ndjson）':(ai.valid?'<b style="color:var(--status-done)">✓ 审计完整</b>':'<span style="color:var(--text-muted)">无法验证</span>');
          html+='<div><b>审计完整性：</b>'+badge+(typeof ai.ndjsonCount==='number'?' <span style="color:var(--text-muted)">('+ai.ndjsonCount+' 个事件)</span>':'')+'</div>';
        }
        if(result.handback){
          html+=renderCodeBlock('Agent Handback 交付说明', result.handback, 'hb');
        }
        if(result.evidenceArtifacts){
          html+='<div style="margin-top:4px;color:var(--text-muted);font-size:12px">💡 证据工件已生成，可在 Diff / Test / Review 选项卡中查阅详情。</div>';
        }
        html+='</div>';
      } else {
        html='<p class="hint">任务尚未生成 result.json。</p>';
      }
      panel.innerHTML=html;
    }
    else if(tab==='timeline'){
      var tl=await cbxFetch('api/jobs/'+id+'/timeline').then(function(r){return r.json()});
      if(!tl.stages||!tl.stages.length){panel.innerHTML='<p class="hint">无阶段转换记录。</p>';return;}
      var maxMs=Math.max.apply(null,tl.stages.map(function(s){return s.durationMs||0;}).concat([1000]));
      var rows=tl.stages.map(function(s){
        var dur=s.durationMs!=null?(s.durationMs<1000?s.durationMs+'ms':(s.durationMs/1000).toFixed(1)+'s'):'进行中';
        var pct=s.durationMs?Math.max(4,Math.round((s.durationMs/maxMs)*100)):4;
        var color=s.name==='done'?'var(--status-done)':['failed','review_failed','cancelled'].indexOf(s.name)>=0?'var(--status-failed)':s.name==='running'?'var(--status-running)':'var(--brand-primary)';
        var label=s.phase?s.name+' / '+s.phase:s.name;
        return '<div class="timeline-row">'
          + '<div class="timeline-name">'+esc(label)+'</div>'
          + '<div class="timeline-bar-wrapper"><div class="timeline-bar" style="width:'+pct+'%;background:'+color+'"></div></div>'
          + '<div class="timeline-dur">'+dur+'</div>'
          + '<div class="timeline-at">'+esc((s.startedAt||'').slice(11,19))+'</div>'
          + '</div>';
      }).join('');
      panel.innerHTML='<div style="margin-bottom:12px;color:var(--text-secondary)">当前阶段：<b>'+esc(tl.currentStage||'—')+'</b> · 已运行 <b>'+tl.elapsedSec+'s</b></div>'+rows;
    }
    else if(tab==='executor'){
      var ex=await cbxFetch('api/jobs/'+id+'/executor').then(function(r){return r.json()});
      var pulse=ex.alive===true?'pulse-alive':ex.alive===false?'pulse-dead':'pulse-unknown';
      var html='<div class="exec-card">';
      html+='<div><div class="field-label">PID</div><div class="field-value"><span class="pulse '+pulse+'"></span>'+(ex.pid!=null?ex.pid:'—')+'</div></div>';
      html+='<div><div class="field-label">进程状态</div><div class="field-value">'+(ex.alive===true?'活跃 (Alive)':ex.alive===false?'已退出 (Exited)':'未知')+'</div></div>';
      html+='<div><div class="field-label">心跳时间</div><div class="field-value">'+(ex.heartbeatAt?ex.heartbeatAt.slice(11,19)+' ('+ex.heartbeatStaleSec+'s 前)':ex.heartbeatAt===null?'无文件':'—')+'</div></div>';
      html+='<div><div class="field-label">已运行耗时</div><div class="field-value">'+(ex.elapsedSec!=null?ex.elapsedSec+'s':'—')+'</div></div>';
      var inv=Number(ex.executorInvocations)||0;
      var mt=Number(ex.configuredMaxTurns);
      var perStage=ex.stageInvocations||{};
      html+='<div><div class="field-label">执行器调用</div><div class="field-value">'+inv+' 次</div></div>';
      if(Number.isFinite(mt)&&mt>0){
        var maxTotal=mt*inv;
        html+='<div><div class="field-label">maxTurns × 调用</div><div class="field-value">'+mt+' × '+inv+' = '+maxTotal+'（理论上限）</div></div>';
      } else {
        html+='<div><div class="field-label">maxTurns × 调用</div><div class="field-value">'+mt+' × '+inv+' = —（旧任务无此字段）</div></div>';
      }
      var stageKeys=Object.keys(perStage);
      if(stageKeys.length){
        var stageList=stageKeys.sort().map(function(k){return 'stage['+k+']='+perStage[k];}).join(', ');
        html+='<div><div class="field-label">per-stage</div><div class="field-value" style="font-size:12px">'+esc(stageList)+'</div></div>';
      }
      html+='</div>';
      if(ex.command)html+='<div class="cmd"><code>$ '+esc(ex.command)+'</code></div>';
      var log=await cbxFetch('api/jobs/'+id+'/agent.log?since=0').then(function(r){return r.json()});
      if(log&&log.content){
        html+='<div style="margin-top:14px">'+renderCodeBlock('agent.log 尾部日志', log.content, 'agent-log')+'</div>';
      }
      panel.innerHTML=html;
    }
    else if(tab==='diff'){
      var txt=await cbxFetch('api/jobs/'+id+'/artifact/complete.patch').then(function(r){return r.text()});
      panel.innerHTML=renderCodeBlock('complete.patch', txt, 'diff');
    }
    else if(tab==='test'){
      try{
        var txt=await cbxFetch('api/jobs/'+id+'/artifact/test.log').then(function(r){return r.text()});
        panel.innerHTML=renderCodeBlock('test.log', txt, 'test');
      }catch(e){
        panel.innerHTML='<p class="hint">任务未运行测试或尚未产生测试日志。</p>';
      }
    }
    else if(tab==='review'){
      try{
        var txt=await cbxFetch('api/jobs/'+id+'/artifact/review.md').then(function(r){return r.text()});
        panel.innerHTML=renderCodeBlock('review.md', txt, 'review');
      }catch(e){
        panel.innerHTML='<p class="hint">任务未启用 review 或审查还在进行中。</p>';
      }
    }
  } catch(e){
    panel.innerHTML='<p class="hint">加载失败：'+esc(e instanceof Error?e.message:String(e))+'</p>';
  }
}

document.querySelector('#jobs').addEventListener('click',function(e){
  var row=e.target.closest('tr.job');
  if(row)selectJob(row.dataset.id);
});

document.querySelector('#cards').addEventListener('click',function(e){
  var card=e.target.closest('.card');
  if(!card)return;
  var f=card.dataset.filter||'';
  if(!f){
    filterStatus='';
    selected=null;
    refresh();
    return;
  }
  filterStatus=(filterStatus===f)?'':f;
  selected=null;
  refresh();
  document.querySelector('#detail-body').innerHTML='<p class="hint">点击上方任务行查看详情</p>';
});

document.querySelector('#btn-clear-filter')&&document.querySelector('#btn-clear-filter').addEventListener('click',function(){
  filterStatus='';
  selected=null;
  refresh();
});

document.querySelector('#btn-pause').addEventListener('click',async function(){
  var btn=this;btn.disabled=true;
  try{
    var res=await cbxPost('api/queue/pause');
    if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}
    refresh();
  }catch(e){
    alert('暂停失败：'+(e instanceof Error?e.message:String(e)));
  }finally{
    btn.disabled=false;
  }
});

document.querySelector('#btn-resume').addEventListener('click',async function(){
  var btn=this;btn.disabled=true;
  try{
    var res=await cbxPost('api/queue/resume');
    if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}
    refresh();
  }catch(e){
    alert('恢复失败：'+(e instanceof Error?e.message:String(e)));
  }finally{
    btn.disabled=false;
  }
});

document.querySelector('#btn-create').addEventListener('click',async function(){
  var input=document.querySelector('#new-task');
  var task=(input.value||'').trim();
  if(!task){input.focus();return;}
  var btn=this;btn.disabled=true;
  try{
    var ws=encodeURIComponent(currentWorkspace||'');
    var res=await cbxPost('api/jobs?workspace='+ws,{task:task});
    if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}
    input.value='';
    refresh();
  }catch(e){
    alert('创建失败：'+(e instanceof Error?e.message:String(e)));
  }finally{
    btn.disabled=false;
  }
});

document.querySelector('#new-task').addEventListener('keydown',function(e){
  if(e.key==='Enter')document.querySelector('#btn-create').click();
});

window.addEventListener('keydown', function(e){
  if(e.key==='/' && document.activeElement !== document.querySelector('#new-task')){
    e.preventDefault();
    document.querySelector('#new-task').focus();
  } else if(e.key==='Escape' && selected){
    selectJob(selected);
  }
});

loadWorkspaces().then(refresh);

setInterval(function(){
  refresh().catch(function(e){console.warn('cbx-ui: refresh failed',e);});
},1500);

function refreshElapsedRows(){
  document.querySelectorAll('tr.job').forEach(function(row){
    if(row.getAttribute('data-terminal')==='true')return;
    var created=row.getAttribute('data-created');
    if(!created)return;
    var cell=row.querySelector('.elapsed');if(!cell)return;
    cell.textContent=fmtElapsed(created);
  });
}
setInterval(refreshElapsedRows,1000);

var stream=document.querySelector('#stream');
var esErrorStreak=0;
var es=new EventSource('events',{withCredentials:true});
es.onerror=function(e){
  esErrorStreak++;
  if(esErrorStreak>10){
    es.close();
    console.warn('cbx-ui: SSE 持续失败，已停止自动重连（依赖轮询刷新）');
  }
};
es.onmessage=function(e){
  esErrorStreak=0;
  var d=JSON.parse(e.data);
  if(d.type==='heartbeat'||d.type==='connected')return;
  var p=d.payload||{};
  var status=p.status||'';
  var div=document.createElement('div');
  div.className='evt';
  var sStatus=esc(status);
  var txt='<span class="t">'+esc(fmt(d.at))+'</span>';
  if(p.jobId)txt+='<span class="s-'+sStatus+'" style="font-weight:600">['+esc(p.jobId)+']</span> ';
  if(p.previousStatus)txt+='<span class="s-'+esc(p.previousStatus)+'">'+esc(p.previousStatus)+'</span> <span style="color:var(--text-dim)">➔</span> <span class="s-'+sStatus+'">'+sStatus+'</span>';
  else if(status)txt+='<span class="s-'+sStatus+'">'+sStatus+'</span>';
  if(p.phase)txt+=' <span class="phase-tag">'+esc(p.phase)+'</span>';
  div.innerHTML=txt;
  stream.appendChild(div);
  stream.scrollTop=stream.scrollHeight;
  while(stream.children.length>200)stream.removeChild(stream.firstChild);
};

if(window.addEventListener){
  window.addEventListener('beforeunload',function(){es.close();});
}
