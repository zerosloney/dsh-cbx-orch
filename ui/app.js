console.log('cbx-ui: script start, page loaded at', new Date().toISOString());
var allWorkspaces=[];
var currentWorkspace=null;
var selected=null;
var filterStatus='';
function rowAttr(id){return window.CSS&&CSS.escape?CSS.escape(String(id)):String(id).replace(/[^\w-]/g,function(c){return'\\'+c})}
function totalJobs(w){return Object.values(w.jobsByStatus||{}).reduce(function(a,b){return a+b;},0)}
function fmt(iso){try{return new Date(iso).toLocaleTimeString()}catch(e){return iso}}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;')}
// 状态分组：把粒度状态归并到分布条/过滤用的分组。key 决定颜色与过滤集合。
var STATUS_GROUPS=[
  {key:'done',label:'完成',color:'#70e090',match:['done']},
  {key:'running',label:'运行中',color:'#ffd166',match:['running']},
  {key:'queued',label:'排队',color:'#9ecbff',match:['queued']},
  {key:'awaiting_approval',label:'待审批',color:'#ff9f4a',match:['awaiting_approval']},
  {key:'failed',label:'失败',color:'#ff5d5d',match:['failed']},
  {key:'needs_fix',label:'返工',color:'#ff8d8d',match:['needs_fix','review_failed']},
  {key:'cancelled',label:'已取消',color:'#888888',match:['cancelled']},
];
function statusGroupKey(s){for(var i=0;i<STATUS_GROUPS.length;i++){if(STATUS_GROUPS[i].match.indexOf(s)>=0)return STATUS_GROUPS[i].key;}return '';}
function matchesFilter(j){if(!filterStatus)return true;return statusGroupKey(j.status)===filterStatus;}
function cardEnableFilter(){document.querySelectorAll('#cards .card').forEach(function(c){c.classList.toggle('clickable',!!c.dataset.filter);c.classList.toggle('filter-active',!!c.dataset.filter&&c.dataset.filter===filterStatus);});}
// 401 处理：数据端点需要 token 时弹一次性输入框，POST /auth 换 HttpOnly cookie 后重试原请求。
// token 本身不落 localStorage/URL（HttpOnly cookie 由浏览器托管），输入错误只提示不重试。
var authInProgress=null;
var authCooldownUntil=0;
function ensureAuth(){
  if(authInProgress)return authInProgress;
  if(Date.now()<authCooldownUntil)return Promise.resolve(false);
  authInProgress=new Promise(function(resolve){
    var token=window.prompt('cbx 仪表盘需要访问令牌（见 <工作区>/.cbx/web.token 或 dsh 启动日志）：');
    if(!token){authCooldownUntil=Date.now()+60_000;authInProgress=null;resolve(false);return;}
// 所有请求走相对路径：页面位于 /cbx/ 时解析为 /cbx/...，独立根路径部署同样成立。
    fetch('auth',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:token})})
      .then(function(res){
        if(res.ok){authInProgress=null;resolve(true);}
        else{alert('令牌无效。');authCooldownUntil=Date.now()+60_000;authInProgress=null;resolve(false);}
      })
      .catch(function(){alert('登录请求失败。');authCooldownUntil=Date.now()+60_000;authInProgress=null;resolve(false);});
  });
  return authInProgress;
}
function cbxFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{});
  // token 走 HttpOnly cookie（同源请求自动携带），JS 不可读、不落 URL。
  opts.credentials='same-origin';
  return fetch(url,opts).then(function(res){
    if(res.status===401){
      return ensureAuth().then(function(ok){return ok?fetch(url,opts):res;});
    }
    return res;
  });
}
function cbxPost(url,body){
  body=body||{};
  return cbxFetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}
// 非 JSON 响应（挂载路径错误/网关错误页等）不再让轮询循环抛未处理 rejection。
function safeJson(r){return r.json().catch(function(){return null})}
async function refresh(){
  var ws=encodeURIComponent(currentWorkspace||'');
  var jobs=await cbxFetch('api/jobs?workspace='+ws).then(safeJson)||[];
  var q=await cbxFetch('api/queue?workspace='+ws).then(safeJson)||{entries:[]};
  updateCards(jobs,q);
  var filtered=filterStatus?jobs.filter(matchesFilter):jobs;
  document.querySelector('#jobs').innerHTML=filtered.map(rowHtml).join('');
  if(filtered.length===0)document.querySelector('#jobs').innerHTML='<tr><td colspan="7" style="text-align:center;color:#555;padding:16px;font-size:13px">没有匹配的'+(filterStatus?'':(jobs.length===0?'任务：创建第一个任务吧。':'任务。'))+'</td></tr>';
  if(selected){var row=document.querySelector('tr.job[data-id="'+rowAttr(selected)+'"]');if(row)row.classList.add('selected');}
}
function updateCards(jobs,q){
  var total=jobs.length;
  var running=jobs.filter(function(j){return j.status==='running';}).length;
  var failed=jobs.filter(function(j){return j.status==='failed';}).length;
  var needsFix=jobs.filter(function(j){return j.status==='needs_fix'||j.status==='review_failed';}).length;
  var approval=jobs.filter(function(j){return j.status==='awaiting_approval';}).length;
  var done=jobs.filter(function(j){return j.status==='done';}).length;
  var queued=jobs.filter(function(j){return j.status==='queued';}).length;
  var cancelled=jobs.filter(function(j){return j.status==='cancelled';}).length;
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
    document.querySelector('#filter-label').textContent='\u7b5b\u9009\uFF1A'+(STATUS_GROUPS.find(function(g){return g.key===filterStatus})||{}).label||filterStatus;
  } else { fb.hidden=true; }
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
  var counts={};
  STATUS_GROUPS.forEach(function(g){counts[g.key]=0;});
  jobs.forEach(function(j){var k=statusGroupKey(j.status);if(k)counts[k]++;});
  var total=jobs.length;
  var html='';
  STATUS_GROUPS.forEach(function(g){
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
    console.log('cbx-ui: fetch status', response.status);
    if(!response.ok) throw new Error('HTTP '+response.status);
    var data=await response.json();
    console.log('cbx-ui: got data', data.workspaces ? data.workspaces.length+' workspaces' : 'NO workspaces');
    allWorkspaces=data.workspaces||[];
    currentWorkspace=data.default;
  }catch(e){
    console.error('cbx-ui: loadWorkspaces error', e);
    document.querySelector('#ws-name').textContent='fetch error: '+(e instanceof Error?e.message:String(e));
    return;
  }
  var qs=new URLSearchParams(location.search);
  var req=qs.get('workspace');
  if(req&&allWorkspaces.some(function(w){return w.path===req;}))currentWorkspace=req;
  console.log('cbx-ui: calling renderWorkspaces, currentWorkspace=', currentWorkspace);
  renderWorkspaces();
}
function renderWorkspaces(){
  var list=document.querySelector('#ws-list');
  if(allWorkspaces.length>1){
    list.hidden=false;
    list.innerHTML=allWorkspaces.map(function(w){
      var t=totalJobs(w);var failed=(w.jobsByStatus&&w.jobsByStatus.failed)||0;
      var dot=failed>0?'#ff8d8d':(w.activeExecutors>0?'#ffd166':'#70e090');
      var active=w.path===currentWorkspace?' active':'';
      return '<button class="ws-chip'+active+'" data-path="'+esc(w.path)+'"><span class="dot" style="background:'+dot+'"></span><span>'+esc(w.name)+'</span><span style="color:#888">'+t+(failed>0?' \u00b7 '+failed+' fail':'')+'</span></button>';
    }).join('');
    list.querySelectorAll('.ws-chip').forEach(function(b){b.addEventListener('click',function(){switchWorkspace(b.dataset.path);});});
  } else { list.hidden=true; }
  var cur=allWorkspaces.find(function(w){return w.path===currentWorkspace;});
  document.querySelector('#ws-name').textContent=cur?cur.name:(currentWorkspace||'\u2014');
  document.querySelector('#ws-count').textContent=cur?'('+totalJobs(cur)+')':'';
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
  if (ms < 60_000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600_000) return Math.floor(ms / 60_000) + 'm ' + Math.floor((ms % 60_000) / 1000) + 's';
  return Math.floor(ms / 3600_000) + 'h ' + Math.floor((ms % 3600_000) / 60_000) + 'm';
}
function rowHtml(j){
  var cls='job'+(selected===j.jobId?' selected':'');
  // 终态显示 totalSeconds,非终态用 createdAt 实时算 elapsed。
  var terminal=['done','failed','review_failed','cancelled','needs_fix'].indexOf(j.status)>=0;
  var elapsed = terminal && j.totalSeconds != null ? (j.totalSeconds < 60 ? j.totalSeconds + 's' : Math.floor(j.totalSeconds/60) + 'm ' + (j.totalSeconds%60) + 's') : fmtElapsed(j.createdAt);
  // 审计完整性徽标：__audit.tampered → 篡改!；__audit.valid → ✓；否则 —。
  var audit = auditBadge(j.__audit);
  return '<tr class="'+cls+'" data-id="'+esc(j.jobId)+'" data-created="'+esc(j.createdAt||'')+'" data-terminal="'+terminal+'"><td><button type="button" class="job-select">'+esc(j.jobId)+'</button></td><td class="s-'+esc(j.status)+'">'+esc(j.status)+'</td><td>'+esc(j.phase||'')+'</td><td>'+esc(String(j.attempt))+'</td><td class="v-'+esc(j.reviewVerdict||'')+'">'+esc(j.reviewVerdict||'—')+'</td><td class="elapsed">'+elapsed+'</td><td class="audit '+audit.cls+'">'+audit.text+'</td><td>'+esc(fmt(j.updatedAt))+'</td></tr>';
}
// 审计完整性徽标：篡改!（红色）/ ✓（绿色）/ —（灰色）。__audit 来自后端富化。
function auditBadge(a){
  if(!a)return {text:'—',cls:'audit-na'};
  if(a.tampered)return {text:'篡改!',cls:'audit-tampered'};
  if(a.valid)return {text:'✓',cls:'audit-ok'};
  return {text:'—',cls:'audit-na'};
}
function selectJob(id){
  selected=(selected===id)?null:id;
  refresh();
  if(selected){loadDetail(selected);}else{document.querySelector('#detail-body').innerHTML='<p class="hint">点击上方任务行查看详情</p>';}
}
async function loadDetail(id){
  var body=document.querySelector('#detail-body');
  body.innerHTML='<p>加载中…</p>';
  // Stage chain (top): 受 result.json.stages 驱动,失败/通过着色
  var result=null;
  try{result=JSON.parse(await cbxFetch('api/jobs/'+id+'/artifact/result.json').then(function(r){return r.text()}));}catch(e){}
  var stageHtml='';
  if(result&&result.stages&&result.stages.length){
    stageHtml+='<div class="stages">';
    result.stages.forEach(function(s,i){
      var v=s.reviewVerdict||(s.exitCode===0?(s.testExitCode===0||s.testExitCode===null?'PASS':'FAIL'):'FAIL');
      var cls=v==='PASS'?'st-pass':v==='FAIL'?'st-fail':'st-skip';
      if(i>0)stageHtml+='<span class="arrow">→</span>';
      stageHtml+='<span class="stage '+cls+'">'+esc(s.name)+' / '+esc(s.executor)+(v?' / '+v:'')+'</span>';
    });
    stageHtml+='</div>';
  }
  body.innerHTML=stageHtml+'<div class="tabs" id="detail-tabs"></div><div class="tab-panels" id="detail-panels"></div>';
  // 写操作按钮：按任务状态决定可用动作（awaiting_approval→批准；运行/排队→取消；失败终态→重试/继续）。
  // 与 CLI/MCP 语义一致；POST 经 HttpOnly cookie 鉴权（SameSite=Strict 阻止跨站携带）。
  (function renderActions(){
    var status=result&&result.status||'';
    var actions=[];
    if(status==='awaiting_approval')actions.push({name:'approve',label:'批准'});
    if(['queued','running'].indexOf(status)>=0)actions.push({name:'cancel',label:'取消'});
    if(['failed','needs_fix','review_failed','cancelled'].indexOf(status)>=0)actions.push({name:'retry',label:'重试'});
    if(['needs_fix','review_failed'].indexOf(status)>=0)actions.push({name:'continue',label:'继续'});
    // forget / purge 不可逆——浏览器 confirm() 是天然的安全 UX，二次确认后才能 POST。
    // 状态守卫：与后端原语保持一致，禁止对 running/queued/awaiting_approval 操作；
    // 已在终态或 cancelled 的任务可被 forget / purge。
    if(status && ['done','failed','review_failed','needs_fix','cancelled'].indexOf(status)>=0){
      actions.push({name:'forget',label:'Forget（保留 worktree）',confirm:'确定要 forget '+id+' 吗？state.json / events.ndjson / 全部工件会被删除，worktree 保留。此操作不可撤销。'});
      actions.push({name:'purge',label:'Purge（连 worktree 一起删）',confirm:'确定要 purge '+id+' 吗？worktree + state + 全部工件都会删除。此操作不可撤销。'});
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
        // forget / purge 走浏览器 confirm() 二次确认——这是 Web UI 路径下能给不可逆操作
        // 的最干净 UX（cancel/retry/approve/continue 都是可恢复或低风险的，不弹 confirm）。
        var action=btn.dataset.action;
        var confirmMsg=btn.dataset.confirm;
        if(confirmMsg && !window.confirm(confirmMsg))return;
        btn.disabled=true;
        var orig=btn.textContent;
        btn.textContent='处理中…';
        try{
          var res=await cbxPost('api/jobs/'+encodeURIComponent(id)+'/'+action,action==='continue'?{message:'请根据 review.md 修复问题。'}:{});
          if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}
          // forget / purge 后该 job 在 /api/jobs 里也消失；详情面板没意义，关闭它。
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
  // 动态 tab 列表
  var tabs=[
    {name:'overview',label:'概览'},
    {name:'timeline',label:'阶段时间线'},
    {name:'executor',label:'执行器'},
    {name:'diff',label:'Diff'},
    {name:'test',label:'Test'},
    {name:'review',label:'Review'},
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
  // 默认加载 overview
  loadTab(id,'overview',panelsEl,result);
}
async function loadTab(id,tab,panelsEl,result){
  var panel=panelsEl.querySelector('.tab-panel[data-tab="'+tab+'"]');
  if(!panel)return;
  panel.innerHTML='加载中…';
  try{
    if(tab==='overview'){
      var html='';
      if(result){
        html+='<div><b>状态：</b>'+esc(result.status||'—')+'</div>';
        // 审计完整性：result.auditIntegrity（终态时 ndjson vs SQLite 镜像一致性校验）。
        if(result.auditIntegrity){
          var ai=result.auditIntegrity;
          var badge=ai.tampered?'<b style="color:#ff5d5d">篡改!</b> 事件日志与 SQLite 镜像不一致（执行器可能篡改了 events.ndjson）':(ai.valid?'<b style="color:#70e090">✓ 审计完整</b>':'<span style="color:#888">无法验证</span>');
          html+='<div style="margin-top:6px"><b>审计完整性：</b>'+badge+(typeof ai.ndjsonCount==='number'?' <span style="color:#888">('+ai.ndjsonCount+' 事件)</span>':'')+'</div>';
        }
        if(result.handback)html+='<pre class="art-view" style="display:block;max-height:240px">'+esc(result.handback)+'</pre>';
        if(result.evidenceArtifacts)html+='<div style="margin-top:6px;color:#888">证据刷新在 Diff / Test / Review 选项卡。</div>';
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
        var w=s.durationMs?Math.max(4,Math.round((s.durationMs/maxMs)*320)):4;
        var color=s.name==='done'?'#70e090':['failed','review_failed','cancelled'].indexOf(s.name)>=0?'#ff8d8d':s.name==='running'?'#ffd166':'#5b8def';
        var label=s.phase?s.name+' / '+s.phase:s.name;
        return '<div class="timeline-row"><div class="timeline-name">'+esc(label)+'</div><div class="timeline-bar" style="width:'+w+'px;background:'+color+'"></div><div class="timeline-dur">'+dur+'</div><div class="timeline-at">'+esc((s.startedAt||'').slice(11,19))+'</div></div>';
      }).join('');
      panel.innerHTML='<div style="margin-bottom:8px;color:#888">当前阶段：<b>'+esc(tl.currentStage||'—')+'</b> · 已跑 '+tl.elapsedSec+'s</div>'+rows;
    }
    else if(tab==='executor'){
      var ex=await cbxFetch('api/jobs/'+id+'/executor').then(function(r){return r.json()});
      var pulse=ex.alive===true?'pulse-alive':ex.alive===false?'pulse-dead':'pulse-unknown';
      var html='<div class="exec-card">';
      html+='<div><div class="field-label">PID</div><div class="field-value"><span class="pulse '+pulse+'"></span>'+(ex.pid!=null?ex.pid:'—')+'</div></div>';
      html+='<div><div class="field-label">进程状态</div><div class="field-value">'+(ex.alive===true?'活跃':ex.alive===false?'已退出':'未知')+'</div></div>';
      html+='<div><div class="field-label">心跳</div><div class="field-value">'+(ex.heartbeatAt?ex.heartbeatAt.slice(11,19)+' ('+ex.heartbeatStaleSec+'s 前)':ex.heartbeatAt===null?'无文件':'—')+'</div></div>';
      html+='<div><div class="field-label">已跑</div><div class="field-value">'+(ex.elapsedSec!=null?ex.elapsedSec+'s':'—')+'</div></div>';
      // P0-2: 暴露累计调用次数 + 内外 loop 乘数（maxTurns × invocations）
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
      if(ex.command)html+='<div class="cmd">'+esc(ex.command)+'</div>';
      // 增量 agent.log 拉取(默认读尾部 256KB)
      var log=await cbxFetch('api/jobs/'+id+'/agent.log?since=0').then(function(r){return r.json()});
      if(log.content){
        html+='<h3 style="margin:14px 0 6px;color:#9ecbff">agent.log 尾部</h3>';
        html+='<pre class="art-view" style="display:block;max-height:240px;white-space:pre-wrap">'+esc(log.content)+'</pre>';
      }
      panel.innerHTML=html;
    }
    else if(tab==='diff'){
      var txt=await cbxFetch('api/jobs/'+id+'/artifact/complete.patch').then(function(r){return r.text()});
      panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre">'+esc(txt)+'</pre>';
    }
    else if(tab==='test'){
      try{var txt=await cbxFetch('api/jobs/'+id+'/artifact/test.log').then(function(r){return r.text()});panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre-wrap">'+esc(txt)+'</pre>';}
      catch(e){panel.innerHTML='<p class="hint">任务未运行测试或还没测试日志。</p>';}
    }
    else if(tab==='review'){
      try{var txt=await cbxFetch('api/jobs/'+id+'/artifact/review.md').then(function(r){return r.text()});panel.innerHTML='<pre class="art-view" style="display:block;max-height:380px;white-space:pre-wrap">'+esc(txt)+'</pre>';}
      catch(e){panel.innerHTML='<p class="hint">任务未启用 review 或审查还在进行。</p>';}
    }
  } catch(e){
    panel.innerHTML='<p class="hint">加载失败：'+esc(e instanceof Error?e.message:String(e))+'</p>';
  }
}
document.querySelector('#jobs').addEventListener('click',function(e){
  var row=e.target.closest('tr.job');if(row)selectJob(row.dataset.id);
});
// 卡片点击过滤：data-filter 非空的卡片切换表过滤；空的卡片（总任务/最后活动/健康）清除过滤。
document.querySelector('#cards').addEventListener('click',function(e){
  var card=e.target.closest('.card');if(!card)return;
  var f=card.dataset.filter||'';
  if(!f){filterStatus='';selected=null;refresh();return;}
  filterStatus=(filterStatus===f)?'':f;
  selected=null;
  refresh();
  document.querySelector('#detail-body').innerHTML='<p class="hint">点击上方任务行查看详情</p>';
});
document.querySelector('#btn-clear-filter')&&document.querySelector('#btn-clear-filter').addEventListener('click',function(){
  filterStatus='';selected=null;refresh();
});
document.querySelector('#btn-pause').addEventListener('click',async function(){
  var btn=this;btn.disabled=true;
  try{var res=await cbxPost('api/queue/pause');if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}refresh();}
  catch(e){alert('暂停失败：'+(e instanceof Error?e.message:String(e)));}
  finally{btn.disabled=false;}
});
document.querySelector('#btn-resume').addEventListener('click',async function(){
  var btn=this;btn.disabled=true;
  try{var res=await cbxPost('api/queue/resume');if(!res.ok){var err=await res.json();throw new Error(err.error||('HTTP '+res.status));}refresh();}
  catch(e){alert('恢复失败：'+(e instanceof Error?e.message:String(e)));}
  finally{btn.disabled=false;}
});
// 创建任务：POST /api/jobs（与 CLI `cbx start` 语义一致，后台执行）。
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
  }catch(e){alert('创建失败：'+(e instanceof Error?e.message:String(e)));}
  finally{btn.disabled=false;}
});
document.querySelector('#new-task').addEventListener('keydown',function(e){
  if(e.key==='Enter')document.querySelector('#btn-create').click();
});
loadWorkspaces().then(refresh);
// intentional-simple: 全量轮询 refresh 与 SSE 增量推送并存——SSE 写入 DOM 后 refresh 会重建，存在冗余渲染。
// 单用户本地 UI 的带宽/CPU 可忽略；升级路径：SSE 只更新内存状态，由轻量定时器统一渲染。
setInterval(function(){refresh().catch(function(e){console.warn('cbx-ui: refresh failed',e);})},1500);
// 每秒刷新所有行耗时(不重新拉数据,仅前端算 elapsed)
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
// 401/断网时 EventSource 会每 ~3s 无限重连打爆服务端日志：连续 10 次错误且无任何
// 消息则主动 close，退化为纯轮询；收到消息即重置计数（连接恢复）。
var esErrorStreak=0;
	var es=new EventSource('events',{withCredentials:true});
	es.onerror=function(e){esErrorStreak++;if(esErrorStreak>10){es.close();console.warn('cbx-ui: SSE 持续失败，已停止自动重连（依赖轮询刷新）');}};
	es.onmessage=function(e){
	esErrorStreak=0;
	var d=JSON.parse(e.data);
  if(d.type==='heartbeat'||d.type==='connected')return;
  var p=d.payload||{};
  var status=p.status||'';
  var div=document.createElement('div');
  div.className='evt';
  // status 来自 SSE payload，进 class 属性与文本前先 esc，防非常枚举值逃逸属性/标签。
  var sStatus=esc(status);
  var txt='<span class="t">'+esc(fmt(d.at))+'</span>';
  if(p.jobId)txt+='<span class="s-'+sStatus+'"><b>'+esc(p.jobId)+'</b></span> ';
  if(p.previousStatus)txt+='<span class="s-'+esc(p.previousStatus)+'">'+esc(p.previousStatus)+'</span> → <span class="s-'+sStatus+'">'+sStatus+'</span>';
  else if(status)txt+='<span class="s-'+sStatus+'">'+sStatus+'</span>';
  if(p.phase)txt+=' · '+esc(p.phase);
  div.innerHTML=txt;
  stream.appendChild(div);
  stream.scrollTop=stream.scrollHeight;
  while(stream.children.length>200)stream.removeChild(stream.firstChild);
};
if(window.addEventListener){window.addEventListener('beforeunload',function(){es.close();});}
