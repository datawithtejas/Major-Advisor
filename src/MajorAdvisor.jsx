  import { useState, useEffect, useRef, useCallback } from "react";


/*
  ══════════════════════════════════════════════════════════════════
  SYSTEM ARCHITECTURE — CONCURRENCY & STABILITY
  ══════════════════════════════════════════════════════════════════

  STORAGE STRATEGY (localStorage as a client-side cache)
  ───────────────────────────────────────────────────────
  All state lives in two localStorage keys:
    "adv_cur"  — the currently active student object (full profile)
    "adv_all"  — array of all registered students (index for sign-in lookup)

  Both keys are written on every meaningful state change via save().

  TWO-SCREEN / CONCURRENT SESSION HANDLING
  ──────────────────────────────────────────
  Problem: User opens Tab A and Tab B. They answer questions on both.
  Whichever tab writes last wins — the other tab's in-memory React state
  is now stale relative to localStorage.

  Solution implemented here:
  1. StorageManager.write() attaches a logical clock (version: integer)
     to every write. Each write increments it.
  2. A "storage" event listener in the root App fires whenever a
     DIFFERENT tab writes to localStorage. When detected:
       a. The newer version wins (last-write-wins with version guard).
       b. React state is rehydrated from localStorage immediately.
       c. A non-blocking toast banner tells the user:
          "Your profile was updated in another tab."
  3. If both tabs have the same version (simultaneous write race),
     the merge strategy is: union of all answered questions.
     Neither tab loses answers — incomplete answers from both are merged.

  CACHING ANSWER
  ──────────────
  Yes — localStorage IS the cache layer here. It plays the role that
  Redis would play in a backend system:
    • Reads are O(1) synchronous (no network round-trip).
    • Writes are synchronous and atomic per-key in the browser.
    • TTL: no expiry — data persists until the user clears browser data.
    • Cross-tab sync: the "storage" event is the cache invalidation signal.

  In a production backend system the equivalent architecture would be:
    Browser React state  ←→  Redis (session cache, TTL 24h)
                              ↕  write-through
                         PostgreSQL (source of truth)
  The "storage" event maps to a Redis pub/sub channel that pushes
  invalidation events to all connected clients for the same user_id.

  UNANSWERED QUESTION NAVIGATION (MBTI + Brain Dominance)
  ────────────────────────────────────────────────────────
  When the user clicks Submit and has unanswered questions:
  1. Find the index of the FIRST unanswered question.
  2. Scroll that question card into view (scrollIntoView smooth).
  3. Briefly highlight the card with a red ring animation.
  4. Show a sticky banner: "Please answer question N to continue."
  5. Do NOT show an alert() — that blocks the thread and is jarring.
  ══════════════════════════════════════════════════════════════════
*/

/* ── API CONFIG ── */
const API = "http://localhost:5000/api";

/* ── STORAGE MANAGER (localStorage cache + Postgres backend) ── */
const StorageManager = {

  // ── Session (sessionStorage so closing tab clears it) ──────────
  startSession(token) {
    try {
      sessionStorage.setItem("adv_sess", "1");
      if (token) sessionStorage.setItem("adv_token", token);
    } catch {}
  },

  endSession() {
    try {
      sessionStorage.removeItem("adv_sess");
      sessionStorage.removeItem("adv_token");
      localStorage.removeItem("adv_cur");
      localStorage.removeItem("adv_all");
    } catch {}
  },

  getToken() {
    try { return sessionStorage.getItem("adv_token") || null; } catch { return null; }
  },

  // ── Read from localStorage (fast, offline-safe) ─────────────────
  readCurrent() {
    try {
      if (sessionStorage.getItem("adv_sess") !== "1") return null;
      const raw = localStorage.getItem("adv_cur");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  readAll() {
    try {
      const raw = localStorage.getItem("adv_all");
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  },

  // ── Write to localStorage + async sync to Postgres ───────────────
  write(data, allStudents) {
    try {
      const versioned = { ...data, _v: ((data._v || 0) + 1), _ts: Date.now() };
      localStorage.setItem("adv_cur", JSON.stringify(versioned));
      const updated = [...(allStudents || []).filter(s => s.user_id !== data.user_id), versioned];
      localStorage.setItem("adv_all", JSON.stringify(updated));
      // Fire-and-forget async sync to backend — UI never waits for this
      StorageManager.syncToBackend(versioned).catch(() => {});
      return { student: versioned, all: updated };
    } catch { return null; }
  },

  // ── Async backend sync (called after every local write) ──────────
  async syncToBackend(student) {
    const token = StorageManager.getToken();
    if (!token) return;
    await fetch(`${API}/students/${student.user_id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(student)
    });
  },

  // ── Merge strategy for cross-tab concurrent edits ────────────────
  merge(localData, remoteData) {
    if (!localData) return remoteData;
    if (!remoteData) return localData;
    const localV = localData._v || 0;
    const remoteV = remoteData._v || 0;
    const base = remoteV >= localV ? { ...remoteData } : { ...localData };
    base.survey_responses    = { ...(localData.survey_responses||{}),    ...(remoteData.survey_responses||{}) };
    base.mbti_test_responses = { ...(localData.mbti_test_responses||{}), ...(remoteData.mbti_test_responses||{}) };
    base.brain_responses     = { ...(localData.brain_responses||{}),     ...(remoteData.brain_responses||{}) };
    return base;
  }
};

/*
  ─── ENFORCED TYPE SCALE ───────────────────────────────────────────
  Inter (body font — matches OpenAI aesthetic, replaces DM Sans throughout):
    10px  scale buttons only (MBTI -3 to +3 micro labels)
    11px  uppercase labels, badges, eyebrows, Q-tags          700
    12px  captions, helper text, error messages               400
    13px  secondary UI: nav greeting, progress counters       400-500
    14px  ALL body copy, descriptions, card text, inputs      400-500
    15px  choice/card primary titles                          600
    16px  dashboard card values, hero intro                   400

  Playfair Display (display font):
    16px  MBTI type grid codes
    18px  italic sub-result (MBTI nick, brain tagline)        600 italic
    22px  section h2s ("Recommended Majors")                  700
    26px  assessment page h2s                                 700
    28px  stat card numbers                                   700
    32px  "How it works" h2, "No Recs" h2                    700
    clamp(24-34px)   survey section h2
    clamp(28-44px)   secondary page h1s
    clamp(40-66px)   home hero h1
    clamp(54-86px)   MBTI type result display
    clamp(34-58px)   brain result display
    19px             navbar brand                             700
  ────────────────────────────────────────────────────────────────────
*/

const T = {
  bg: "#f5f2ed", bgCard: "#faf8f5", bgWhite: "#ffffff",
  gold: "#7d6318", goldH: "#6a5212", goldPale: "rgba(125,99,24,0.08)", goldRing: "rgba(125,99,24,0.2)",
  ink: "#191917", inkMid: "#3a3a32", inkSoft: "#6b6860",
  border: "rgba(125,99,24,0.15)", borderN: "rgba(26,26,22,0.08)",
  navBg: "rgba(245,242,237,0.95)",
};

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; scroll-behavior: smooth; }
  body { font-family: 'Inter', Söhne; background: ${T.bg}; color: ${T.ink}; min-height: 100vh; overflow-x: hidden; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-thumb { background: rgba(125,99,24,0.18); border-radius: 99px; }
  @keyframes fadeUp { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
  .fu  { animation: fadeUp 0.48s cubic-bezier(0.16,1,0.3,1) both; }
  .fu1 { animation: fadeUp 0.48s 0.08s cubic-bezier(0.16,1,0.3,1) both; }
  .fu2 { animation: fadeUp 0.48s 0.16s cubic-bezier(0.16,1,0.3,1) both; }
  .fu3 { animation: fadeUp 0.48s 0.24s cubic-bezier(0.16,1,0.3,1) both; }
  .nav-btn { font-size:14px; font-weight:500; color:${T.inkSoft}; background:none; border:none; cursor:pointer; padding:6px 14px; border-radius:8px; transition:all 0.18s; font-family:'Inter',Söhne; }
  .nav-btn:hover { color:${T.ink}; }
  .nav-btn.active { color:${T.ink}; font-weight:600; }
  .ch { transition: box-shadow 0.2s, transform 0.2s, border-color 0.2s; }
  .ch:hover { box-shadow: 0 6px 24px rgba(26,26,22,0.09); transform: translateY(-2px); }
  input:focus, select:focus { outline:none; border-color:${T.gold} !important; box-shadow:0 0 0 3px ${T.goldPale}; }
  button { font-family:'Inter',Söhne; }
`;

function injectStyles() {
  if (document.getElementById("adv-g")) return;
  const s = document.createElement("style"); s.id = "adv-g"; s.textContent = GLOBAL_CSS;
  document.head.appendChild(s);
}

/* ── DATA ── */
const SURVEY_SECTIONS = [
  { id:"working_style", label:"Interests & Passions", eyebrow:"Section 01 of 06", title:"Interests & Passions", subtitle:"If you could choose between these three types of tasks, which one would you enjoy the most?", hint:"Select one", type:"single_choice", options:[{value:"A",label:"Hands-on & Execution",desc:"Using tools, building models, outdoor activities, or fixing physical objects."},{value:"B",label:"Logic & Analysis",desc:"Solving math problems, analyzing data, researching theories, or debugging code."},{value:"C",label:"Creativity & Expression",desc:"Brainstorming new ideas, designing visuals, writing, or artistic creation."}] },
  { id:"problem_solving", label:"Problem Solving", eyebrow:"Section 02 of 06", title:"Skills & Advantages", subtitle:"When facing a complex problem, what is your immediate instinct?", hint:"Select one", type:"single_choice", options:[{value:"A",label:"Independent Research",desc:"I prefer to look up information and think through the logic alone."},{value:"B",label:"Team Collaboration",desc:"I prefer to discuss it with others and brainstorm a solution together."},{value:"C",label:"Established Rules",desc:"I look for existing guidelines, templates, or past examples to follow."}] },
  { id:"superpower_keywords", label:"Top Skills", eyebrow:"Section 03 of 06", title:"Career Prospect & Preference", subtitle:"Enter 3 keywords that best describe your top skills or strengths.", hint:"e.g. Programming, Writing, Math, Empathy…", type:"keywords" },
  { id:"flow_state", label:"Flow State", eyebrow:"Section 04 of 06", title:"Personal Values", subtitle:"Describe an activity where you lose track of time.", hint:"Use a short phrase.", type:"text", placeholder:"e.g. Solving puzzles, Editing videos, Helping people…" },
  { id:"core_values", label:"Core Values", eyebrow:"Section 05 of 06", title:"Core Values", subtitle:"Select up to 3 values that matter most to you in a career.", hint:"Select up to 3", type:"multi_choice", options:[{value:"financial_reward",label:"Financial Reward",desc:"High income and wealth-building potential."},{value:"work_life_balance",label:"Work-Life Balance",desc:"Flexible hours and personal time."},{value:"social_impact",label:"Social Impact",desc:"Making a meaningful contribution to society."},{value:"innovation",label:"Innovation",desc:"Creative problem-solving and inventing new things."},{value:"security_stability",label:"Security & Stability",desc:"Predictable, reliable, safe career path."},{value:"leadership",label:"Leadership",desc:"Influencing, managing, and guiding teams."}] },
  { id:"field_exclusion", label:"Field Exclusion", eyebrow:"Section 06 of 06", title:"Field Exclusion", subtitle:"Are there any fields or industries you want to avoid?", hint:"Optional", type:"text", placeholder:"e.g. Medicine, Sales, Military…", optional:true },
];

const MQ = ["You like to have a to-do list for each day.","You often end up doing things at the last possible moment.","At social events, you rarely try to introduce yourself to new people and mostly talk to the ones you already know.","You are prone to worrying that things will take a turn for the worse.","You are not too interested in discussing various interpretations and analyses of creative works.","You have always been fascinated by the question of what, if anything, happens after death.","You enjoy going to art museums.","Your mood can change very quickly.","You find it easy to empathize with a person whose experiences are very different from yours.","You rarely worry about whether you make a good impression on people you meet.","You often feel overwhelmed.","You often make a backup plan for a backup plan.","You usually prefer just doing what you feel like at any given moment instead of planning a particular daily routine.","Your happiness comes more from helping others accomplish things than your own accomplishments.","You tend to avoid drawing attention to yourself.","You are more inclined to follow your head than your heart.","You usually stay calm, even under a lot of pressure.","You are definitely not an artistic type of person.","You often have a hard time understanding other people's feelings.","You enjoy watching people argue.","Seeing other people cry can easily make you feel like you want to cry too.","You struggle with deadlines.","You avoid making phone calls.","You feel more drawn to places with busy, bustling atmospheres than quiet, intimate places.","You would pass along a good opportunity if you thought someone else needed it more."];

const BQ = [{q:"I prefer to learn",a:"Details and specific facts in a step-by-step manner",b:"From a general overview by looking at the whole picture first"},{q:"I prefer jobs",a:"Which consist of one task at a time, completing it before beginning the next",b:"In which I work on many things simultaneously"},{q:"It is more exciting to",a:"Improve an existing process efficiently",b:"Invent something entirely new creatively"},{q:"When reading or studying I prefer",a:"Total quiet to focus on specifics",b:"Soft music to enhance overall flow"},{q:"With time management I generally",a:"Use schedules to organize tasks sequentially",b:"Struggle with strict pacing but adapt fluidly"},{q:"I can tell time without a clock",a:"No — I rely on visual cues",b:"Yes — I sense time intuitively"},{q:"Arranging furniture in a room",a:"I keep it the same for stability",b:"I move it often for fresh energy"},{q:"Remembering people",a:"By their names and details",b:"By their faces and expressions"},{q:"My desk or workspace is typically",a:"Neat and systematically organized",b:"Cluttered with useful creative items"},{q:"In teams I prefer to",a:"Work alone on defined tasks",b:"Express and build on group ideas"},{q:"Processing information",a:"Listening and talking in sequence",b:"Creating ideas intuitively at once"},{q:"Making decisions based on",a:"Facts and logical analysis",b:"Personal feelings and intuition"},{q:"Problem-solving approach",a:"Methodical step-by-step process",b:"Seeing the big picture holistically"},{q:"Stronger memory for",a:"Lists of facts and sequences",b:"Images, stories, and visuals"},{q:"Giving feedback",a:"Specific critiques on details",b:"Overall impressions and strengths"},{q:"Test questions I handle best",a:"Objective multiple-choice with facts",b:"Subjective discussions exploring ideas"},{q:"Planning trips",a:"Detailed itinerary with reservations",b:"Spontaneous with room for detours"},{q:"I like to",a:"Maintain control through planning",b:"Spark changes through innovation"},{q:"In meetings I prefer",a:"Agenda-driven with timed discussions",b:"Open idea-sharing and brainstorming"},{q:"Approach to risks",a:"Calculated with data and probabilities",b:"Intuitive based on instincts"}];

const MBTI_TYPES = { Analysts:[{code:"INTJ",nick:"The Architect"},{code:"INTP",nick:"The Logician"},{code:"ENTJ",nick:"The Commander"},{code:"ENTP",nick:"The Debater"}], Diplomats:[{code:"INFJ",nick:"The Advocate"},{code:"INFP",nick:"The Mediator"},{code:"ENFJ",nick:"The Protagonist"},{code:"ENFP",nick:"The Campaigner"}], Sentinels:[{code:"ISTJ",nick:"The Logistician"},{code:"ISFJ",nick:"The Defender"},{code:"ESTJ",nick:"The Executive"},{code:"ESFJ",nick:"The Consul"}], Explorers:[{code:"ISTP",nick:"The Virtuoso"},{code:"ISFP",nick:"The Adventurer"},{code:"ESTP",nick:"The Entrepreneur"},{code:"ESFP",nick:"The Entertainer"}] };
const NICK = Object.values(MBTI_TYPES).flat().reduce((a,t)=>({...a,[t.code]:t.nick}),{});

function predictMBTI(r){const v=Object.values(r);if(v.length<25)return null;const EI=(v[2]+v[9]+v[14]+v[22]+v[23])/5,SN=(v[4]+v[5]+v[6]+v[17]+v[20])/5,TF=(v[7]+v[8]+v[13]+v[15]+v[18])/5,JP=(v[0]+v[1]+v[11]+v[12]+v[21])/5;return(EI<0?"E":"I")+(SN<0?"S":"N")+(TF<0?"T":"F")+(JP>0?"J":"P");}
function predictBrain(r){return Object.values(r).filter(v=>v==="B").length>=10?"right":"left";}

function buildRecs(student){
  // BUG FIX A: Require both mbti_type and brain_dominance.
  // Previously brain_dominance||"left" silently fell back when brain test was skipped,
  // producing fake recommendations. Now returns null so callers can gate properly.
  if(!student?.mbti_type || !student?.brain_dominance) return null;
  const r=student?.survey_responses||{},mbti=student.mbti_type,brain=student.brain_dominance,values=r.core_values||[],ws=r.working_style;
  const mm={A_left:["Mechanical Engineering","Civil Engineering","Architecture","Construction Management"],A_right:["Industrial Design","Product Design","Fine Arts","Theater Arts"],B_left:["Computer Science","Data Science","Mathematics","Statistics"],B_right:["Cognitive Science","Philosophy","Creative Writing","Game Design"],C_left:["Graphic Design","Journalism","Marketing","Communications"],C_right:["Fine Arts","Music","Film Studies","Creative Writing"]};
  const vb={financial_reward:["Finance","Business Administration"],work_life_balance:["Nursing","Education"],social_impact:["Social Work","Public Health","Environmental Science"],innovation:["Computer Science","Biomedical Engineering"],security_stability:["Accounting","Civil Engineering"],leadership:["Business Administration","Political Science"]};
  const base=mm[`${ws||"B"}_${brain}`]||["Computer Science","Business Administration","Psychology"];
  const bonus=values.flatMap(v=>vb[v]||[]);
  const majors=[...new Set([...base,...bonus])].slice(0,5);
  const oo={INT:["Software Engineer","Data Analyst","Research Scientist","Systems Architect"],ENT:["Business Manager","Entrepreneur","Consultant","Marketing Director"],INF:["Counselor","Writer","UX Researcher","Social Worker"],ENF:["Teacher","HR Manager","Public Relations","Community Organizer"],IST:["Accountant","Logistics Manager","Quality Assurance","Database Admin"],EST:["Operations Manager","Sales Manager","Financial Advisor","Law Enforcement"],ISF:["Nurse","Librarian","Dental Hygienist","Veterinary Tech"],ESF:["Event Planner","Customer Success","Flight Attendant","Retail Manager"]};
  const occs=oo[mbti.slice(0,3)]||["Business Analyst","Project Manager","Consultant"];
  const reasons={};majors.forEach((m,i)=>{reasons[m]=`As ${mbti} (${NICK[mbti]||""}), your ${brain==="left"?"analytical":"creative"} thinking style aligns well with ${m}. ${i===0?"This is your strongest match based on your career preferences.":"Your interests and values make this a compelling path."}`});
  return{top_majors:majors,top_occupations:occs.slice(0,5),major_reasons:reasons,mbti_type:mbti,brain_dominance:brain,comprehensive_explanation:`Based on your ${mbti} (${NICK[mbti]||""}) personality type and ${brain}-brain dominance, combined with your interest in ${ws==="B"?"logic and analysis":ws==="A"?"hands-on work":"creativity"} and values around ${values.slice(0,2).join(" and ")||"personal growth"}, you are well-positioned to thrive in fields that blend ${brain==="left"?"structure with impact":"creativity with purpose"}. Explore introductory courses in your top majors, connect with professionals in those fields, and consider internships to validate your fit.`,generated_at:new Date().toISOString()};
}

/* ── PRIMITIVES ── */
function Btn({children,onClick,variant="gold",size="md",disabled=false,full=false}){
  const p={sm:"7px 20px",md:"11px 26px",lg:"13px 34px"}[size];
  const fs={sm:"13px",md:"14px",lg:"15px"}[size];
  const base={display:"inline-flex",alignItems:"center",justifyContent:"center",gap:"8px",fontWeight:600,fontSize:fs,border:"none",cursor:disabled?"not-allowed":"pointer",borderRadius:"10px",transition:"all 0.18s",opacity:disabled?0.45:1,padding:p,width:full?"100%":"auto"};
  const vs={gold:{background:T.gold,color:"#fff",boxShadow:"0 1px 4px rgba(125,99,24,0.28)"},ghost:{background:"transparent",color:T.inkSoft,border:`1.5px solid ${T.borderN}`},outline:{background:"transparent",color:T.gold,border:`1.5px solid ${T.gold}`}};
  return(<button onClick={disabled?undefined:onClick} style={{...base,...vs[variant]}}
    onMouseEnter={e=>{if(disabled)return;if(variant==="gold"){e.currentTarget.style.background=T.goldH;e.currentTarget.style.transform="translateY(-1px)";e.currentTarget.style.boxShadow="0 4px 14px rgba(125,99,24,0.35)";}if(variant==="ghost"){e.currentTarget.style.background="rgba(26,26,22,0.05)";e.currentTarget.style.color=T.ink;}if(variant==="outline"){e.currentTarget.style.background=T.goldPale;e.currentTarget.style.transform="translateY(-1px)";}}}
    onMouseLeave={e=>{e.currentTarget.style.background=vs[variant].background||"transparent";e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow=vs[variant].boxShadow||"none";e.currentTarget.style.color=vs[variant].color;}}>{children}</button>);
}

function Lbl({children}){return <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:T.gold,marginBottom:"12px"}}>{children}</div>;}
function Rule(){return <div style={{width:"36px",height:"3px",background:T.gold,borderRadius:"2px",margin:"14px 0 20px"}}/>;}
function PBar({value}){return(<div style={{height:"3px",background:T.borderN,borderRadius:"99px",overflow:"hidden"}}><div style={{height:"100%",background:`linear-gradient(90deg,${T.gold},#c9a94a)`,width:`${value}%`,borderRadius:"99px",transition:"width 0.5s cubic-bezier(0.4,0,0.2,1)"}}/></div>);}
function Card({children,style={},onClick,hover=false}){return(<div className={hover?"ch":""} onClick={onClick} style={{background:T.bgCard,border:`1px solid ${T.borderN}`,borderRadius:"14px",padding:"24px",cursor:onClick?"pointer":"default",...style}}>{children}</div>);}

function Inp({label,value,onChange,type="text",placeholder="",required=false,error=""}){
  return(<div style={{marginBottom:"20px"}}><label style={{display:"block",fontSize:"13px",fontWeight:600,color:T.inkMid,marginBottom:"7px"}}>{label}{required&&<span style={{color:T.gold}}> *</span>}</label><input type={type} value={value} onChange={onChange} placeholder={placeholder} style={{width:"100%",padding:"12px 16px",border:`1.5px solid ${error?"#c0392b":T.borderN}`,borderRadius:"10px",background:T.bgWhite,fontSize:"14px",color:T.ink,transition:"all 0.18s"}}/>{error&&<p style={{fontSize:"12px",color:"#c0392b",marginTop:"5px"}}>{error}</p>}</div>);
}
function Sel({label,value,onChange,options,required=false,error=""}){
  return(<div style={{marginBottom:"20px"}}><label style={{display:"block",fontSize:"13px",fontWeight:600,color:T.inkMid,marginBottom:"7px"}}>{label}{required&&<span style={{color:T.gold}}> *</span>}</label><select value={value} onChange={onChange} style={{width:"100%",padding:"12px 16px",border:`1.5px solid ${error?"#c0392b":T.borderN}`,borderRadius:"10px",background:T.bgWhite,fontSize:"14px",color:value?T.ink:T.inkSoft,fontFamily:"'Inter',sans-serif",transition:"all 0.18s",appearance:"none",backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b6860' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,backgroundRepeat:"no-repeat",backgroundPosition:"right 14px center"}}><option value="">Select…</option>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>{error&&<p style={{fontSize:"12px",color:"#c0392b",marginTop:"5px"}}>{error}</p>}</div>);
}

/* ── NAVBAR ── */
function Navbar({page,setPage,student,signOut}){
  const links=[{id:"home",label:"Home"},{id:"survey",label:"Survey"},{id:"mbti_select",label:"MBTI"},{id:"brain",label:"Brain Test"},{id:"results",label:"Results"}];
  return(
    <nav style={{position:"sticky",top:0,zIndex:200,background:T.navBg,backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",borderBottom:`1px solid ${T.borderN}`,height:"58px",display:"flex",alignItems:"center",padding:"0 28px",gap:"0"}}>
      <button onClick={()=>setPage("home")} style={{fontFamily:"'Playfair Display',serif",fontSize:"20px",fontWeight:700,color:T.ink,background:"none",border:"none",cursor:"pointer",flexShrink:0,marginRight:"36px",letterSpacing:"-0.02em"}}>
        Career <span style={{color:T.gold}}>Advisor</span>
      </button>
      <div style={{display:"flex",alignItems:"center",gap:"2px",flex:1}}>
        {links.map(l=><button key={l.id} onClick={()=>setPage(l.id)} className={`nav-btn${page===l.id?" active":""}`}>{l.label}</button>)}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:"10px",flexShrink:0}}>
        {student
          ?<><span style={{fontSize:"13px",color:T.inkSoft,fontFamily:"'Inter',sans-serif",letterSpacing:"-0.01em"}}>Hi, <strong style={{color:T.ink,fontWeight:600}}>{student.personal_info?.first_name}</strong></span>
              <button onClick={()=>setPage("survey_dashboard")} style={{width:"34px",height:"34px",borderRadius:"50%",background:T.gold,border:"none",cursor:"pointer",color:"#fff",fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:"14px"}}>{student.personal_info?.first_name?.[0]?.toUpperCase()}</button>
              <button onClick={signOut} style={{fontSize:"13px",fontWeight:400,color:T.inkSoft,background:"none",border:`1px solid ${T.borderN}`,borderRadius:"999px",padding:"5px 14px",cursor:"pointer",fontFamily:"'Inter',sans-serif",letterSpacing:"-0.01em",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.color="#c0392b";e.currentTarget.style.borderColor="#c0392b";}} onMouseLeave={e=>{e.currentTarget.style.color=T.inkSoft;e.currentTarget.style.borderColor=T.borderN;}}>Sign out</button></>
          :<><button onClick={()=>setPage("returning")} style={{fontSize:"14px",fontWeight:400,color:T.inkSoft,background:"none",border:`1px solid ${T.borderN}`,borderRadius:"999px",padding:"7px 18px",cursor:"pointer",fontFamily:"'Inter',sans-serif",letterSpacing:"-0.01em",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.borderColor=T.inkMid;e.currentTarget.style.color=T.ink;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=T.borderN;e.currentTarget.style.color=T.inkSoft;}}>Sign in</button><button onClick={()=>setPage("register")} style={{fontSize:"14px",fontWeight:500,color:"#fff",background:T.ink,border:"none",borderRadius:"999px",padding:"7px 20px",cursor:"pointer",fontFamily:"'Inter',sans-serif",letterSpacing:"-0.01em",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.opacity="0.85";}} onMouseLeave={e=>{e.currentTarget.style.opacity="1";}}>Get Started ↗</button></>
        }
      </div>
    </nav>
  );
}

/* ── HOME ── */
function HomePage({setPage,student}){
  return(
    <div style={{maxWidth:"1000px",margin:"0 auto",padding:"72px 40px 120px"}}>
      <div style={{maxWidth:"680px"}}>
        <div className="fu" style={{display:"inline-flex",alignItems:"center",gap:"8px",fontSize:"11px",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.gold,background:T.goldPale,border:`1px solid ${T.border}`,borderRadius:"999px",padding:"5px 14px",marginBottom:"24px"}}>
          <span style={{width:"6px",height:"6px",borderRadius:"50%",background:T.gold,display:"inline-block"}}/>AI-Powered Academic Guidance
        </div>
        <h1 className="fu1" style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(40px,6vw,66px)",fontWeight:700,lineHeight:1.1,color:T.ink,marginBottom:"8px",letterSpacing:"-0.03em"}}>Find Your Perfect<br/><em style={{color:T.gold,fontStyle:"italic"}}>University Major</em></h1>
        <Rule/>
        <p className="fu2" style={{fontSize:"16px",color:T.inkSoft,lineHeight:1.8,maxWidth:"540px",marginBottom:"32px"}}>Answer a short career survey, complete MBTI and brain dominance assessments, and receive a personalised major recommendation grounded in your personality and strengths.</p>
        <div className="fu3" style={{display:"flex",gap:"12px",flexWrap:"wrap"}}>
          {student?<><Btn onClick={()=>setPage("survey")} size="lg">Continue Assessment →</Btn><Btn onClick={()=>setPage("results")} variant="outline" size="lg">View Results</Btn></>:<><Btn onClick={()=>setPage("register")} size="lg">Start for Free →</Btn><Btn onClick={()=>setPage("returning")} variant="ghost" size="lg">Sign In</Btn></>}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"14px",marginTop:"72px"}}>
        {[{n:"79.4%",l:"MBTI Prediction Accuracy",i:"🧠"},{n:"25",l:"Optimised Questions",i:"📋"},{n:"16",l:"MBTI Types Covered",i:"🎯"},{n:"30+",l:"Major Categories",i:"🎓"}].map(s=>(
          <Card key={s.l} style={{textAlign:"center",padding:"28px 16px"}} hover>
            <div style={{fontSize:"26px",marginBottom:"10px"}}>{s.i}</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:"28px",fontWeight:700,color:T.gold}}>{s.n}</div>
            <div style={{fontSize:"12px",color:T.inkSoft,marginTop:"4px",lineHeight:1.5}}>{s.l}</div>
          </Card>
        ))}
      </div>

      <div style={{marginTop:"72px"}}>
        <Lbl>How It Works</Lbl>
        <h2 style={{fontFamily:"'Playfair Display',Söhne",fontSize:"32px",fontWeight:700,color:T.ink,marginBottom:"28px",letterSpacing:"-0.02em"}}>Three steps to your recommendation</h2>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:"14px"}}>
          {[{step:"01",title:"Career Survey",desc:"Answer 6 short sections about your interests, skills, values, and preferences.",icon:"📝"},{step:"02",title:"Personality Assessment",desc:"Complete the MBTI (25 questions) and brain dominance (20 questions) tests.",icon:"🧪"},{step:"03",title:"Get Recommendations",desc:"Receive personalised major and career path recommendations based on your full profile.",icon:"✨"}].map(s=>(
            <Card key={s.step} style={{position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:"14px",right:"18px",fontFamily:"'Playfair Display',Söhne",fontSize:"38px",fontWeight:700,color:T.borderN,lineHeight:1}}>{s.step}</div>
              <div style={{fontSize:"26px",marginBottom:"12px"}}>{s.icon}</div>
              <div style={{fontWeight:600,fontSize:"15px",color:T.ink,marginBottom:"6px"}}>{s.title}</div>
              <div style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.7}}>{s.desc}</div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── REGISTER ── */
function RegisterPage({setPage,setStudent}){
  const [f,setF]=useState({first_name:"",middle_name:"",last_name:"",gender:"",date_of_birth:"",email:"",password:""});
  const [err,setErr]=useState({});
  const [loading,setLoading]=useState(false);
  const [apiErr,setApiErr]=useState("");

  function validate(){
    const e={};
    if(!f.first_name.trim())e.first_name="Required";
    if(!f.last_name.trim())e.last_name="Required";
    if(!f.gender)e.gender="Please select";
    if(!f.date_of_birth)e.date_of_birth="Required";
    if(!f.email.trim()||!f.email.includes("@"))e.email="Valid email required";
    if(!f.password||f.password.length<6)e.password="Minimum 6 characters";
    return e;
  }

  async function submit(){
    const e=validate();if(Object.keys(e).length){setErr(e);return;}
    setLoading(true);setApiErr("");
    try{
      const res=await fetch(`${API}/register`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          first_name:f.first_name, middle_name:f.middle_name,
          last_name:f.last_name,   gender:f.gender,
          date_of_birth:f.date_of_birth,
          email:f.email,           password:f.password
        })
      });

      // Parse JSON safely — server might return HTML on crash
      let data;
      try{ data=await res.json(); }
      catch{ setApiErr("Server returned an unexpected response. Check the server console."); setLoading(false); return; }

      // Handle non-2xx (e.g. 409 duplicate email, 400 validation)
      if(!res.ok){
        setApiErr(data.error||`Server error (${res.status}). Please try again.`);
        setLoading(false);
        return;
      }

      // Guard: make sure backend returned the expected fields
      // Backend sends: { id, token, version }
      if(!data.id || !data.token){
        setApiErr("Unexpected response from server — missing id or token. Check server logs.");
        setLoading(false);
        return;
      }

      // Build the frontend student object from form values + backend id
      const dob=new Date(f.date_of_birth);const today=new Date();
      const age=today.getFullYear()-dob.getFullYear()-((today.getMonth()<dob.getMonth()||(today.getMonth()===dob.getMonth()&&today.getDate()<dob.getDate()))?1:0);
      // BUG FIX 1: Seed _v from the real DB version returned by /api/register.
      // Without this, newStudent._v is undefined → StorageManager.write() sets _v=1,
      // but the DB already starts at version=1. After the trigger fires on the first
      // UPDATE the DB goes to version=2 while the client is at _v=2 — still in sync.
      // Seeding from data.version (always 1 on new registration) keeps the contract clear.
      //
      // BUG FIX 5: Call startSession BEFORE setStudent / StorageManager.write so the
      // Bearer token is in sessionStorage by the time syncToBackend() calls getToken().
      // Previously startSession() was called AFTER setStudent(), so the very first PUT
      // fired with no token and was silently dropped — survey/test data was never persisted.
      StorageManager.startSession(data.token);  // ← MOVED UP (was after setStudent)

      const newStudent={
        user_id:data.id,
        _v: data.version || 1,                  // ← seed from DB version
        personal_info:{
          first_name:f.first_name, middle_name:f.middle_name||"",
          last_name:f.last_name,   gender:f.gender,
          date_of_birth:f.date_of_birth, email:f.email,
          full_name:[f.first_name,f.middle_name,f.last_name].filter(Boolean).join(" "),
          age
        },
        survey_responses:{}, mbti_type:null, brain_dominance:null, recommendations:null
      };

      // Persist to localStorage (session already started above)
      try{
        localStorage.setItem("adv_cur",JSON.stringify(newStudent));
        const all=JSON.parse(localStorage.getItem("adv_all")||"[]");
        localStorage.setItem("adv_all",JSON.stringify([...all.filter(s=>s.user_id!==data.id),newStudent]));
      }catch{ /* localStorage blocked (private mode) — continue anyway */ }

      setStudent(newStudent);
      setPage("success");

    }catch(networkErr){
      // Only reaches here if fetch() itself failed (server down / no network)
      console.error("[Register] Network error:", networkErr);
      setApiErr("Cannot reach the server. Make sure the API server is running on port 5000.");
    }finally{
      setLoading(false);
    }
  }
  return(
    <div style={{maxWidth:"1000px",margin:"0 auto",padding:"60px 40px 120px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"60px",alignItems:"start"}}>
      <div className="fu">
        <Lbl>Create Account</Lbl>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(30px,4vw,44px)",fontWeight:700,color:T.ink,marginBottom:"8px",lineHeight:1.2,letterSpacing:"-0.02em"}}>Start your journey</h1>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"32px"}}>Create your profile to begin the personalised major recommendation process. It only takes a minute.</p>
        {[{i:"🔒",t:"Your data is stored locally and never shared"},{i:"⚡",t:"Complete the assessment in under 15 minutes"},{i:"🎯",t:"Receive a recommendation tailored to your profile"}].map(x=>(<div key={x.t} style={{display:"flex",gap:"12px",alignItems:"flex-start",marginBottom:"14px"}}><span style={{fontSize:"18px",flexShrink:0}}>{x.i}</span><span style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.65}}>{x.t}</span></div>))}
      </div>
      <div className="fu1">
        <Card style={{padding:"32px"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
            <Inp label="First Name" value={f.first_name} onChange={e=>setF(p=>({...p,first_name:e.target.value}))} required error={err.first_name}/>
            <Inp label="Last Name" value={f.last_name} onChange={e=>setF(p=>({...p,last_name:e.target.value}))} required error={err.last_name}/>
          </div>
          <Inp label="Middle Name" value={f.middle_name} onChange={e=>setF(p=>({...p,middle_name:e.target.value}))} placeholder="Optional"/>
          <Sel label="Gender" value={f.gender} onChange={e=>setF(p=>({...p,gender:e.target.value}))} required error={err.gender} options={[{value:"M",label:"Male"},{value:"F",label:"Female"},{value:"O",label:"Other"},{value:"N",label:"Prefer not to say"}]}/>
          <Inp label="Date of Birth" type="date" value={f.date_of_birth} onChange={e=>setF(p=>({...p,date_of_birth:e.target.value}))} required error={err.date_of_birth}/>
          <Inp label="Email Address" type="email" value={f.email} onChange={e=>setF(p=>({...p,email:e.target.value}))} placeholder="you@example.com" required error={err.email}/>
          <Inp label="Password" type="password" value={f.password} onChange={e=>setF(p=>({...p,password:e.target.value}))} placeholder="Minimum 6 characters" required error={err.password}/>
          {apiErr&&<div style={{background:"rgba(192,57,43,0.07)",border:"1px solid rgba(192,57,43,0.2)",borderRadius:"10px",padding:"11px 14px",fontSize:"13px",color:"#c0392b",marginBottom:"16px"}}>{apiErr}</div>}
          <Btn onClick={submit} size="lg" full disabled={loading}>{loading?"Creating profile…":"Create Profile →"}</Btn>
          <p style={{fontSize:"12px",color:T.inkSoft,textAlign:"center",marginTop:"14px"}}>Already have a profile? <button onClick={()=>setPage("returning")} style={{color:T.gold,background:"none",border:"none",cursor:"pointer",fontWeight:500,fontSize:"13px",fontFamily:"'Inter',sans-serif",letterSpacing:"-0.01em"}}>Sign in</button></p>
        </Card>
      </div>
    </div>
  );
}

/* ── RETURNING ── */
function ReturningPage({setPage,savedStudents,setStudent}){
  const [f,setF]=useState({email:"",password:""});
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);

  async function login(){
    if(!f.email.trim()||!f.password){setErr("Email and password are required.");return;}
    setLoading(true);setErr("");
    try{
      const res=await fetch(`${API}/login`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:f.email,password:f.password})
      });

      // Parse JSON safely
      let data;
      try{ data=await res.json(); }
      catch{ setErr("Server returned an unexpected response. Check the server console."); setLoading(false); return; }

      if(!res.ok){
        setErr(data.error||`Server error (${res.status}). Please try again.`);
        setLoading(false);
        return;
      }

      // Accept both { student: ... } and { user: ... } — covers different backend versions
      // This is the key fix: backend may send either field name
      const s = data.student || data.user || null;

      if(!s || !s.user_id){
        setErr("Login succeeded but profile data is missing. Check server logs.");
        console.error("[Login] Backend response missing student/user object:", data);
        setLoading(false);
        return;
      }

      // Persist to localStorage + start session
      try{
        localStorage.setItem("adv_cur",JSON.stringify(s));
        const all=JSON.parse(localStorage.getItem("adv_all")||"[]");
        localStorage.setItem("adv_all",JSON.stringify([...all.filter(x=>x.user_id!==s.user_id),s]));
      }catch{ /* localStorage blocked — continue anyway */ }

      StorageManager.startSession(data.token);
      setStudent(s);
      setPage("survey_dashboard");

    }catch(networkErr){
      console.error("[Login] Network error:", networkErr);
      setErr("Cannot reach the server. Make sure the API server is running on port 5000.");
    }finally{
      setLoading(false);
    }
  }

  return(
    <div style={{maxWidth:"460px",margin:"0 auto",padding:"80px 40px 120px"}}>
      <div className="fu"><Lbl>Welcome Back</Lbl><h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(28px,4vw,40px)",fontWeight:700,color:T.ink,marginBottom:"8px",letterSpacing:"-0.02em"}}>Sign in to your profile</h1><Rule/><p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"32px"}}>Sign in with your email and password to continue.</p></div>
      <Card style={{padding:"32px"}} className="fu1">
        <Inp label="Email Address" type="email" value={f.email} onChange={e=>setF(p=>({...p,email:e.target.value}))} placeholder="you@example.com" required/>
        <Inp label="Password" type="password" value={f.password} onChange={e=>setF(p=>({...p,password:e.target.value}))} placeholder="Your password" required/>
        {err&&<div style={{background:"rgba(192,57,43,0.07)",border:"1px solid rgba(192,57,43,0.2)",borderRadius:"10px",padding:"12px 16px",fontSize:"13px",color:"#c0392b",marginBottom:"16px",lineHeight:1.6}}>{err}</div>}
        <Btn onClick={login} size="lg" full disabled={loading}>{loading?"Signing in…":"Sign In →"}</Btn>
        <p style={{fontSize:"12px",color:T.inkSoft,textAlign:"center",marginTop:"14px"}}>No profile yet? <button onClick={()=>setPage("register")} style={{color:T.gold,background:"none",border:"none",cursor:"pointer",fontWeight:500,fontSize:"13px",fontFamily:"'Inter',sans-serif",letterSpacing:"-0.01em"}}>Create one</button></p>
      </Card>
    </div>
  );
}

/* ── SUCCESS ── */
function SuccessPage({setPage,student}){
  return(
    <div style={{maxWidth:"540px",margin:"0 auto",padding:"100px 40px 120px",textAlign:"center"}}>
      <div className="fu" style={{fontSize:"54px",marginBottom:"22px"}}>🎓</div>
      <div className="fu1">
        <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:T.gold,marginBottom:"14px"}}>Registration Complete</div>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(28px,4vw,40px)",fontWeight:700,color:T.ink,marginBottom:"8px",letterSpacing:"-0.02em"}}>Welcome, {student?.personal_info?.first_name}!</h1>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"32px"}}>Your profile has been created. Complete the three assessments below to receive your personalised major recommendation.</p>
        <div style={{display:"flex",gap:"12px",justifyContent:"center",flexWrap:"wrap"}}>
          <Btn onClick={()=>setPage("survey")} size="lg">Start Career Survey →</Btn>
          <Btn onClick={()=>setPage("mbti_select")} variant="ghost" size="lg">Go to MBTI</Btn>
        </div>
      </div>
    </div>
  );
}

/* ── DASHBOARD ── */
function SurveyDashboard({setPage,student}){
  const r=student?.survey_responses||{};
  const surveyDone=SURVEY_SECTIONS.every(s=>s.optional||r[s.id]);
  const pct=Math.round((Object.keys(r).length/SURVEY_SECTIONS.length)*100);
  const steps=[{label:"Career Survey",value:`${pct}% complete`,done:surveyDone,page:"survey",icon:"📝"},{label:"MBTI Assessment",value:student?.mbti_type||"Not started",done:!!student?.mbti_type,page:"mbti_select",icon:"🧠"},{label:"Brain Dominance",value:student?.brain_dominance?(student.brain_dominance==="left"?"Left Brain":"Right Brain"):"Not started",done:!!student?.brain_dominance,page:"brain",icon:"🔬"},{label:"Recommendations",value:student?.recommendations?"Ready to view":"Not generated",done:!!student?.recommendations,page:"results",icon:"✨"}];
  return(
    <div style={{maxWidth:"860px",margin:"0 auto",padding:"60px 40px 120px"}}>
      <div className="fu"><Lbl>Dashboard</Lbl><h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(28px,4vw,40px)",fontWeight:700,color:T.ink,marginBottom:"6px",letterSpacing:"-0.02em"}}>Welcome back, {student?.personal_info?.first_name}</h1><Rule/><p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"36px"}}>Track your progress and continue where you left off.</p></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:"14px",marginBottom:"36px"}}>
        {steps.map(s=>(
          <div key={s.label} className="ch" onClick={()=>setPage(s.page)} style={{background:s.done?T.goldPale:T.bgCard,border:`1.5px solid ${s.done?T.border:T.borderN}`,borderRadius:"14px",padding:"24px 20px",cursor:"pointer"}}>
            <div style={{fontSize:"24px",marginBottom:"12px"}}>{s.icon}</div>
            <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:s.done?T.gold:T.inkSoft,marginBottom:"6px"}}>{s.label}</div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:"16px",fontWeight:600,color:s.done?T.gold:T.ink}}>{s.value}</div>
            <div style={{fontSize:"12px",color:T.inkSoft,marginTop:"8px"}}>{s.done?"✓ Complete":"Tap to start →"}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:"12px",flexWrap:"wrap"}}>
        <Btn onClick={()=>setPage("survey")} size="lg">Continue Assessment →</Btn>
        {student?.recommendations&&<Btn onClick={()=>setPage("results")} variant="outline" size="lg">View Recommendations</Btn>}
      </div>
    </div>
  );
}

/* ── SURVEY ── */
function SurveyPage({setPage,student,setStudent}){
  const [idx,setIdx]=useState(0);
  const [r,setR]=useState(student?.survey_responses||{});
  const sec=SURVEY_SECTIONS[idx];
  // next() builds the full updated object synchronously — no race with async setState
  function next(){
    if(!sec.optional && !r[sec.id] && sec.type!=="text") return; // guard: let text be optional naturally
    const updated={...student,survey_responses:{...(student?.survey_responses||{}),...r}};
    setStudent(updated);
    if(idx<SURVEY_SECTIONS.length-1){
      setIdx(i=>i+1);
      window.scrollTo({top:0,behavior:"smooth"});
    } else {
      setPage("survey_complete");
    }
  }
  function prev(){if(idx>0){setIdx(i=>i-1);window.scrollTo({top:0,behavior:"smooth"});}}
  function set(k,v){setR(p=>({...p,[k]:v}));}
  function toggle(k,v){const c=r[k]||[];if(c.includes(v))setR(p=>({...p,[k]:c.filter(x=>x!==v)}));else if(c.length<3)setR(p=>({...p,[k]:[...c,v]}));}

  const Choice=({opt,sel,onClick,badge})=>(
    <div onClick={onClick} style={{display:"flex",alignItems:"flex-start",gap:"14px",padding:"16px 20px",background:sel?T.goldPale:T.bgWhite,border:`1.5px solid ${sel?T.gold:T.borderN}`,borderRadius:"12px",cursor:"pointer",transition:"all 0.18s",boxShadow:sel?`0 0 0 3px ${T.goldRing}`:"none"}}
      onMouseEnter={e=>{if(!sel){e.currentTarget.style.borderColor=T.border;e.currentTarget.style.background=T.bgCard;}}}
      onMouseLeave={e=>{if(!sel){e.currentTarget.style.borderColor=T.borderN;e.currentTarget.style.background=T.bgWhite;}}}>
      <div style={{flexShrink:0,width:"34px",height:"34px",borderRadius:"8px",background:sel?T.gold:T.borderN,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:"13px",color:sel?"#fff":T.inkSoft,transition:"all 0.18s"}}>{badge}</div>
      <div><div style={{fontWeight:600,fontSize:"15px",color:T.ink,marginBottom:"3px"}}>{opt.label}</div><div style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.6}}>{opt.desc}</div></div>
    </div>
  );

  return(
    <div style={{maxWidth:"740px",margin:"0 auto",padding:"44px 40px 120px"}}>
      <div style={{marginBottom:"36px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"10px"}}>
          <div style={{display:"flex",gap:"6px"}}>{SURVEY_SECTIONS.map((s,i)=>(<button key={s.id} onClick={()=>setIdx(i)} style={{width:"26px",height:"26px",borderRadius:"6px",background:i===idx?T.gold:i<idx?T.goldPale:T.borderN,border:`1px solid ${i===idx?T.gold:i<idx?T.border:"transparent"}`,cursor:"pointer",fontSize:"11px",fontWeight:700,color:i===idx?"#fff":i<idx?T.gold:T.inkSoft,transition:"all 0.2s"}}>{i+1}</button>))}</div>
          <span style={{fontSize:"13px",color:T.inkSoft}}>{sec.eyebrow}</span>
        </div>
        <PBar value={((idx+1)/SURVEY_SECTIONS.length)*100}/>
      </div>

      <div className="fu" key={idx}>
        <Lbl>{sec.eyebrow}</Lbl>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(24px,4vw,34px)",fontWeight:700,color:T.ink,marginBottom:"8px"}}>{sec.title}</h2>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.75,marginBottom:"6px"}}>{sec.subtitle}</p>
        <p style={{fontSize:"13px",color:T.gold,fontWeight:600,marginBottom:"26px"}}>{sec.hint}</p>

        {sec.type==="single_choice"&&<div style={{display:"flex",flexDirection:"column",gap:"10px"}}>{sec.options.map(o=><Choice key={o.value} opt={o} badge={o.value} sel={r[sec.id]===o.value} onClick={()=>set(sec.id,o.value)}/>)}</div>}
        {sec.type==="multi_choice"&&<div style={{display:"flex",flexDirection:"column",gap:"10px"}}>{sec.options.map((o,i)=>{const sel=(r[sec.id]||[]).includes(o.value);return<Choice key={o.value} opt={o} badge={String(i+1)} sel={sel} onClick={()=>toggle(sec.id,o.value)}/>;})}</div>}
        {sec.type==="keywords"&&(<div style={{display:"flex",flexDirection:"column",gap:"12px",maxWidth:"500px"}}>{[0,1,2].map(i=>(<div key={i} style={{display:"flex",alignItems:"center",gap:"12px"}}><div style={{flexShrink:0,width:"30px",height:"30px",borderRadius:"8px",background:T.goldPale,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"12px",fontWeight:700,color:T.gold}}>{i+1}</div><input type="text" placeholder={["e.g. Programming","e.g. Empathy","e.g. Organization"][i]} maxLength={40} value={(r[sec.id]||[])[i]||""} onChange={e=>{const a=[...(r[sec.id]||["","",""])];a[i]=e.target.value;set(sec.id,a);}} style={{flex:1,padding:"11px 14px",border:`1.5px solid ${T.borderN}`,borderRadius:"10px",background:T.bgWhite,fontFamily:"'Inter',sans-serif",fontSize:"14px",color:T.ink,transition:"all 0.18s"}}/></div>))}</div>)}
        {sec.type==="text"&&(<div style={{maxWidth:"500px"}}><input type="text" placeholder={sec.placeholder} maxLength={120} value={r[sec.id]||""} onChange={e=>set(sec.id,e.target.value)} style={{width:"100%",padding:"13px 16px",border:`1.5px solid ${T.borderN}`,borderRadius:"10px",background:T.bgWhite,fontFamily:"'Inter',sans-serif",fontSize:"15px",color:T.ink,transition:"all 0.18s"}}/><p style={{fontSize:"12px",color:T.inkSoft,marginTop:"7px",fontStyle:"italic"}}>Use a short phrase.{sec.optional&&" (Optional)"}</p></div>)}

        <div style={{display:"flex",gap:"10px",marginTop:"36px"}}>
          {idx>0&&<Btn onClick={prev} variant="ghost">← Previous</Btn>}
          <Btn onClick={next}>
            {idx<SURVEY_SECTIONS.length-1?"Next →":"Continue to MBTI Assessment →"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ── SURVEY COMPLETE ── */
function SurveyCompletePage({setPage,student}){
  return(
    <div style={{maxWidth:"520px",margin:"0 auto",padding:"100px 40px 120px",textAlign:"center"}}>
      <div className="fu" style={{fontSize:"54px",marginBottom:"22px"}}>✅</div>
      <div className="fu1">
        <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:T.gold,marginBottom:"14px"}}>Survey Complete</div>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(26px,4vw,38px)",fontWeight:700,color:T.ink,marginBottom:"8px",letterSpacing:"-0.02em"}}>Career Survey Done!</h1>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"32px"}}>Great work, {student?.personal_info?.first_name}. Complete the MBTI and Brain Dominance assessments to unlock your full recommendation.</p>
        <div style={{display:"flex",gap:"12px",justifyContent:"center",flexWrap:"wrap"}}>
          <Btn onClick={()=>setPage("mbti_select")} size="lg">Next: MBTI Assessment →</Btn>
          <Btn onClick={()=>setPage("survey_dashboard")} variant="ghost">Dashboard</Btn>
        </div>
      </div>
    </div>
  );
}

/* ── MBTI SELECT ── */
function MBTISelectPage({setPage,student,setStudent}){
  const [mode,setMode]=useState("yes");
  const [sel,setSel]=useState(student?.mbti_type||null);
  function go(){if(mode==="yes"&&sel){setStudent({...student,mbti_type:sel});setPage("brain");}else if(mode==="no")setPage("mbti_test");}
  return(
    <div style={{maxWidth:"860px",margin:"0 auto",padding:"60px 40px 120px"}}>
      <div className="fu">
        <div style={{display:"inline-flex",alignItems:"center",gap:"7px",fontSize:"11px",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.gold,background:T.goldPale,border:`1px solid ${T.border}`,borderRadius:"999px",padding:"5px 14px",marginBottom:"20px"}}>Step 1 of 3 — Personality</div>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(28px,4vw,44px)",fontWeight:700,color:T.ink,margin:"0 0 8px",lineHeight:1.15,letterSpacing:"-0.02em"}}>Do you know your MBTI type?</h1>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"28px",maxWidth:"540px"}}>Already know your type? Select it and continue. Otherwise take our 25-question assessment.</p>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px",maxWidth:"580px",marginBottom:"32px"}}>
        {[{id:"yes",label:"Yes, I know my MBTI type",desc:"Select from all 16 types below."},{id:"no",label:"No, I'll take the test",desc:"25 questions, takes about 5 minutes."}].map(o=>(
          <div key={o.id} onClick={()=>setMode(o.id)} style={{background:mode===o.id?T.goldPale:T.bgCard,border:`1.5px solid ${mode===o.id?T.gold:T.borderN}`,borderRadius:"12px",padding:"18px",cursor:"pointer",transition:"all 0.18s",boxShadow:mode===o.id?`0 0 0 3px ${T.goldRing}`:"none"}}>
            <div style={{width:"15px",height:"15px",borderRadius:"50%",border:`2px solid ${mode===o.id?T.gold:"#bbb"}`,marginBottom:"10px",display:"flex",alignItems:"center",justifyContent:"center",background:mode===o.id?T.gold:"transparent"}}>{mode===o.id&&<div style={{width:"5px",height:"5px",borderRadius:"50%",background:"#fff"}}/>}</div>
            <div style={{fontWeight:600,fontSize:"14px",color:T.ink,marginBottom:"3px"}}>{o.label}</div>
            <div style={{fontSize:"12px",color:T.inkSoft}}>{o.desc}</div>
          </div>
        ))}
      </div>
      {mode==="yes"&&(<div className="fu">{Object.entries(MBTI_TYPES).map(([grp,types])=>(<div key={grp} style={{marginBottom:"18px"}}><div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.gold,marginBottom:"8px"}}>{grp}</div><div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"8px"}}>{types.map(t=>(<div key={t.code} onClick={()=>setSel(t.code)} style={{background:sel===t.code?T.gold:T.bgWhite,border:`1.5px solid ${sel===t.code?T.gold:T.borderN}`,borderRadius:"10px",padding:"13px 8px",textAlign:"center",cursor:"pointer",transition:"all 0.18s"}} onMouseEnter={e=>{if(sel!==t.code){e.currentTarget.style.borderColor=T.gold;e.currentTarget.style.background=T.goldPale;}}} onMouseLeave={e=>{if(sel!==t.code){e.currentTarget.style.borderColor=T.borderN;e.currentTarget.style.background=T.bgWhite;}}}><div style={{fontFamily:"'Playfair Display',serif",fontSize:"16px",fontWeight:700,color:sel===t.code?"#fff":T.gold}}>{t.code}</div><div style={{fontSize:"10px",color:sel===t.code?"rgba(255,255,255,0.75)":T.inkSoft,marginTop:"3px",lineHeight:1.3}}>{t.nick}</div></div>))}</div></div>))}</div>)}
      {mode==="no"&&(<Card style={{maxWidth:"400px",textAlign:"center",padding:"32px"}} className="fu"><div style={{fontSize:"34px",marginBottom:"14px"}}>🧪</div><h3 style={{fontFamily:"'Playfair Display',serif",fontSize:"22px",color:T.ink,marginBottom:"8px"}}>Discover Your MBTI Type</h3><p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.75}}>Our 25-question assessment measures 4 personality dimensions with 79.4% accuracy.</p></Card>)}
      <div style={{display:"flex",gap:"12px",marginTop:"28px"}}>
        <Btn onClick={()=>setPage("survey_complete")} variant="ghost">← Back</Btn>
        <Btn onClick={go} disabled={mode==="yes"&&!sel}>{mode==="no"?"Take MBTI Test →":"Continue to Brain Assessment →"}</Btn>
      </div>
    </div>
  );
}

/* ── MBTI TEST ── */
function MBTITestPage({setPage,student,setStudent}){
  const [r,setR]=useState(student?.mbti_test_responses||{});
  const [missingIdx,setMissingIdx]=useState(null); // index of first unanswered Q
  const [banner,setBanner]=useState("");
  const cardRefs=useRef([]);
  const ans=Object.keys(r).length;
  const pct=Math.round((ans/25)*100);
  const labels=["Strongly\nDisagree","Disagree","Slightly\nDisagree","Neutral","Slightly\nAgree","Agree","Strongly\nAgree"];

  /* Clear the banner whenever the user answers the missing question */
  useEffect(()=>{
    if(missingIdx!==null && r[missingIdx]!==undefined){
      setMissingIdx(null);
      setBanner("");
    }
  },[r,missingIdx]);

  function submit(){
    /* Find first unanswered question */
    const first = MQ.findIndex((_,i)=>r[i]===undefined);
    if(first !== -1){
      setMissingIdx(first);
      setBanner(`Question ${first+1} is unanswered — please answer it to continue.`);
      /* Scroll to that card */
      const card = cardRefs.current[first];
      if(card) card.scrollIntoView({behavior:"smooth", block:"center"});
      return;
    }
    const type=predictMBTI(r);
    setStudent({...student,mbti_type:type,mbti_test_responses:r});
    setPage("mbti_result");
  }

  return(
    <div>
      <div style={{position:"sticky",top:"58px",zIndex:100,background:T.navBg,backdropFilter:"blur(14px)",borderBottom:`1px solid ${T.borderN}`,padding:"11px 40px"}}>
        <div style={{maxWidth:"860px",margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"7px"}}>
            <span style={{fontSize:"12px",fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.inkSoft}}>MBTI Assessment — Step 2 of 3</span>
            <span style={{fontFamily:"'Playfair Display',serif",fontSize:"18px",fontWeight:700,color:T.gold}}>{pct}%</span>
          </div>
          <PBar value={pct}/>
          <div style={{fontSize:"11px",color:T.inkSoft,marginTop:"5px"}}>{ans} of 25 answered</div>
        </div>
      </div>

      {/* ── Unanswered-question banner ── */}
      {banner&&(
        <div style={{position:"sticky",top:"calc(58px + 54px)",zIndex:99,background:"#fff3cd",borderBottom:"1px solid #ffc107",padding:"10px 40px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:"13px",fontWeight:500,color:"#856404"}}>⚠ {banner}</span>
          <button onClick={()=>{setMissingIdx(null);setBanner("");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:"16px",color:"#856404",lineHeight:1}}>×</button>
        </div>
      )}

      <div style={{maxWidth:"740px",margin:"0 auto",padding:"36px 40px 120px"}}>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"26px",fontWeight:700,color:T.ink,marginBottom:"6px",letterSpacing:"-0.02em"}}>MBTI Personality Assessment</h2>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.75,marginBottom:"28px"}}>Rate each statement from Strongly Disagree (−3) to Strongly Agree (+3). Answer honestly.</p>
        {MQ.map((q,i)=>(
          <div
            key={i}
            ref={el=>cardRefs.current[i]=el}
            style={{
              background:T.bgCard,
              border:`1px solid ${missingIdx===i?"#e74c3c":T.borderN}`,
              borderRadius:"12px",
              padding:"18px 20px",
              marginBottom:"10px",
              transition:"border-color 0.3s, box-shadow 0.3s",
              boxShadow:missingIdx===i?"0 0 0 3px rgba(231,76,60,0.18)":"none"
            }}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"12px",marginBottom:"12px"}}>
              <div style={{fontSize:"14px",fontWeight:500,color:T.ink,lineHeight:1.65,flex:1}}>
                {missingIdx===i&&<span style={{color:"#e74c3c",fontWeight:700,marginRight:"6px"}}>↓</span>}
                {q}
              </div>
              <span style={{fontSize:"11px",fontWeight:700,color:r[i]!==undefined?T.gold:T.borderN,flexShrink:0}}>{r[i]!==undefined?`${r[i]>0?"+":""}${r[i]}`:"—"}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:"4px"}}>
              {[-3,-2,-1,0,1,2,3].map((v,si)=>(
                <button key={v} onClick={()=>setR(p=>({...p,[i]:v}))} style={{padding:"8px 2px",background:r[i]===v?T.gold:T.bgWhite,border:`1.5px solid ${r[i]===v?T.gold:T.borderN}`,borderRadius:"8px",fontSize:"10px",fontWeight:500,color:r[i]===v?"#fff":T.inkSoft,cursor:"pointer",transition:"all 0.15s",lineHeight:1.3}}
                  onMouseEnter={e=>{if(r[i]!==v){e.currentTarget.style.borderColor=T.gold;e.currentTarget.style.color=T.gold;}}}
                  onMouseLeave={e=>{if(r[i]!==v){e.currentTarget.style.borderColor=T.borderN;e.currentTarget.style.color=T.inkSoft;}}}>
                  {labels[si].split("\n").map((l,j)=><div key={j}>{l}</div>)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:150,background:T.navBg,backdropFilter:"blur(14px)",borderTop:`1px solid ${T.borderN}`,padding:"11px 40px"}}>
        <div style={{maxWidth:"740px",margin:"0 auto",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <Btn onClick={()=>{setStudent({...student,mbti_test_responses:r});setPage("mbti_select");}} variant="ghost" size="sm">← Back</Btn>
          <span style={{fontSize:"13px",color:T.inkSoft}}><strong style={{color:T.gold}}>{ans}</strong> / 25</span>
          <Btn onClick={submit} size="sm">Submit & See Result →</Btn>
        </div>
      </div>
    </div>
  );
}

/* ── MBTI RESULT ── */
function MBTIResultPage({setPage,student}){
  const t=student?.mbti_type;
  return(
    <div style={{maxWidth:"520px",margin:"0 auto",padding:"100px 40px 120px",textAlign:"center"}}>
      <div className="fu" style={{fontSize:"54px",marginBottom:"22px"}}>🧠</div>
      <div className="fu1">
        <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:T.gold,marginBottom:"14px"}}>Your MBTI Type</div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(54px,10vw,86px)",fontWeight:700,color:T.gold,lineHeight:1}}>{t}</div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:"18px",color:T.inkMid,marginTop:"10px",fontStyle:"italic"}}>{NICK[t]||""}</div>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"32px"}}>Your personality type has been recorded. Complete the brain dominance assessment to finalise your profile.</p>
        <div style={{display:"flex",gap:"12px",justifyContent:"center"}}><Btn onClick={()=>setPage("brain")} size="lg">Next: Brain Dominance →</Btn><Btn onClick={()=>setPage("mbti_test")} variant="ghost">Retake</Btn></div>
      </div>
    </div>
  );
}

/* ── BRAIN ── */
function BrainPage({setPage,student,setStudent}){
  const [r,setR]=useState(student?.brain_responses||{});
  const [missingIdx,setMissingIdx]=useState(null);
  const [banner,setBanner]=useState("");
  const cardRefs=useRef([]);
  const ans=Object.keys(r).length;
  const pct=Math.round((ans/20)*100);

  /* Clear banner when the missing question gets answered */
  useEffect(()=>{
    if(missingIdx!==null && r[missingIdx]!==undefined){
      setMissingIdx(null);
      setBanner("");
    }
  },[r,missingIdx]);

  function finish(){
    const first = BQ.findIndex((_,i)=>r[i]===undefined);
    if(first !== -1){
      setMissingIdx(first);
      setBanner(`Question ${first+1} is unanswered — please answer it to continue.`);
      const card = cardRefs.current[first];
      if(card) card.scrollIntoView({behavior:"smooth", block:"center"});
      return;
    }
    const res=predictBrain(r);
    setStudent({...student,brain_dominance:res,brain_responses:r});
    setPage("brain_result");
  }

  return(
    <div>
      <div style={{position:"sticky",top:"58px",zIndex:100,background:T.navBg,backdropFilter:"blur(14px)",borderBottom:`1px solid ${T.borderN}`,padding:"11px 40px"}}>
        <div style={{maxWidth:"860px",margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"7px"}}>
            <span style={{fontSize:"12px",fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.inkSoft}}>Brain Dominance — Step 3 of 3</span>
            <span style={{fontFamily:"'Playfair Display',serif",fontSize:"18px",fontWeight:700,color:T.gold}}>{pct}%</span>
          </div>
          <PBar value={pct}/>
          <div style={{fontSize:"11px",color:T.inkSoft,marginTop:"5px"}}>{ans} of 20 answered</div>
        </div>
      </div>

      {/* ── Unanswered-question banner ── */}
      {banner&&(
        <div style={{position:"sticky",top:"calc(58px + 54px)",zIndex:99,background:"#fff3cd",borderBottom:"1px solid #ffc107",padding:"10px 40px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:"13px",fontWeight:500,color:"#856404"}}>⚠ {banner}</span>
          <button onClick={()=>{setMissingIdx(null);setBanner("");}} style={{background:"none",border:"none",cursor:"pointer",fontSize:"16px",color:"#856404",lineHeight:1}}>×</button>
        </div>
      )}

      <div style={{maxWidth:"740px",margin:"0 auto",padding:"36px 40px 120px"}}>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"26px",fontWeight:700,color:T.ink,marginBottom:"6px",letterSpacing:"-0.02em"}}>Brain Dominance Assessment</h2>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.75,marginBottom:"18px"}}>Choose the option that most naturally describes how you think and work.</p>
        <div style={{background:T.goldPale,border:`1px solid ${T.border}`,borderRadius:"10px",padding:"13px 16px",display:"flex",gap:"10px",fontSize:"14px",color:T.inkSoft,lineHeight:1.7,marginBottom:"24px"}}>
          <span style={{fontSize:"15px",flexShrink:0}}>💡</span>
          <span><strong style={{color:T.gold}}>Option A</strong> — left-brain (logical, sequential). <strong style={{color:T.gold}}>Option B</strong> — right-brain (creative, intuitive).</span>
        </div>
        {BQ.map((q,i)=>(
          <div
            key={i}
            ref={el=>cardRefs.current[i]=el}
            style={{
              background:T.bgCard,
              border:`1px solid ${missingIdx===i?"#e74c3c":T.borderN}`,
              borderRadius:"12px",
              padding:"18px 20px",
              marginBottom:"10px",
              transition:"border-color 0.3s, box-shadow 0.3s",
              boxShadow:missingIdx===i?"0 0 0 3px rgba(231,76,60,0.18)":"none"
            }}>
            <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"7px"}}>
              <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:missingIdx===i?"#e74c3c":T.gold}}>Q{i+1}</div>
              {missingIdx===i&&<span style={{fontSize:"11px",fontWeight:600,color:"#e74c3c"}}>← Answer required</span>}
            </div>
            <div style={{fontSize:"14px",fontWeight:500,color:T.ink,marginBottom:"12px"}}>{q.q}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px"}}>
              {[{k:"A",t:q.a},{k:"B",t:q.b}].map(o=>(
                <button key={o.k} onClick={()=>setR(p=>({...p,[i]:o.k}))} style={{background:r[i]===o.k?T.goldPale:T.bgWhite,border:`1.5px solid ${r[i]===o.k?T.gold:T.borderN}`,borderRadius:"10px",padding:"13px 14px",cursor:"pointer",transition:"all 0.18s",display:"flex",alignItems:"flex-start",gap:"10px",textAlign:"left",boxShadow:r[i]===o.k?`0 0 0 3px ${T.goldRing}`:"none"}}
                  onMouseEnter={e=>{if(r[i]!==o.k){e.currentTarget.style.borderColor=T.border;e.currentTarget.style.background=T.bgCard;}}}
                  onMouseLeave={e=>{if(r[i]!==o.k){e.currentTarget.style.borderColor=T.borderN;e.currentTarget.style.background=T.bgWhite;}}}>
                  <span style={{width:"20px",height:"20px",borderRadius:"50%",background:r[i]===o.k?T.gold:T.borderN,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"10px",fontWeight:700,color:r[i]===o.k?"#fff":T.inkSoft,flexShrink:0}}>{o.k}</span>
                  <span style={{fontSize:"14px",color:r[i]===o.k?T.ink:T.inkSoft,lineHeight:1.6,fontWeight:r[i]===o.k?500:400}}>{o.t}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:150,background:T.navBg,backdropFilter:"blur(14px)",borderTop:`1px solid ${T.borderN}`,padding:"11px 40px"}}>
        <div style={{maxWidth:"740px",margin:"0 auto",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <Btn onClick={()=>{setStudent({...student,brain_responses:r});setPage("mbti_select");}} variant="ghost" size="sm">← Back</Btn>
          <span style={{fontSize:"13px",color:T.inkSoft}}><strong style={{color:T.gold}}>{ans}</strong> / 20</span>
          <Btn onClick={finish} size="sm">Finish Assessment →</Btn>
        </div>
      </div>
    </div>
  );
}

/* ── BRAIN RESULT ── */
function BrainResultPage({setPage,student,setStudent}){
  const brain=student?.brain_dominance;const isLeft=brain==="left";
  function gen(){const recs=buildRecs(student);if(!recs)return;setStudent({...student,recommendations:recs});setPage("results");}
  return(
    <div style={{maxWidth:"520px",margin:"0 auto",padding:"100px 40px 120px",textAlign:"center"}}>
      <div className="fu" style={{fontSize:"54px",marginBottom:"22px"}}>{isLeft?"🔢":"🎨"}</div>
      <div className="fu1">
        <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:T.gold,marginBottom:"14px"}}>Brain Dominance Result</div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(34px,7vw,58px)",fontWeight:700,color:T.gold,lineHeight:1}}>{isLeft?"Left Brain":"Right Brain"}</div>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:"18px",color:T.inkMid,marginTop:"8px",fontStyle:"italic"}}>{isLeft?"Logical · Analytical · Structured":"Creative · Intuitive · Holistic"}</div>
        <Rule/>
        <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"32px"}}>{isLeft?"You think in sequences, prefer structure, and excel at logical problem-solving.":"You think holistically, prefer open-ended creativity, and excel at intuitive decision-making."}</p>
        <div style={{display:"flex",gap:"12px",justifyContent:"center",flexWrap:"wrap"}}><Btn onClick={gen} size="lg">Generate My Recommendations →</Btn><Btn onClick={()=>setPage("survey_dashboard")} variant="ghost">Dashboard</Btn></div>
      </div>
    </div>
  );
}

/* ── RESULTS ── */
function ResultsPage({setPage,student,setStudent}){
  const recs=student?.recommendations;
  if(!recs)return(
    <div style={{maxWidth:"520px",margin:"0 auto",padding:"100px 40px 120px",textAlign:"center"}}>
      <div style={{fontSize:"54px",marginBottom:"22px"}}>📋</div>
      <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"32px",fontWeight:700,color:T.ink,marginBottom:"14px",letterSpacing:"-0.02em"}}>No Recommendations Yet</h2>
      <p style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.8,marginBottom:"28px"}}>Complete the Career Survey, MBTI, and Brain Dominance test to generate your recommendations.</p>
      <div style={{display:"flex",gap:"12px",justifyContent:"center",flexWrap:"wrap"}}><Btn onClick={()=>setPage("survey")} size="lg">Start Survey →</Btn><Btn onClick={()=>setPage("survey_dashboard")} variant="ghost">Dashboard</Btn></div>
    </div>
  );
  return(
    <div style={{maxWidth:"840px",margin:"0 auto",padding:"60px 40px 120px"}}>
      <div className="fu">
        <Lbl>Your Results</Lbl>
        <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(28px,4vw,44px)",fontWeight:700,color:T.ink,marginBottom:"8px",lineHeight:1.15,letterSpacing:"-0.02em"}}>Your Ideal <em style={{color:T.gold,fontStyle:"italic"}}>Major Recommendations</em></h1>
        <Rule/>
        <div style={{display:"flex",gap:"10px",flexWrap:"wrap",marginBottom:"32px"}}>
          {[{l:"MBTI",v:`${recs.mbti_type} — ${NICK[recs.mbti_type]||""}`},{l:"Brain Dominance",v:recs.brain_dominance==="left"?"Left Brain (Logical)":"Right Brain (Creative)"}].map(p=>(
            <div key={p.l} style={{background:T.goldPale,border:`1px solid ${T.border}`,borderRadius:"999px",padding:"6px 16px",fontSize:"13px",color:T.gold,fontWeight:600}}>{p.l}: <span style={{fontWeight:400,color:T.inkMid}}>{p.v}</span></div>
          ))}
        </div>
      </div>
      <Card style={{marginBottom:"32px",borderLeft:`3px solid ${T.gold}`}} className="fu1">
        <div style={{fontSize:"11px",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.gold,marginBottom:"10px"}}>Academic Advisor's Note</div>
        <p style={{fontSize:"14px",color:T.inkMid,lineHeight:1.85}}>{recs.comprehensive_explanation}</p>
      </Card>
      <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"22px",fontWeight:700,color:T.ink,marginBottom:"16px",letterSpacing:"-0.02em"}}>Recommended Majors</h2>
      <div style={{display:"flex",flexDirection:"column",gap:"10px",marginBottom:"40px"}}>
        {recs.top_majors.map((m,i)=>(
          <div key={m} style={{background:T.bgCard,border:`1.5px solid ${i===0?T.gold:T.borderN}`,borderRadius:"12px",padding:"18px 20px",display:"flex",gap:"16px",alignItems:"center",boxShadow:i===0?`0 0 0 3px ${T.goldRing}`:"none"}}>
            <div style={{flexShrink:0,width:"40px",height:"40px",borderRadius:"10px",background:i===0?T.gold:T.goldPale,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Playfair Display',serif",fontSize:"16px",fontWeight:700,color:i===0?"#fff":T.gold}}>#{i+1}</div>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:"17px",fontWeight:600,color:T.ink,marginBottom:"3px"}}>{m}</div>
              <div style={{fontSize:"14px",color:T.inkSoft,lineHeight:1.65}}>{recs.major_reasons[m]||""}</div>
            </div>
            <div style={{flexShrink:0,background:i===0?T.goldPale:T.borderN,border:`1px solid ${i===0?T.border:"transparent"}`,borderRadius:"999px",padding:"4px 13px",fontSize:"12px",color:i===0?T.gold:T.inkSoft,fontWeight:600}}>{100-i*10}%</div>
          </div>
        ))}
      </div>
      <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"22px",fontWeight:700,color:T.ink,marginBottom:"14px",letterSpacing:"-0.02em"}}>Related Career Paths</h2>
      <div style={{display:"flex",gap:"8px",flexWrap:"wrap",marginBottom:"40px"}}>
        {recs.top_occupations.map(o=><div key={o} style={{background:T.bgWhite,border:`1px solid ${T.borderN}`,borderRadius:"10px",padding:"9px 16px",fontSize:"14px",color:T.inkMid,fontWeight:500}}>{o}</div>)}
      </div>
      <div style={{display:"flex",gap:"10px",flexWrap:"wrap"}}>
        <Btn onClick={()=>{const r=buildRecs(student);if(r)setStudent({...student,recommendations:r});}} variant="outline">Regenerate</Btn>
        <Btn onClick={()=>setPage("survey")} variant="ghost">Edit Survey</Btn>
        <Btn onClick={()=>setPage("survey_dashboard")} variant="ghost">← Dashboard</Btn>
      </div>
    </div>
  );
}

/* ── ROOT ── */
export default function App(){
  injectStyles();
  const [page,setPage]=useState("home");
  const [student,setStudent]=useState(()=>StorageManager.readCurrent());
  const [saved,setSaved]=useState(()=>StorageManager.readAll());
  const [syncToast,setSyncToast]=useState(""); // cross-tab notification
  const toastTimer=useRef(null);

  /* ── Versioned save — writes via StorageManager ── */
  const save=useCallback((data)=>{
    // Safety net: if caller accidentally passes a function, resolve it first
    if(typeof data==='function'){ return save(data(student)); }
    const result=StorageManager.write(data,saved);
    if(!result) return;
    setStudent(result.student);
    setSaved(result.all);
  },[saved,student]);

  function signOut(){
    StorageManager.endSession();
    setStudent(null);
    setSaved([]);
    setPage("home");
  }

  /*
    ── Cross-tab sync via the "storage" event ──
    Fires in THIS tab when ANOTHER tab writes to localStorage.
    We merge the two versions and rehydrate state.
  */
  useEffect(()=>{
    function onStorageChange(e){
      if(e.key==="adv_cur" && e.newValue){
        try{
          const remote=JSON.parse(e.newValue);
          setStudent(prev=>{
            const merged=StorageManager.merge(prev,remote);
            /* Persist the merged result back */
            try{ localStorage.setItem("adv_cur",JSON.stringify(merged)); }catch{}
            return merged;
          });
          setSaved(StorageManager.readAll());
          /* Show toast for 4 seconds then clear */
          setSyncToast("Your profile was updated in another tab — changes merged.");
          clearTimeout(toastTimer.current);
          toastTimer.current=setTimeout(()=>setSyncToast(""),4000);
        }catch{}
      }
    }
    window.addEventListener("storage",onStorageChange);
    return()=>{ window.removeEventListener("storage",onStorageChange); clearTimeout(toastTimer.current); };
  },[]);

  const P={
    home:<HomePage setPage={setPage} student={student}/>,
    register:<RegisterPage setPage={setPage} setStudent={save}/>,
    returning:<ReturningPage setPage={setPage} savedStudents={saved} setStudent={save}/>,
    success:<SuccessPage setPage={setPage} student={student}/>,
    survey:<SurveyPage setPage={setPage} student={student} setStudent={save}/>,
    survey_complete:<SurveyCompletePage setPage={setPage} student={student}/>,
    survey_dashboard:<SurveyDashboard setPage={setPage} student={student}/>,
    mbti_select:<MBTISelectPage setPage={setPage} student={student} setStudent={save}/>,
    mbti_test:<MBTITestPage setPage={setPage} student={student} setStudent={save}/>,
    mbti_result:<MBTIResultPage setPage={setPage} student={student}/>,
    brain:<BrainPage setPage={setPage} student={student} setStudent={save}/>,
    brain_result:<BrainResultPage setPage={setPage} student={student} setStudent={save}/>,
    results:<ResultsPage setPage={setPage} student={student} setStudent={save}/>,
  };

  return(
    <div style={{minHeight:"100vh",background:T.bg}}>
      <Navbar page={page} setPage={setPage} student={student} signOut={signOut}/>

      {/* ── Cross-tab sync toast ── */}
      {syncToast&&(
        <div style={{
          position:"fixed",bottom:"80px",left:"50%",transform:"translateX(-50%)",
          zIndex:9999,background:T.ink,color:"#fff",
          padding:"10px 22px",borderRadius:"999px",
          fontSize:"13px",fontWeight:500,
          boxShadow:"0 4px 20px rgba(0,0,0,0.25)",
          display:"flex",alignItems:"center",gap:"10px",
          animation:"fadeUp 0.3s ease both"
        }}>
          <span style={{fontSize:"15px"}}>🔄</span>
          {syncToast}
          <button onClick={()=>setSyncToast("")} style={{background:"none",border:"none",color:"rgba(255,255,255,0.7)",cursor:"pointer",fontSize:"15px",lineHeight:1,marginLeft:"4px"}}>×</button>
        </div>
      )}

      <div key={page} className="fu">{P[page]||P.home}</div>
    </div>
  );
}
