/* DDIA Study — static app shell. No framework, hash routing. */
(function(){
'use strict';

/* ---------------- constants ---------------- */
var STORE_KEY = 'ddia-quiz-app-v1';
var TOTAL = 12;
var RATING_LABELS = {5:'exceptional', 4:'pass', 3:'maybe', 2:'needs work', 1:'fail'};
var GRADE_MODEL = 'gpt-4o-mini';

/* ---------------- storage (backend injectable for tests) ---------------- */
function memBackend(){ var m={}; return {getItem:function(k){return (k in m)?m[k]:null;}, setItem:function(k,v){m[k]=String(v);}, removeItem:function(k){delete m[k];}}; }
function browserBackend(){
  try{ localStorage.setItem('__ddia_t','1'); localStorage.removeItem('__ddia_t'); return localStorage; }
  catch(e){ return memBackend(); }
}
var _backend = (typeof localStorage !== 'undefined') ? browserBackend() : memBackend();

function defaultState(){
  return { chapters:{}, capstone:{ attempts:[] }, settings:{ apiKey:'', transcription:'whisper' } };
}
function loadState(backend){
  backend = backend || _backend;
  try{
    var raw = backend.getItem(STORE_KEY);
    if(!raw) return defaultState();
    var s = JSON.parse(raw);
    s.chapters = s.chapters || {};
    s.capstone = s.capstone || { attempts:[] };
    if(!Array.isArray(s.capstone.attempts)) s.capstone.attempts = [];
    s.settings = s.settings || {};
    if(typeof s.settings.apiKey !== 'string') s.settings.apiKey = '';
    if(s.settings.transcription !== 'browser') s.settings.transcription = 'whisper';
    return s;
  }catch(e){ return defaultState(); }
}
function saveState(s, backend){
  backend = backend || _backend;
  try{ backend.setItem(STORE_KEY, JSON.stringify(s)); }catch(e){ /* private mode etc. */ }
}

/* ---------------- pure quiz logic (unit-tested) ---------------- */
function normIdx(a){
  return (a||[]).map(Number).sort(function(x,y){return x-y;}).join(',');
}
/* selected: array of option indices. exact set match required. */
function scoreQuestion(q, selected){
  return normIdx(q.answer) === normIdx(selected);
}
function gradeChapter(chapter, answers){
  var correct = 0;
  chapter.questions.forEach(function(q){ if(scoreQuestion(q, (answers||{})[q.id])) correct++; });
  var total = chapter.questions.length;
  return { correct:correct, total:total, pct: total ? Math.round(correct/total*1000)/10 : 0 };
}
function chapterDone(state, n){
  var c = state.chapters[String(n)];
  return !!(c && c.completed);
}
function allChaptersDone(state){
  for(var n=1;n<=TOTAL;n++) if(!chapterDone(state,n)) return false;
  return true;
}
function missingChapters(state, chapters){
  return chapters.filter(function(ch){ return !chapterDone(state, ch.chapter); });
}
/* self-grade rating suggestion from fraction of rubric points hit */
function suggestSelfRating(hit, total){
  var f = total ? hit/total : 0;
  if(f >= 0.9) return 5;
  if(f >= 0.7) return 4;
  if(f >= 0.5) return 3;
  if(f >= 0.3) return 2;
  return 1;
}

/* ---------------- grading / transcription request builders ---------------- */
function buildGradingMessages(caseData, qa){
  var rubricBlock = qa.map(function(x, i){
    var r = x.rubric;
    var pts = r.keyPoints.map(function(k){
      return '- ' + k.point + ' (DDIA ch. ' + k.chapters.join(', ') + ')';
    }).join('\n');
    return 'Question ' + (i+1) + ': ' + x.question +
      '\nKey points a strong answer hits:\n' + pts +
      '\nWhat an exceptional answer looks like: ' + r.strongAnswer +
      '\nCommon mistakes: ' + r.commonMistakes.join('; ');
  }).join('\n\n');
  var transcripts = qa.map(function(x, i){
    return 'Answer ' + (i+1) + ' transcript:\n' + (x.transcript || '(no answer recorded)');
  }).join('\n\n');
  var system = 'You are a strict but fair distributed-systems interviewer grading a spoken interview ' +
    'for someone studying "Designing Data-Intensive Applications" (Kleppmann). ' +
    'Judge ONLY what is in the transcripts against the rubric key points. ' +
    'Spoken answers are informal: ignore filler words and imperfect grammar, but do not give credit for concepts never mentioned. ' +
    'Return JSON only: {"rating": <integer 1-5>, "feedback": "<2-4 sentences: what was strong, what was missed>", ' +
    '"missedConcepts": ["<short labels of key concepts never addressed>"]}. ' +
    'Rating scale: 5 = exceptional, 4 = pass, 3 = maybe passing, 2 = needs improvement, 1 = fail.';
  var user = 'Case: ' + caseData.title + '\n' + caseData.description +
    '\n\nRubric:\n' + rubricBlock +
    '\n\nCandidate\'s transcribed answers:\n' + transcripts;
  return [{role:'system', content:system}, {role:'user', content:user}];
}
function gradingRequest(caseData, qa, apiKey){
  return {
    url:'https://api.openai.com/v1/chat/completions',
    headers:{'Content-Type':'application/json', 'Authorization':'Bearer ' + apiKey},
    body: JSON.stringify({
      model: GRADE_MODEL,
      response_format: {type:'json_object'},
      temperature: 0.2,
      messages: buildGradingMessages(caseData, qa)
    })
  };
}
function parseGradingResult(text){
  var o;
  try{ o = JSON.parse(text); }
  catch(e){ throw new Error('Grader returned invalid JSON'); }
  var r = parseInt(o.rating, 10);
  if(isNaN(r)) r = 1;
  r = Math.max(1, Math.min(5, r));
  return {
    rating: r,
    feedback: String(o.feedback || 'No feedback returned.'),
    missedConcepts: Array.isArray(o.missedConcepts) ? o.missedConcepts.map(String) : []
  };
}
function whisperRequest(blob, apiKey){
  var fd = new FormData();
  fd.append('file', blob, 'answer.webm');
  fd.append('model', 'whisper-1');
  return {
    url:'https://api.openai.com/v1/audio/transcriptions',
    headers:{'Authorization':'Bearer ' + apiKey},
    body: fd
  };
}

/* ---------------- app state ---------------- */
var state = loadState();
var CONTENT = { chapters:[], capstone:null, missing:[], loaded:false };

function chapterState(n){
  var k = String(n);
  if(!state.chapters[k]) state.chapters[k] = { answers:{}, checked:false, best:0, attempts:0 };
  return state.chapters[k];
}
function persist(){ saveState(state); }

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function toast(msg){
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
}

async function loadContent(){
  var chapters = [], missing = [];
  for(var n=1;n<=TOTAL;n++){
    var id = 'ch' + String(n).padStart(2,'0');
    try{
      var r = await fetch('content/' + id + '.json');
      if(!r.ok) throw new Error('http ' + r.status);
      chapters.push(await r.json());
    }catch(e){ missing.push('content/' + id + '.json'); }
  }
  var capstone = null;
  try{
    var rc = await fetch('content/capstone.json');
    if(!rc.ok) throw new Error('http ' + rc.status);
    capstone = await rc.json();
  }catch(e){ missing.push('content/capstone.json'); }
  chapters.sort(function(a,b){ return a.chapter - b.chapter; });
  return { chapters:chapters, capstone:capstone, missing:missing, loaded:true };
}
function getChapter(n){
  for(var i=0;i<CONTENT.chapters.length;i++) if(CONTENT.chapters[i].chapter === n) return CONTENT.chapters[i];
  return null;
}
function getCase(id){
  if(!CONTENT.capstone) return null;
  for(var i=0;i<CONTENT.capstone.cases.length;i++) if(CONTENT.capstone.cases[i].id === id) return CONTENT.capstone.cases[i];
  return null;
}
function missingBanner(){
  if(!CONTENT.missing.length) return '';
  return '<div class="err"><strong>Missing content file(s):</strong> ' +
    CONTENT.missing.map(function(f){ return '<code>' + esc(f) + '</code>'; }).join(' ') +
    '<br>Those sections will not work until the files are present.</div>';
}
function ring(pct, size, label){
  size = size || 92;
  var r = (size-12)/2, c = 2*Math.PI*r, off = c * (1 - Math.max(0,Math.min(100,pct))/100);
  return '<svg class="ring" width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'">' +
    '<circle cx="'+size/2+'" cy="'+size/2+'" r="'+r+'" fill="none" stroke="#efe9dd" stroke-width="10"/>' +
    '<circle cx="'+size/2+'" cy="'+size/2+'" r="'+r+'" fill="none" stroke="#cf2e2e" stroke-width="10" ' +
    'stroke-linecap="round" stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" transform="rotate(-90 '+size/2+' '+size/2+')"/>' +
    '<text x="50%" y="47%" text-anchor="middle" class="pct">'+Math.round(pct)+'%</text>' +
    '<text x="50%" y="66%" text-anchor="middle" class="lbl">'+esc(label||'done')+'</text></svg>';
}

/* ---------------- router ---------------- */
var IV = null; // active interview session (in-memory only)

function stopInterviewMedia(){
  if(!IV) return;
  try{ if(IV.mr){ IV.mr.onstop = null; if(IV.mr.state !== 'inactive') IV.mr.stop(); } }catch(e){}
  try{ if(IV.stream) IV.stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){}
  try{ if(IV.recog) IV.recog.abort(); }catch(e){}
  try{ if(IV.actx) IV.actx.close(); }catch(e){}
  if(IV.timerH) clearInterval(IV.timerH);
  if(IV.rafH) cancelAnimationFrame(IV.rafH);
  try{ if(typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); }catch(e){}
  IV = null;
}

function setTab(name){
  var tabs = document.querySelectorAll('[data-tab]');
  for(var i=0;i<tabs.length;i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
}
function router(){
  stopInterviewMedia();
  var h = location.hash || '#/';
  var app = document.getElementById('app');
  if(h.indexOf('#/chapter/') === 0){ setTab('chapters'); renderChapter(app, parseInt(h.split('/')[2], 10) || 1); }
  else if(h.indexOf('#/interview/') === 0){ setTab('capstone'); renderInterview(app, h.split('/')[2]); }
  else if(h.indexOf('#/capstone') === 0){ setTab('capstone'); renderCapstone(app); }
  else if(h.indexOf('#/settings') === 0){ setTab('settings'); renderSettings(app); }
  else { setTab('chapters'); renderHome(app); }
  window.scrollTo(0,0);
}

/* ---------------- home ---------------- */
function renderHome(app){
  var done = 0;
  CONTENT.chapters.forEach(function(ch){ if(chapterDone(state, ch.chapter)) done++; });
  // Chapter-row entrance cascade — replays on every home render, per Raymond.
  var rows = CONTENT.chapters.map(function(ch, i){
    var cs = chapterState(ch.chapter);
    var cls = 'chapter-row' + (cs.completed ? ' done' : '') + ' enter';
    var delay = ' style="animation-delay:' + (i * 40) + 'ms"';
    var badge = cs.completed
      ? '<span class="badge done">Done · best ' + cs.best + '%</span>'
      : (cs.attempts > 0 ? '<span class="badge">Best ' + cs.best + '%</span>' : '<span class="badge">Not started</span>');
    return '<a class="' + cls + '"' + delay + ' href="#/chapter/' + ch.chapter + '">' +
      '<span class="num">' + ch.chapter + '</span>' +
      '<span class="meta"><span class="title">' + esc(ch.title) + '</span>' +
      '<span class="sub">' + ch.questions.length + ' questions · ' +
        ch.summary.sections.length + ' sections</span>' +
      '<span class="bar"><i style="width:' + cs.best + '%"></i></span></span>' +
      badge + '</a>';
  }).join('');
  app.innerHTML = missingBanner() +
    '<div class="home-top"><div>' +
    '<h1>Designing Data-Intensive Applications</h1>' +
    '<p class="lede">Chapter summaries plus a quiz per chapter — every question points back to the section of the book it came from. Finish all 12 quizzes to unlock the capstone interviews.</p>' +
    '</div><div class="spacer"></div>' + ring(done/TOTAL*100, 96, done + '/' + TOTAL) + '</div>' +
    rows;
}

/* ---------------- chapter view ---------------- */
function renderChapter(app, n){
  var ch = getChapter(n);
  if(!ch){
    app.innerHTML = '<div class="err">Chapter ' + n + ' content is missing (<code>content/ch' +
      String(n).padStart(2,'0') + '.json</code>).</div><p><a href="#/">Back home</a></p>';
    return;
  }
  var cs = chapterState(n);
  var answers = cs.answers || {};

  var summary = '<div class="card tint"><h2 style="margin-top:0">Chapter ' + ch.chapter + ': ' + esc(ch.title) + '</h2>' +
    '<p>' + esc(ch.summary.overview) + '</p></div>' +
    ch.summary.sections.map(function(s){
      return '<div class="card"><h3>' + esc(s.heading) + '</h3><ul class="takeaways">' +
        s.takeaways.map(function(t){ return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>';
    }).join('');

  var quiz = ch.questions.map(function(q, qi){
    var sel = answers[q.id] || [];
    var marked = cs.checked;
    var ok = marked ? scoreQuestion(q, sel) : null;
    var opts = q.options.map(function(opt, oi){
      var type = q.type === 'multi' ? 'checkbox' : 'radio';
      var checked = sel.indexOf(oi) >= 0 ? ' checked' : '';
      var cls = '';
      if(marked){
        var isAns = q.answer.indexOf(oi) >= 0, isSel = sel.indexOf(oi) >= 0;
        if(isAns && isSel) cls = ' pick-correct';
        else if(!isAns && isSel) cls = ' pick-wrong';
        else if(isAns) cls = ' pick-correct';
      }
      return '<label class="opt"><input type="' + type + '" name="q_' + esc(q.id) + '" value="' + oi + '"' +
        checked + (marked ? ' disabled' : '') + '><span class="' + cls.trim() + '">' + esc(opt) + '</span></label>';
    }).join('');
    var explain = '';
    if(marked){
      explain = '<div class="explain"><span class="why">' + (ok ? 'Correct.' : 'Not quite.') + '</span> ' +
        esc(q.explanation) + '<div class="ref">Find it in the book: <strong>' + esc(q.bookRef) + '</strong></div></div>';
    }
    return '<div class="q' + (marked ? (ok ? ' correct' : ' wrong') : '') + '">' +
      '<p class="qq">Q' + (qi+1) + '. ' + esc(q.question) + '</p>' +
      '<div class="qmeta">' + (q.type === 'multi' ? 'Select all that apply' : 'Select one') + '</div>' +
      opts + explain + '</div>';
  }).join('');

  var banner = '';
  if(cs.checked){
    var g = gradeChapter(ch, answers);
    banner = '<div class="score-banner"><div class="big">' + g.pct + '%</div>' +
      '<div><strong>' + g.correct + ' / ' + g.total + ' correct</strong>' +
      '<div class="sub">Best score: ' + cs.best + '% · Attempts: ' + cs.attempts +
      (allChaptersDone(state) ? ' · Capstone unlocked' : '') + '</div></div></div>';
  }
  var controls = cs.checked
    ? '<div class="row"><button class="btn ghost" id="retake">Retake quiz</button>' +
      '<a class="btn" href="#/chapter/' + (n < TOTAL ? n+1 : 1) + '">' + (n < TOTAL ? 'Next chapter' : 'Back to start') + ' →</a></div>'
    : '<button class="btn" id="check">Check answers</button>';

  app.innerHTML = '<p><a href="#/">← All chapters</a></p>' + summary +
    '<h2>Quiz — ' + ch.questions.length + ' questions</h2>' + quiz + banner + controls;

  if(!cs.checked){
    app.querySelectorAll('input[name^="q_"]').forEach(function(inp){
      inp.addEventListener('change', function(){
        var id = inp.name.slice(2);
        var vals = [];
        app.querySelectorAll('input[name="q_' + id + '"]:checked').forEach(function(c){ vals.push(parseInt(c.value,10)); });
        chapterState(n).answers[id] = vals;
        persist();
      });
    });
    document.getElementById('check').addEventListener('click', function(){
      var cst = chapterState(n);
      var g = gradeChapter(ch, cst.answers);
      cst.checked = true;
      cst.attempts = (cst.attempts || 0) + 1;
      if(g.pct > (cst.best || 0)) cst.best = g.pct;
      persist();
      renderChapter(app, n);
      toast('Score saved: ' + g.pct + '%');
    });
  }else{
    document.getElementById('retake').addEventListener('click', function(){
      var cst = chapterState(n);
      cst.answers = {}; cst.checked = false;
      persist();
      renderChapter(app, n);
    });
  }
}

/* ---------------- capstone list ---------------- */
function renderCapstone(app){
  if(!CONTENT.capstone){
    app.innerHTML = '<div class="err">Capstone content is missing (<code>content/capstone.json</code>).</div><p><a href="#/">Back home</a></p>';
    return;
  }
  var html = '<h1>Capstone interviews</h1>' +
    '<p class="lede">Five spoken questions per case, like a real interview. Each question is read aloud; you answer by voice. When you finish, your answers are graded 1–5 against a rubric.</p>';
  if(!allChaptersDone(state)){
    var miss = missingChapters(state, CONTENT.chapters);
    html += '<div class="lock"><div><strong>🔒 Locked.</strong> Complete all 12 chapter quizzes to unlock the capstone.<br>' +
      '<span style="color:var(--muted);font-size:14px">Still to do: ' +
      miss.map(function(ch){ return 'Ch. ' + ch.chapter + ' ' + esc(ch.title); }).join(' · ') + '</span></div></div>';
  }
  var locked = !allChaptersDone(state);
  CONTENT.capstone.cases.forEach(function(c, i){
    var attempts = state.capstone.attempts.filter(function(a){ return a.caseId === c.id; });
    var hist = attempts.length ? attempts.slice(-3).reverse().map(function(a){
      return '<div class="attempt"><span class="stars">' + a.rating + '/5 ' + esc(RATING_LABELS[a.rating]||'') + '</span> · ' +
        esc(a.date.slice(0,10)) + (a.method === 'self' ? ' · self-graded' : '') + '</div>';
    }).join('') : '';
    html += '<a class="chapter-row case-card" ' + (locked ? 'aria-disabled="true" style="opacity:.55;pointer-events:none"' : 'href="#/interview/' + c.id + '') + '">' +
      '<span class="num">' + (i+1) + '</span>' +
      '<span class="meta"><h3>' + esc(c.title) + '</h3>' +
      '<span class="sub">' + esc(c.description) + '</span>' + hist + '</span>' +
      '<span class="badge">' + (locked ? '🔒' : (attempts.length ? 'Best ' + Math.max.apply(null, attempts.map(function(a){return a.rating;})) + '/5' : 'Start →')) + '</span></a>';
  });
  app.innerHTML = html;
}

/* ---------------- interview ---------------- */
function speak(text){
  try{
    if(typeof speechSynthesis === 'undefined') return false;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    speechSynthesis.speak(u);
    return true;
  }catch(e){ return false; }
}

function renderInterview(app, caseId){
  var c = getCase(caseId);
  if(!c){
    app.innerHTML = '<div class="err">Unknown case.</div><p><a href="#/capstone">Back to capstone</a></p>';
    return;
  }
  if(!allChaptersDone(state)){
    app.innerHTML = '<div class="err">Finish all 12 chapter quizzes to unlock the capstone.</div><p><a href="#/capstone">Back</a></p>';
    return;
  }
  IV = { caseId:caseId, qi:0, transcripts:c.questions.map(function(){ return ''; }),
         recording:false, mr:null, chunks:[], stream:null, recog:null, liveTranscript:'',
         actx:null, an:null, timerH:null, rafH:null, t0:0, blob:null };

  app.innerHTML =
    '<p><a href="#/capstone">← All cases</a></p>' +
    '<h1>' + esc(c.title) + '</h1>' +
    '<div class="scenario"><strong>Interviewer:</strong> ' + esc(c.scenario) + '</div>' +
    '<div id="istage"></div>';
  renderQStage(app, c);
}

function renderQStage(app, c){
  var st = document.getElementById('istage');
  var i = IV.qi, q = c.questions[i];
  var canSpeak = (typeof speechSynthesis !== 'undefined');
  st.innerHTML =
    '<div class="card"><p class="qmeta">Question ' + (i+1) + ' of ' + c.questions.length + '</p>' +
    '<p class="interview-q">' + esc(q.question) + '</p>' +
    '<div class="row" style="margin-top:10px">' +
    (canSpeak ? '<button class="btn ghost small" id="listen">🔊 Listen</button>' : '') +
    '</div></div>' +
    '<div class="card"><h3 style="margin-top:0">Your answer</h3>' +
    '<canvas id="wave"></canvas>' +
    '<div class="rec-controls">' +
    '<button class="rec-btn" id="recbtn">Record</button>' +
    '<span class="timer" id="timer">00:00</span>' +
    '<span style="color:var(--muted);font-size:13px" id="recnote">Tap Record and answer out loud.</span>' +
    '</div>' +
    '<div class="field"><label for="transcript">Transcript (edit if needed)</label>' +
    '<textarea class="transcript" id="transcript" placeholder="Your transcribed answer will appear here. You can also type your answer instead of recording."></textarea></div>' +
    '<div class="row"><span class="spacer"></span>' +
    (i > 0 ? '<button class="btn ghost" id="backq">← Back</button>' : '') +
    '<button class="btn" id="nextq" disabled>' + (i === c.questions.length-1 ? 'Finish → grade' : 'Next question →') + '</button></div>' +
    '</div>';

  var listenBtn = document.getElementById('listen');
  if(listenBtn) listenBtn.addEventListener('click', function(){ speak(q.question); });
  if(canSpeak) speak(q.question); // auto-ask aloud like an interviewer

  var ta = document.getElementById('transcript');
  if(IV.transcripts[i]) ta.value = IV.transcripts[i];
  ta.addEventListener('input', function(){
    IV.transcripts[i] = ta.value;
    document.getElementById('nextq').disabled = !ta.value.trim();
  });
  if(ta.value.trim()) document.getElementById('nextq').disabled = false;

  document.getElementById('recbtn').addEventListener('click', function(){
    if(IV.recording) stopRecording(app, c);
    else startRecording(app, c);
  });
  var back = document.getElementById('backq');
  if(back) back.addEventListener('click', function(){
    IV.transcripts[i] = ta.value; IV.qi--; renderQStage(app, c);
  });
  document.getElementById('nextq').addEventListener('click', function(){
    IV.transcripts[i] = ta.value;
    if(i === c.questions.length-1) renderGradeStage(app, c);
    else { IV.qi++; renderQStage(app, c); }
  });
}

function pickMime(){
  if(typeof MediaRecorder === 'undefined') return '';
  var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for(var i=0;i<cands.length;i++){
    try{ if(MediaRecorder.isTypeSupported(cands[i])) return cands[i]; }catch(e){}
  }
  return '';
}

async function startRecording(app, c){
  var note = document.getElementById('recnote');
  try{
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no-mic-api');
    var stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    IV.stream = stream;
    var mime = pickMime();
    var mr = new MediaRecorder(stream, mime ? { mimeType:mime } : undefined);
    IV.mr = mr; IV.chunks = []; IV.liveTranscript = '';
    mr.ondataavailable = function(e){ if(e.data && e.data.size) IV.chunks.push(e.data); };
    mr.onstop = function(){
      try{ stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){}
      stopTimer(); stopWave();
      var blob = new Blob(IV.chunks, { type: mr.mimeType || 'audio/webm' });
      IV.blob = blob; IV.recording = false;
      onRecordingDone(app, c, blob);
    };
    // live transcription fallback path
    if(state.settings.transcription === 'browser'){
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if(SR){
        try{
          var recog = new SR();
          recog.continuous = true; recog.interimResults = true;
          recog.onresult = function(e){
            var t = '';
            for(var i=0;i<e.results.length;i++) t += e.results[i][0].transcript;
            IV.liveTranscript = t;
          };
          recog.start(); IV.recog = recog;
        }catch(e){ /* fall through to whisper/manual */ }
      }
    }
    startWave();
    mr.start();
    IV.recording = true; IV.t0 = Date.now(); startTimer();
    var btn = document.getElementById('recbtn');
    btn.textContent = 'Stop'; btn.classList.add('recording');
    if(note) note.textContent = 'Recording… tap Stop when you are done.';
  }catch(e){
    if(note) note.textContent = 'Microphone unavailable (' + (e && e.name ? e.name : 'error') + '). You can type your answer below instead.';
    toast('Mic unavailable — type your answer instead');
  }
}

function stopRecording(app, c){
  try{ if(IV.recog) IV.recog.stop(); }catch(e){}
  try{ if(IV.mr && IV.mr.state !== 'inactive') IV.mr.stop(); }
  catch(e){ // couldn't stop cleanly; just finalize UI
    IV.recording = false; stopTimer(); stopWave();
    var btn = document.getElementById('recbtn');
    if(btn){ btn.textContent = 'Record'; btn.classList.remove('recording'); }
  }
}

async function onRecordingDone(app, c, blob){
  var btn = document.getElementById('recbtn');
  if(btn){ btn.textContent = 'Record'; btn.classList.remove('recording'); }
  var note = document.getElementById('recnote');
  var ta = document.getElementById('transcript');
  try{
    var text = await transcribe(blob);
    if(ta){ ta.value = text; ta.dispatchEvent(new Event('input', {bubbles:true})); }
    if(note) note.textContent = 'Answer recorded — transcription ready. Edit it if needed, then continue.';
    toast('Transcription ready');
  }catch(err){
    if(note) note.textContent = 'Transcription failed: ' + err.message + '. You can type your answer below instead.';
    toast('Transcription failed');
  }
}

async function transcribe(blob){
  if(state.settings.transcription === 'browser'){
    if(IV.liveTranscript) return IV.liveTranscript;
    throw new Error('browser speech recognition produced no text');
  }
  var key = (state.settings.apiKey || '').trim();
  if(!key){
    var err = new Error('No API key set. Add one in Settings, switch to browser speech recognition, or type your answer.');
    err.code = 'no-key';
    throw err;
  }
  var req = whisperRequest(blob, key);
  var res = await fetch(req.url, { method:'POST', headers:req.headers, body:req.body });
  if(!res.ok){
    var t = '';
    try{ t = await res.text(); }catch(e){}
    throw new Error('Whisper API error ' + res.status + ': ' + t.slice(0, 200));
  }
  var j = await res.json();
  return j.text || '';
}

/* waveform: analyser-driven, with animated fallback */
function waveCanvas(){
  var cv = document.getElementById('wave');
  if(!cv) return null;
  var dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = 64 * dpr;
  return { cv:cv, ctx:cv.getContext('2d'), dpr:dpr };
}
function drawBars(w, vals){
  var ctx = w.ctx, W = w.cv.width, H = w.cv.height;
  ctx.clearRect(0, 0, W, H);
  var n = vals.length, bw = W / n;
  ctx.fillStyle = '#cf2e2e';
  for(var i=0;i<n;i++){
    var h = Math.max(2, vals[i] * H);
    ctx.fillRect(i*bw + 1, (H-h)/2, bw - 2, h);
  }
}
function startWave(){
  var w = waveCanvas(); if(!w) return;
  try{
    var AC = window.AudioContext || window.webkitAudioContext;
    if(!AC || !IV.stream) throw new Error('no-ctx');
    IV.actx = new AC();
    var src = IV.actx.createMediaStreamSource(IV.stream);
    IV.an = IV.actx.createAnalyser(); IV.an.fftSize = 256;
    src.connect(IV.an);
    var data = new Uint8Array(IV.an.frequencyBinCount);
    var tick = function(){
      if(!IV || !IV.recording) return;
      IV.an.getByteFrequencyData(data);
      var vals = [];
      for(var i=0;i<48;i++) vals.push(data[Math.floor(i*data.length/48)]/255);
      drawBars(w, vals);
      IV.rafH = requestAnimationFrame(tick);
    };
    tick();
  }catch(e){ fakeWave(w); }
}
function fakeWave(w){
  var t = 0;
  var tick = function(){
    if(!IV || !IV.recording) return;
    t += 0.25;
    var vals = [];
    for(var i=0;i<48;i++) vals.push(0.15 + 0.5*Math.abs(Math.sin(t + i*0.45)) * Math.random());
    drawBars(w, vals);
    IV.rafH = requestAnimationFrame(tick);
  };
  tick();
}
function stopWave(){ if(IV && IV.rafH) cancelAnimationFrame(IV.rafH); try{ if(IV && IV.actx) IV.actx.close(); }catch(e){} }
function startTimer(){
  stopTimerEl();
  IV.t0 = Date.now();
  IV.timerH = setInterval(function(){
    var el = document.getElementById('timer'); if(!el) return;
    var s = Math.floor((Date.now() - IV.t0)/1000);
    el.textContent = String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
  }, 500);
}
function stopTimer(){ stopTimerEl(); }
function stopTimerEl(){ if(IV && IV.timerH){ clearInterval(IV.timerH); IV.timerH = null; } }

/* ---------------- grading stage ---------------- */
function copyText(t){
  if(navigator.clipboard && navigator.clipboard.writeText){
    return navigator.clipboard.writeText(t);
  }
  return new Promise(function(res, rej){
    try{
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if(ok) res(); else rej(new Error('copy failed'));
    }catch(e){ rej(e); }
  });
}

function renderGradeStage(app, c){
  var key = (state.settings.apiKey || '').trim();
  var qa = c.questions.map(function(q, i){
    return { question:q.question, rubric:q.rubric, transcript:(IV.transcripts[i]||'').trim() };
  });
  var answered = qa.filter(function(x){ return x.transcript.length > 0; }).length;

  var html = '<p><a href="#/capstone">← All cases</a></p>' +
    '<h1>' + esc(c.title) + ' — results</h1>' +
    '<p class="lede">' + answered + ' of ' + qa.length + ' questions answered.</p>' +
    '<div class="row" style="margin-bottom:12px"><button class="btn ghost" id="exportqa">Copy answers for Hiro to grade</button>' +
    '<span id="expmsg" style="font-size:13px;color:var(--muted)"></span></div>' +
    '<div id="gstage"></div>';
  app.innerHTML = html;
  var st = document.getElementById('gstage');

  document.getElementById('exportqa').addEventListener('click', function(){
    var msg = document.getElementById('expmsg');
    var text = 'DDIA capstone — please grade my answers\nCase: ' + c.title + ' (' + c.id + ')\n\n' +
      qa.map(function(x, i){
        return 'Q' + (i+1) + '. ' + x.question + '\nMy answer: ' + (x.transcript || '(no answer recorded)') + '\n';
      }).join('\n') +
      '\nGrade the whole case 1-5 against the case rubric (5 exceptional, 4 pass, 3 maybe, 2 needs work, 1 fail), with written feedback and concepts I missed.';
    copyText(text).then(function(){
      msg.textContent = 'Copied — paste it into your chat with Hiro.';
      toast('Answers copied');
    }, function(){
      msg.textContent = 'Copy failed in this browser — sorry.';
      toast('Copy failed');
    });
  });

  if(key){
    st.innerHTML = '<div class="card"><p>Grading with the AI interviewer against the case rubric…</p></div>';
    (async function(){
      try{
        var req = gradingRequest(c, qa, key);
        var res = await fetch(req.url, { method:'POST', headers:req.headers, body:req.body });
        if(!res.ok){
          var t = ''; try{ t = await res.text(); }catch(e){}
          throw new Error('Grading API error ' + res.status + ': ' + t.slice(0, 200));
        }
        var g = parseGradingResult(await res.text());
        saveAttempt(c.id, {
          rating:g.rating, feedback:g.feedback, missedConcepts:g.missedConcepts,
          method:'ai', transcripts:qa.map(function(x){ return x.transcript; })
        });
        st.innerHTML = resultCard(g, null);
      }catch(err){
        st.innerHTML = '<div class="err"><strong>Grading failed:</strong> ' + esc(err.message) + '</div>' +
          '<div class="row"><button class="btn ghost" id="retrygrade">Retry</button>' +
          '<button class="btn" id="selfgrade">Grade myself instead</button></div>';
        document.getElementById('retrygrade').addEventListener('click', function(){ renderGradeStage(app, c); });
        document.getElementById('selfgrade').addEventListener('click', function(){ renderSelfGrade(st, c, qa); });
      }
    })();
  }else{
    st.innerHTML = '<div class="card tint"><strong>No API key set.</strong> ' +
      'Add one in <a href="#/settings">Settings</a> for AI grading, or grade yourself against the rubric below.</div>' +
      '<div id="selfwrap"></div>';
    renderSelfGrade(document.getElementById('selfwrap'), c, qa);
  }
}

function saveAttempt(caseId, attempt){
  attempt.caseId = caseId;
  attempt.date = new Date().toISOString();
  state.capstone.attempts.push(attempt);
  persist();
}

function resultCard(g, selfNote){
  var missed = (g.missedConcepts && g.missedConcepts.length)
    ? '<h3>Concepts to revisit</h3><ul class="takeaways">' +
      g.missedConcepts.map(function(m){ return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>'
    : '';
  return '<div class="score-banner"><div class="big">' + g.rating + '<span style="font-size:18px">/5</span></div>' +
    '<div><div class="rating-lbl">' + esc(RATING_LABELS[g.rating] || '') + '</div>' +
    '<div class="sub">5 exceptional · 4 pass · 3 maybe · 2 needs work · 1 fail' +
    (selfNote ? ' · ' + esc(selfNote) : '') + '</div></div></div>' +
    '<div class="feedback"><h3 style="margin-top:0">Feedback</h3><p>' + esc(g.feedback) + '</p>' + missed + '</div>' +
    '<div class="row"><a class="btn ghost" href="#/capstone">Back to cases</a>' +
    '<a class="btn" href="#/interview/' + esc(IV ? IV.caseId : '') + '">Retry this case</a></div>';
}

function renderSelfGrade(mount, c, qa){
  var all = [];
  qa.forEach(function(x, qi){
    x.rubric.keyPoints.forEach(function(kp, ki){
      all.push({ qi:qi, ki:ki, point:kp.point, chapters:kp.chapters });
    });
  });
  mount.innerHTML = '<div class="card"><h3 style="margin-top:0">Self-grade checklist</h3>' +
    '<p class="lede">Tick every rubric point your spoken answer actually hit. The app suggests a rating — you make the final call.</p>' +
    '<div id="sglist">' + all.map(function(p, i){
      return '<label class="checkline"><input type="checkbox" data-sg="' + i + '"><span>' +
        '<strong>Q' + (p.qi+1) + '.</strong> ' + esc(p.point) +
        ' <span style="color:var(--muted)">(ch. ' + p.chapters.join(', ') + ')</span></span></label>';
    }).join('') + '</div>' +
    '<p><strong>Suggested rating: <span id="sgsuggest">1/5</span></strong> <span style="color:var(--muted);font-size:13px">(based on points hit)</span></p>' +
    '<div class="field"><label>Your final rating</label><div class="seg" id="sgrating">' +
    [1,2,3,4,5].map(function(r){ return '<button data-r="' + r + '"' + (r===1?' class="on"':'') + '>' + r + '</button>'; }).join('') +
    '</div> <span style="color:var(--muted);font-size:13px" id="sgratinglbl">fail</span></div>' +
    '<div class="field"><label for="sgfeedback">Notes to yourself (optional)</label>' +
    '<textarea class="transcript" id="sgfeedback" placeholder="What will you do differently next time?"></textarea></div>' +
    '<button class="btn" id="sgsave">Save self-grade</button></div>';

  var boxes = mount.querySelectorAll('[data-sg]');
  var chosen = 1;
  function refresh(){
    var hit = 0;
    boxes.forEach(function(b){ if(b.checked) hit++; });
    var s = suggestSelfRating(hit, all.length);
    document.getElementById('sgsuggest').textContent = s + '/5 ' + RATING_LABELS[s];
    return hit;
  }
  boxes.forEach(function(b){ b.addEventListener('change', refresh); });
  mount.querySelectorAll('#sgrating button').forEach(function(b){
    b.addEventListener('click', function(){
      mount.querySelectorAll('#sgrating button').forEach(function(x){ x.classList.remove('on'); });
      b.classList.add('on');
      chosen = parseInt(b.getAttribute('data-r'), 10);
      document.getElementById('sgratinglbl').textContent = RATING_LABELS[chosen];
    });
  });
  refresh();
  document.getElementById('sgsave').addEventListener('click', function(){
    var hitPts = [], missPts = [];
    boxes.forEach(function(b, i){
      (b.checked ? hitPts : missPts).push(all[i].point);
    });
    var fb = document.getElementById('sgfeedback').value.trim() ||
      'Self-graded: hit ' + hitPts.length + ' of ' + all.length + ' rubric points.';
    saveAttempt(c.id, {
      rating:chosen, feedback:fb, missedConcepts:missPts,
      method:'self', transcripts:qa.map(function(x){ return x.transcript; })
    });
    mount.innerHTML = resultCard({ rating:chosen, feedback:fb, missedConcepts:missPts }, 'self-graded');
    toast('Attempt saved');
  });
}

/* ---------------- settings ---------------- */
function renderSettings(app){
  var s = state.settings;
  app.innerHTML = '<h1>Settings</h1>' +
    '<div class="card"><div class="field"><label for="apikey">OpenAI API key</label>' +
    '<input type="password" id="apikey" value="" placeholder="' + (s.apiKey ? 'Saved ✓ — type a new key to replace it' : 'sk-…') + '" autocomplete="off">' +
    (s.apiKey ? '<div class="hint" style="margin-top:6px">A key is saved in this browser ✓ (the value itself is never shown)</div>' : '') +
    '<div class="hint">Stored <strong>only</strong> in this browser\'s local storage. It is sent only to <code>api.openai.com</code> — for Whisper transcription and answer grading. Nothing else ever sees it. One key covers both jobs.</div></div>' +
    '<div class="row"><button class="btn small" id="savkey">Save key</button>' +
    '<button class="btn ghost small" id="testkey">Test connection</button>' +
    (s.apiKey ? '<button class="btn ghost small" id="rmkey">Remove key</button>' : '') +
    '<span id="keymsg" style="font-size:13px;color:var(--muted)"></span></div></div>' +
    '<div class="card"><div class="field"><label>Transcription method</label>' +
    '<div class="seg" id="trseg">' +
    '<button data-t="whisper"' + (s.transcription === 'whisper' ? ' class="on"' : '') + '>Whisper API</button>' +
    '<button data-t="browser"' + (s.transcription === 'browser' ? ' class="on"' : '') + '>Browser speech</button></div>' +
    '<div class="hint">Whisper (needs the API key above) is the most accurate and works in every browser, including Safari on iPhone. ' +
    'Browser speech is free and needs no key, but is less accurate and unreliable on Safari/iOS. ' +
    'With no key and no working browser speech, you can always type your answer instead — and use the self-grade checklist.</div></div></div>' +
    '<div class="card"><h3 style="margin-top:0">Progress</h3>' +
    '<div class="row"><button class="btn ghost small" id="wipe">Clear all progress</button></div>' +
    '<div class="hint">Removes quiz answers, scores and capstone attempts from this browser. Content files are untouched.</div></div>';

  document.getElementById('savkey').addEventListener('click', function(){
    var typed = document.getElementById('apikey').value.trim();
    if(typed){ state.settings.apiKey = typed; persist(); renderSettings(app); }
    document.getElementById('keymsg').textContent = typed ? 'Saved in this browser only.' : 'Key unchanged — type a new key to replace it.';
    toast(typed ? 'API key saved' : 'Key unchanged');
  });
  var rmkey = document.getElementById('rmkey');
  if(rmkey) rmkey.addEventListener('click', function(){
    state.settings.apiKey = ''; persist(); renderSettings(app);
    toast('API key removed');
  });
  document.getElementById('testkey').addEventListener('click', async function(){
    var key = document.getElementById('apikey').value.trim() || state.settings.apiKey;
    var msg = document.getElementById('keymsg');
    if(!key){ msg.textContent = 'Enter a key first.'; return; }
    msg.textContent = 'Testing…';
    try{
      var r = await fetch('https://api.openai.com/v1/models', { headers:{'Authorization':'Bearer ' + key} });
      msg.textContent = r.ok ? 'Key works.' : 'Key rejected (HTTP ' + r.status + ').';
    }catch(e){ msg.textContent = 'Network error: ' + e.message; }
  });
  document.querySelectorAll('#trseg button').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('#trseg button').forEach(function(x){ x.classList.remove('on'); });
      b.classList.add('on');
      state.settings.transcription = b.getAttribute('data-t');
      persist();
      toast('Transcription: ' + state.settings.transcription);
    });
  });
  document.getElementById('wipe').addEventListener('click', function(){
    if(confirm('Clear all quiz progress and capstone attempts?')){
      state = defaultState(); persist(); toast('Progress cleared'); renderSettings(app);
    }
  });
}

/* ---------------- init ---------------- */
async function init(){
  CONTENT = await loadContent();
  window.addEventListener('hashchange', router);
  router();
}
if(typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById){
  init();
}

/* test + reuse exports */
var _root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
_root.DDIA = {
  scoreQuestion:scoreQuestion, gradeChapter:gradeChapter,
  chapterDone:chapterDone, allChaptersDone:allChaptersDone, missingChapters:missingChapters,
  suggestSelfRating:suggestSelfRating,
  buildGradingMessages:buildGradingMessages, gradingRequest:gradingRequest,
  parseGradingResult:parseGradingResult, whisperRequest:whisperRequest,
  loadState:loadState, saveState:saveState, defaultState:defaultState,
  STORE_KEY:STORE_KEY, RATING_LABELS:RATING_LABELS, GRADE_MODEL:GRADE_MODEL
};
})();
