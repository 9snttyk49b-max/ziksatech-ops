import { useState, useEffect, useMemo, useRef, useCallback } from "react";
const TODAY_STR = new Date().toISOString().slice(0, 10); // dynamic — always today

// ─── PERSISTENT STORAGE ──────────────────────────────────────────────────────
// ── Supabase storage (falls back to localStorage if env vars not set) ─────────
const SUPA_URL  = typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL;
const SUPA_ANON = typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_ANON;

// ── Supabase Auth helpers ──────────────────────────────────────────────────────
const supaAuth = (() => {
  if (!SUPA_URL || !SUPA_ANON) return null;
  const base = SUPA_URL;
  const h = { "Content-Type":"application/json", "apikey":SUPA_ANON };

  return {
    async signUp(email, password, fullName, role="consultant") {
      const r = await fetch(`${base}/auth/v1/signup`, {
        method:"POST", headers:h,
        body: JSON.stringify({ email, password, data:{ full_name:fullName, role } })
      });
      return r.json();
    },
    async signIn(email, password) {
      const r = await fetch(`${base}/auth/v1/token?grant_type=password`, {
        method:"POST", headers:h,
        body: JSON.stringify({ email, password })
      });
      return r.json();
    },
    async signOut(token) {
      await fetch(`${base}/auth/v1/logout`, {
        method:"POST", headers:{ ...h, "Authorization":`Bearer ${token}` }
      });
    },
    async getUser(token) {
      const r = await fetch(`${base}/auth/v1/user`, {
        headers:{ ...h, "Authorization":`Bearer ${token}` }
      });
      return r.json();
    },
    async getProfile(userId, token) {
      const r = await fetch(`${base}/rest/v1/user_profiles?id=eq.${userId}&select=*`, {
        headers:{ ...h, "Authorization":`Bearer ${token}`, "Prefer":"return=representation" }
      });
      const rows = await r.json();
      return Array.isArray(rows) ? rows[0] : null;
    },
    async getAllProfiles(token) {
      const r = await fetch(`${base}/rest/v1/user_profiles?select=*&order=created_at.desc`, {
        headers:{ ...h, "Authorization":`Bearer ${token}` }
      });
      return r.json();
    },
    async updateProfile(userId, updates, token) {
      const r = await fetch(`${base}/rest/v1/user_profiles?id=eq.${userId}`, {
        method:"PATCH", headers:{ ...h, "Authorization":`Bearer ${token}`, "Prefer":"return=representation" },
        body: JSON.stringify(updates)
      });
      return r.json();
    },
    saveSession(session) { try { localStorage.setItem("zt-session", JSON.stringify(session)); } catch{} },
    loadSession()       { try { const s=localStorage.getItem("zt-session"); return s?JSON.parse(s):null; } catch{ return null; } },
    clearSession()      { try { localStorage.removeItem("zt-session"); } catch{} }
  };
})();

const store = (() => {
  // ── Supabase backend (multi-user, real-time) ──────────────────────────────
  if (SUPA_URL && SUPA_ANON) {
    const headers = {
      "Content-Type": "application/json",
      "apikey": SUPA_ANON,
      "Authorization": `Bearer ${SUPA_ANON}`,
      "Prefer": "resolution=merge-duplicates"
    };
    const base = `${SUPA_URL}/rest/v1/ops_store`;

    // Wake up the Supabase free-tier database on first load
    fetch(`${base}?key=eq.__ping&select=key`, { headers })
      .then(() => { console.log("[ZT] Supabase connected"); })
      .catch(() => {});

    // Subscribe to real-time changes and reload window.storage keys
    const ws = new WebSocket(
      `${SUPA_URL.replace("https","wss")}/realtime/v1/websocket?apikey=${SUPA_ANON}&vsn=1.0.0`
    );
    ws.onopen = () => {
      ws.send(JSON.stringify({ topic:"realtime:public:ops_store", event:"phx_join", payload:{}, ref:"1" }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event === "INSERT" || msg.event === "UPDATE") {
          const { key, value } = msg.payload?.record || {};
          if (key && value) window.__ztCache = window.__ztCache || {};
          if (key) { window.__ztCache[key] = JSON.parse(value); }
        }
      } catch {}
    };

    return {
      async get(k) {
        try {
          if (window.__ztCache?.[k] !== undefined) return window.__ztCache[k];
          const r = await fetch(`${base}?key=eq.${encodeURIComponent(k)}&select=value`, { headers });
          const rows = await r.json();
          const val = rows?.[0] ? JSON.parse(rows[0].value) : null;
          window.__ztCache = window.__ztCache || {};
          window.__ztCache[k] = val;
          return val;
        } catch { return null; }
      },
      async set(k, v) {
        try {
          window.__ztCache = window.__ztCache || {};
          window.__ztCache[k] = v;
          const body = JSON.stringify({ key: k, value: JSON.stringify(v), updated_at: new Date().toISOString() });
          // Use ?on_conflict=key for upsert (required for Supabase PostgREST v12+)
          const upsertHeaders = { ...headers, "Prefer": "return=minimal,resolution=merge-duplicates" };
          const res = await fetch(`${base}?on_conflict=key`, { method: "POST", headers: upsertHeaders, body });
          if (!res.ok) {
            // Fallback: try PATCH to update existing key
            await fetch(`${base}?key=eq.${encodeURIComponent(k)}`, {
              method: "PATCH",
              headers: { ...headers, "Prefer": "return=minimal" },
              body: JSON.stringify({ value: JSON.stringify(v), updated_at: new Date().toISOString() })
            });
          }
        } catch {}
      }
    };
  }

  // ── localStorage fallback (single-user / preview mode) ───────────────────
  return {
    async get(k) { try { const v = localStorage.getItem("zt-" + k); return v ? JSON.parse(v) : null; } catch { return null; } },
    async set(k, v) { try { localStorage.setItem("zt-" + k, JSON.stringify(v)); } catch {} }
  };
})();

// ─── ZIKSATECH SEED DATA (from Ops Center spreadsheet) ───────────────────────
const BURDEN = { fica: 0.0765, futa: 0.006, futaCap: 7000, suta: 0.027, sutaCap: 9000, wc: 0.005, health: 7200, retire: 0.03, other: 0.015, hoursPerYear: 1920 };

const ROSTER_SEED = [
  { id:"r1", skills:"SAP BRIM, ABAP, BTP", projects:"BRIM Phase 3, AT&T Portal", name:"Suresh Menon",   role:"BRIM Sr Consultant", type:"FTE",        client:"AT&T",        billRate:155, util:1.0,  baseSalary:120000, revShare:0,   fixedRate:155, thirdPartySplit:0,   insurance:7200 },
  { id:"r2", skills:"SAP IS-U, S/4HANA, CPI", projects:"AT&T IS-U Migration, BRIM Phase 3", name:"Deepa Rao",      role:"SAP Functional",     type:"FTE",        client:"AT&T",        billRate:135, util:0.8,  baseSalary:98000,  revShare:0,   fixedRate:135, thirdPartySplit:0,   insurance:7200 },
  { id:"r3", skills:"ABAP, CPI, BTP", projects:"AT&T ABAP Development, BRIM Phase 3", name:"Vikram Singh",   role:"SAP Technical",      type:"FTE",        client:"AT&T",        billRate:140, util:0.8,  baseSalary:102000, revShare:0,   fixedRate:140, thirdPartySplit:0,   insurance:7200 },
  { id:"r4", skills:"SAP BRIM, S/4HANA", projects:"AT&T BRIM Implementation", name:"Ananya Krishnan",role:"BRIM Consultant",    type:"FTE",        client:"AT&T",        billRate:130, util:0.6,  baseSalary:88000,  revShare:0.6, fixedRate:130, thirdPartySplit:0,   insurance:7200 },
  { id:"r5", skills:"SAP IS-U, S/4HANA", projects:"Misc SAP Support", name:"Arun Sharma",    role:"SAP Functional",     type:"FTE",        client:"Misc",        billRate:125, util:0.2,  baseSalary:85000,  revShare:0,   fixedRate:125, thirdPartySplit:0,   insurance:7200 },
  { id:"r6", skills:"SAP BRIM, ABAP", projects:"", name:"Meena Iyer",     role:"BRIM Consultant",    type:"FTE",        client:"Bench",       billRate:130, util:0.0,  baseSalary:82000,  revShare:0,   fixedRate:130, thirdPartySplit:0,   insurance:7200 },
  { id:"r7", skills:"SAP BRIM, BTP, AWS", projects:"NTTA Integration, Naxon BRIM", name:"Rajesh Kumar",   role:"BRIM Architect",     type:"Contractor", client:"NTTA/Naxon",  billRate:185, util:0.8,  baseSalary:0,      revShare:0.7, fixedRate:140, thirdPartySplit:0.5, insurance:7200 },
  { id:"r8", skills:"SAP IS-U, CPI", projects:"Naxon IS-U Lead", name:"Priya Nair",     role:"SAP IS-U Lead",      type:"Contractor", client:"Naxon",       billRate:165, util:0.6,  baseSalary:0,      revShare:0.7, fixedRate:165, thirdPartySplit:0,   insurance:7200 },
  { id:"r9", skills:"AWS, Databricks", projects:"Databricks Pipeline, Misc Data", name:"Kiran Patel",    role:"Data Engineer",      type:"Contractor", client:"Misc",        billRate:145, util:0.4,  baseSalary:0,      revShare:0.7, fixedRate:110, thirdPartySplit:0.3, insurance:7200 },
  { id:"r10", skills:"AWS, Databricks", projects:"",name:"Sanjay Gupta",   role:"AWS Architect",      type:"Contractor", client:"Bench",       billRate:160, util:0.0,  baseSalary:0,      revShare:0.7, fixedRate:160, thirdPartySplit:0,   insurance:7200 },
];

const PIPELINE_SEED = [
  { id:"p1",  name:"Candidate A", role:"SAP BRIM Consultant",      billRate:135, status:"Offer Pending",   readyIn:"2 weeks",  source:"Referral",  skills:"SAP BRIM, IS-U" },
  { id:"p2",  name:"Candidate B", role:"SAP IS-U Senior",          billRate:155, status:"Interviewing",    readyIn:"3 weeks",  source:"LinkedIn",  skills:"SAP IS-U" },
  { id:"p3",  name:"Candidate C", role:"BRIM Architect",           billRate:175, status:"Screening",       readyIn:"4 weeks",  source:"Network",   skills:"SAP BRIM" },
  { id:"p4",  name:"Candidate D", role:"S/4HANA Consultant",       billRate:145, status:"Offer Pending",   readyIn:"1 week",   source:"Referral",  skills:"S/4HANA, FI/CO" },
  { id:"p5",  name:"Candidate E", role:"SAP Functional",           billRate:125, status:"Reference Check", readyIn:"2 weeks",  source:"Job Board", skills:"SAP FI, MM" },
  { id:"p6",  name:"Candidate F", role:"Databricks Engineer",      billRate:150, status:"Interviewing",    readyIn:"3 weeks",  source:"LinkedIn",  skills:"Databricks, AWS" },
  { id:"p7",  name:"Candidate G", role:"SAP BRIM Consultant",      billRate:130, status:"Screening",       readyIn:"4 weeks",  source:"Network",   skills:"SAP BRIM" },
  { id:"p8",  name:"Candidate H", role:"SAP Technical Lead",       billRate:160, status:"Screening",       readyIn:"5 weeks",  source:"Referral",  skills:"ABAP, BTP" },
  { id:"p9",  name:"Candidate I", role:"SAP IS-U Consultant",      billRate:135, status:"Screening",       readyIn:"4 weeks",  source:"Network",   skills:"SAP IS-U" },
  { id:"p10", name:"Candidate J", role:"AWS Solutions Architect",  billRate:165, status:"Offer Pending",   readyIn:"2 weeks",  source:"LinkedIn",  skills:"AWS, DevOps" },
];

const CLIENTS_SEED = [
  { id:"cl1", name:"AT&T",          vertical:"Telecom",           engType:"Managed Services", annualRev:1200000, consultants:4, grossMargin:0.22, health:"Green",  renewal:"2026-12-31", notes:"Core anchor. BRIM Phase 3 probe H2." },
  { id:"cl2", name:"Client B",      vertical:"Financial Services", engType:"Staff Aug",        annualRev:480000,  consultants:2, grossMargin:0.18, health:"Green",  renewal:"2026-09-30", notes:"Stable. Expand to 3 consultants." },
  { id:"cl3", name:"Client C",      vertical:"Healthcare",         engType:"Project",          annualRev:320000,  consultants:1, grossMargin:0.15, health:"Amber",  renewal:"2026-06-30", notes:"Renewal discussion needed by April." },
  { id:"cl4", name:"Client D",      vertical:"Energy",             engType:"Staff Aug",        annualRev:180000,  consultants:1, grossMargin:0.20, health:"Green",  renewal:"2026-08-31", notes:"New Q1 2026. Positive signals." },
  { id:"cl5", name:"Naxon Systems", vertical:"Internal",           engType:"Internal",         annualRev:170000,  consultants:2, grossMargin:0.12, health:"Green",  renewal:"2026-12-31", notes:"Rajesh + Priya at cost+." },
];

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// Monthly hours per consultant (from spreadsheet)
const TS_HOURS_SEED = {
  r1:[160,160,160,160,160,160,160,160,160,160,160,160],
  r2:[128,128,128,128,128,128,128,128,128,128,128,128],
  r3:[128,128,128,128,128,128,128,128,128,128,128,128],
  r4:[96,96,96,96,96,96,96,96,96,96,96,96],
  r5:[32,32,32,32,32,32,32,32,32,32,32,32],
  r6:[0,0,0,0,0,0,0,0,0,0,0,0],
  r7:[128,128,128,128,128,128,128,128,128,128,128,128],
  r8:[96,96,96,96,96,96,96,96,96,96,96,96],
  r9:[64,64,64,64,64,64,64,64,64,64,64,64],
  r10:[0,0,0,0,0,0,0,0,0,0,0,0],
};

const PL_INCOME_SEED = [
  { id:"i1", label:"AT&T — Managed Services",  category:"Consulting", months:[100000,100000,100000,100000,100000,100000,100000,100000,100000,100000,100000,100000] },
  { id:"i2", label:"Client B — Staff Aug",      category:"Consulting", months:[40000,40000,40000,40000,40000,40000,40000,40000,40000,40000,40000,40000] },
  { id:"i3", label:"Client C — Project",        category:"Consulting", months:[26667,26667,26667,26667,26667,26667,26667,0,0,0,0,0] },
  { id:"i4", label:"Client D — Staff Aug",      category:"Consulting", months:[15000,15000,15000,15000,15000,15000,15000,15000,15000,15000,15000,15000] },
  { id:"i5", label:"Naxon Systems (internal)",  category:"Internal",   months:[14167,14167,14167,14167,14167,14167,14167,14167,14167,14167,14167,14167] },
  { id:"i6", label:"Retainer — Client E (Q2+)", category:"Retainer",   months:[0,0,0,15000,15000,15000,15000,15000,15000,15000,15000,15000] },
  { id:"i7", label:"Other / Reimbursements",    category:"Misc",       months:[0,0,0,0,0,0,0,0,0,0,0,0] },
];

const PL_EXPENSE_SEED = [
  { id:"e1",  label:"Salaries — FTE (6 staff)",        category:"Payroll",    months:[47917,47917,47917,47917,47917,47917,47917,47917,47917,47917,47917,47917] },
  { id:"e2",  label:"Employer Taxes (FICA/FUTA/SUTA)", category:"Payroll",    months:[5500,5500,5500,5500,5500,5500,5500,5500,5500,5500,5500,5500] },
  { id:"e3",  label:"Health / Dental / Vision",         category:"Benefits",   months:[3600,3600,3600,3600,3600,3600,3600,3600,3600,3600,3600,3600] },
  { id:"e4",  label:"401(k) Employer Match",            category:"Benefits",   months:[1437,1437,1437,1437,1437,1437,1437,1437,1437,1437,1437,1437] },
  { id:"e5",  label:"Contractor Payments",              category:"Delivery",   months:[29000,29000,29000,29000,29000,29000,29000,29000,29000,29000,29000,29000] },
  { id:"e6",  label:"Performance Bonuses",              category:"Incentives", months:[0,0,0,0,0,0,0,0,0,0,0,0] },
  { id:"e7",  label:"3rd Party Referral Fees",          category:"Delivery",   months:[3500,3500,3500,3500,3500,3500,3500,3500,3500,3500,3500,3500] },
  { id:"e8",  label:"Software & SaaS Tools",            category:"OpEx",       months:[2200,2200,2200,2200,2200,2200,2200,2200,2200,2200,2200,2200] },
  { id:"e9",  label:"Office / Co-working",              category:"OpEx",       months:[1800,1800,1800,1800,1800,1800,1800,1800,1800,1800,1800,1800] },
  { id:"e10", label:"Marketing & BD",                   category:"Growth",     months:[1500,1500,2000,2000,2000,2000,1500,1500,2000,2000,2000,2000] },
  { id:"e11", label:"Travel & Meals",                   category:"OpEx",       months:[800,800,1200,1200,1200,800,800,800,1200,1200,800,800] },
  { id:"e12", label:"Professional Services",            category:"OpEx",       months:[1500,0,0,1500,0,0,1500,0,0,1500,0,0] },
  { id:"e13", label:"Insurance (E&O / GL)",             category:"OpEx",       months:[600,600,600,600,600,600,600,600,600,600,600,600] },
  { id:"e14", label:"Miscellaneous / Buffer",           category:"OpEx",       months:[0,0,0,0,0,0,0,0,0,0,0,0] },
];

const EBITDA_LEVERS_SEED = [
  { id:"lv1", done:false, lever:"Fix bench — reduce 0% util FTEs to ≤2",        revImpact:120000, ebitdaImpact:96000,  effort:"Low",    timeframe:"Q1 2026" },
  { id:"lv2", done:false, lever:"Hire 4 consultants (80% util, $140/hr avg)",    revImpact:860000, ebitdaImpact:172000, effort:"Medium", timeframe:"Q2 2026" },
  { id:"lv3", done:false, lever:"Add 2 retainer clients at $15K/mo",             revImpact:360000, ebitdaImpact:108000, effort:"Medium", timeframe:"Q3 2026" },
  { id:"lv4", done:false, lever:"Hire delivery manager (free Manju for sales)",  revImpact:200000, ebitdaImpact:60000,  effort:"Medium", timeframe:"Q2 2026" },
  { id:"lv5", done:false, lever:"Renegotiate AT&T rate +$5/hr",                  revImpact:38400,  ebitdaImpact:38400,  effort:"Low",    timeframe:"Q1 2026" },
  { id:"lv6", done:false, lever:"Move 2 contractors to FTE (lower cost)",        revImpact:0,      ebitdaImpact:55000,  effort:"Low",    timeframe:"Q2 2026" },
  { id:"lv7", done:false, lever:"AI ops — save 20% overhead time",               revImpact:0,      ebitdaImpact:72000,  effort:"Low",    timeframe:"Q1 2026" },
  { id:"lv8", done:false, lever:"Naxon overflow billing at cost+20%",            revImpact:150000, ebitdaImpact:30000,  effort:"Low",    timeframe:"Ongoing" },
];

const FB_INVOICES_SEED = [
  { id:"FB-2601", clientId:"cl1", date:"2026-01-31", due:"2026-02-28", status:"paid",    amount:100000, desc:"AT&T Managed Services — January 2026" },
  { id:"FB-2602", clientId:"cl2", date:"2026-01-31", due:"2026-02-28", status:"paid",    amount:40000,  desc:"Client B Staff Augmentation — January 2026" },
  { id:"FB-2603", clientId:"cl1", date:"2026-02-28", due:"2026-03-30", status:"paid",    amount:100000, desc:"AT&T Managed Services — February 2026" },
  { id:"FB-2604", clientId:"cl2", date:"2026-02-28", due:"2026-03-30", status:"paid",    amount:40000,  desc:"Client B Staff Augmentation — February 2026" },
  { id:"FB-2605", clientId:"cl1", date:"2026-03-31", due:"2026-04-30", status:"sent",    amount:100000, desc:"AT&T Managed Services — March 2026" },
  { id:"FB-2606", clientId:"cl2", date:"2026-03-31", due:"2026-04-30", status:"sent",    amount:40000,  desc:"Client B Staff Augmentation — March 2026" },
  { id:"FB-2607", clientId:"cl3", date:"2026-03-31", due:"2026-04-30", status:"sent",    amount:26667,  desc:"Client C Project Delivery — March 2026" },
  { id:"FB-2608", clientId:"cl4", date:"2026-03-31", due:"2026-04-30", status:"draft",   amount:15000,  desc:"Client D Staff Augmentation — March 2026" },
  { id:"FB-2609", clientId:"cl5", date:"2026-03-31", due:"2026-04-30", status:"draft",   amount:14167,  desc:"Naxon Systems Internal Billing — March 2026" },
];

// ADP Payroll runs
const ADP_RUNS_SEED = [
  { id:"adp1", period:"Jan 2026", payDate:"2026-01-31", status:"processed", gross:47917, taxes:5500, benefits:5037, net:37380, employees:6 },
  { id:"adp2", period:"Feb 2026", payDate:"2026-02-28", status:"processed", gross:47917, taxes:5500, benefits:5037, net:37380, employees:6 },
  { id:"adp3", period:"Mar 2026", payDate:"2026-03-31", status:"pending",   gross:47917, taxes:5500, benefits:5037, net:37380, employees:6 },
];

// ─── FINANCE MODULE SEED DATA ─────────────────────────────────────────────────
const FIN_INVOICES_SEED = [
  { id:"INV-001", clientId:"cl1", projectName:"AT&T Managed Services", period:"Jan 2026",
    issueDate:"2026-01-31", dueDate:"2026-02-28", status:"paid", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"BRIM Sr Consultant — Suresh Menon", qty:160, rate:155, amount:24800 },
      { id:"l2", desc:"SAP Functional — Deepa Rao", qty:128, rate:135, amount:17280 },
      { id:"l3", desc:"SAP Technical — Vikram Singh", qty:128, rate:140, amount:17920 },
      { id:"l4", desc:"BRIM Consultant — Ananya Krishnan", qty:96, rate:130, amount:12480 },
      { id:"l5", desc:"Management Fee", qty:1, rate:27520, amount:27520 },
    ], notes:"Net 30. PO# ATT-2026-001." },
  { id:"INV-002", clientId:"cl2", projectName:"Client B Staff Augmentation", period:"Jan 2026",
    issueDate:"2026-01-31", dueDate:"2026-02-28", status:"paid", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"SAP Functional — Arun Sharma", qty:32, rate:125, amount:4000 },
      { id:"l2", desc:"Data Engineer — Kiran Patel", qty:64, rate:145, amount:9280 },
      { id:"l3", desc:"Management & Overhead", qty:1, rate:26720, amount:26720 },
    ], notes:"" },
  { id:"INV-003", clientId:"cl1", projectName:"AT&T Managed Services", period:"Feb 2026",
    issueDate:"2026-02-28", dueDate:"2026-03-30", status:"paid", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"BRIM Sr Consultant — Suresh Menon", qty:160, rate:155, amount:24800 },
      { id:"l2", desc:"SAP Functional — Deepa Rao", qty:128, rate:135, amount:17280 },
      { id:"l3", desc:"SAP Technical — Vikram Singh", qty:128, rate:140, amount:17920 },
      { id:"l4", desc:"BRIM Consultant — Ananya Krishnan", qty:96, rate:130, amount:12480 },
      { id:"l5", desc:"Management Fee", qty:1, rate:27520, amount:27520 },
    ], notes:"" },
  { id:"INV-004", clientId:"cl5", projectName:"Naxon Systems Internal", period:"Feb 2026",
    issueDate:"2026-02-28", dueDate:"2026-03-30", status:"paid", paymentTerms:"Net 15",
    lines:[
      { id:"l1", desc:"BRIM Architect — Rajesh Kumar", qty:128, rate:185, amount:23680 },
      { id:"l2", desc:"SAP IS-U Lead — Priya Nair", qty:96, rate:165, amount:15840 },
    ], notes:"Internal billing at cost+." },
  { id:"INV-005", clientId:"cl1", projectName:"AT&T Managed Services", period:"Mar 2026",
    issueDate:"2026-03-31", dueDate:"2026-04-30", status:"sent", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"BRIM Sr Consultant — Suresh Menon", qty:160, rate:155, amount:24800 },
      { id:"l2", desc:"SAP Functional — Deepa Rao", qty:128, rate:135, amount:17280 },
      { id:"l3", desc:"SAP Technical — Vikram Singh", qty:128, rate:140, amount:17920 },
      { id:"l4", desc:"BRIM Consultant — Ananya Krishnan", qty:96, rate:130, amount:12480 },
      { id:"l5", desc:"Management Fee", qty:1, rate:27520, amount:27520 },
    ], notes:"" },
  { id:"INV-006", clientId:"cl2", projectName:"Client B Staff Augmentation", period:"Mar 2026",
    issueDate:"2026-03-31", dueDate:"2026-04-30", status:"sent", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"SAP Functional — Arun Sharma", qty:32, rate:125, amount:4000 },
      { id:"l2", desc:"Data Engineer — Kiran Patel", qty:64, rate:145, amount:9280 },
      { id:"l3", desc:"Management & Overhead", qty:1, rate:26720, amount:26720 },
    ], notes:"" },
  { id:"INV-007", clientId:"cl3", projectName:"Client C Healthcare Project", period:"Mar 2026",
    issueDate:"2026-03-31", dueDate:"2026-04-30", status:"overdue", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"Project Delivery — March milestone", qty:1, rate:26667, amount:26667 },
    ], notes:"Renewal discussion pending. Follow up on payment." },
  { id:"INV-008", clientId:"cl4", projectName:"Client D Staff Augmentation", period:"Mar 2026",
    issueDate:"2026-03-31", dueDate:"2026-04-30", status:"draft", paymentTerms:"Net 30",
    lines:[
      { id:"l1", desc:"SAP Functional Consulting — March 2026", qty:1, rate:15000, amount:15000 },
    ], notes:"" },
];

const FIN_PAYMENTS_SEED = [
  { id:"pay1", invoiceId:"INV-001", clientId:"cl1", date:"2026-02-25", amount:100000, method:"ACH", ref:"ACH-ATT-0225", notes:"Full payment" },
  { id:"pay2", invoiceId:"INV-002", clientId:"cl2", date:"2026-02-26", amount:40000,  method:"Wire", ref:"WIRE-CLB-0226", notes:"" },
  { id:"pay3", invoiceId:"INV-003", clientId:"cl1", date:"2026-03-27", amount:100000, method:"ACH", ref:"ACH-ATT-0327", notes:"Full payment" },
  { id:"pay4", invoiceId:"INV-004", clientId:"cl5", date:"2026-03-10", amount:39520,  method:"Internal", ref:"INT-NAX-0310", notes:"Internal transfer" },
];

const FIN_EXPENSES_SEED = [
  { id:"exp1", consultantId:"r1", clientId:"cl1", category:"Travel", date:"2026-03-05", amount:480,  desc:"Flight DFW→NYC for AT&T onsite",    status:"approved",  reimbursable:true,  receipt:true },
  { id:"exp2", consultantId:"r2", clientId:"cl1", category:"Travel", date:"2026-03-06", amount:220,  desc:"Hotel 2 nights AT&T onsite",         status:"approved",  reimbursable:true,  receipt:true },
  { id:"exp3", consultantId:"r7", clientId:"cl5", category:"Software", date:"2026-03-01", amount:150, desc:"Postman Pro subscription",           status:"approved",  reimbursable:false, receipt:true },
  { id:"exp4", consultantId:"r3", clientId:"cl1", category:"Meals",  date:"2026-03-12", amount:95,   desc:"Client dinner — AT&T team",          status:"pending",   reimbursable:true,  receipt:true },
  { id:"exp5", consultantId:"r5", clientId:"cl2", category:"Travel", date:"2026-03-18", amount:310,  desc:"Travel to Client B site",            status:"pending",   reimbursable:true,  receipt:false },
  { id:"exp6", consultantId:"r8", clientId:"cl5", category:"Training", date:"2026-02-20", amount:599, desc:"SAP IS-U certification course",     status:"approved",  reimbursable:false, receipt:true },
  { id:"exp7", consultantId:"r1", clientId:"cl1", category:"Travel", date:"2026-03-22", amount:180,  desc:"Uber/ground transport AT&T week",   status:"rejected",  reimbursable:true,  receipt:false },
];

// ─── SALES CRM SEED DATA ─────────────────────────────────────────────────────
const CRM_ACCOUNTS_SEED = [
  { id:"acc1", name:"AT&T",              industry:"Telecom",          type:"customer",   website:"att.com",         phone:"214-555-1000", address:"Dallas, TX",      annualRevPotential:1400000, owner:"Manju",   health:"green",  notes:"Core anchor. BRIM Phase 3 upsell in H2. Renewal Dec 2026." },
  { id:"acc2", name:"Client B",          industry:"Financial Services",type:"customer",  website:"clientb.com",     phone:"972-555-2000", address:"Irving, TX",      annualRevPotential:600000,  owner:"Manju",   health:"green",  notes:"Stable. Expand to 3 consultants discussion started." },
  { id:"acc3", name:"Client C",          industry:"Healthcare",        type:"at-risk",   website:"clientc.com",     phone:"817-555-3000", address:"Fort Worth, TX",  annualRevPotential:320000,  owner:"Manju",   health:"amber",  notes:"Renewal June 2026. Need exec meeting by April." },
  { id:"acc4", name:"Client D",          industry:"Energy",            type:"customer",  website:"clientd.com",     phone:"469-555-4000", address:"Plano, TX",       annualRevPotential:220000,  owner:"Manju",   health:"green",  notes:"New Q1 2026. Positive signals. Expansion likely H2." },
  { id:"acc5", name:"Naxon Systems",     industry:"Technology",        type:"partner",   website:"naxon.com",       phone:"972-555-5000", address:"Richardson, TX",  annualRevPotential:250000,  owner:"Manju",   health:"green",  notes:"Overflow partner. Rajesh + Priya billing at cost+." },
  { id:"acc6", name:"Verizon",           industry:"Telecom",           type:"prospect",  website:"verizon.com",     phone:"212-555-6000", address:"New York, NY",    annualRevPotential:800000,  owner:"Manju",   health:"green",  notes:"Warm intro via AT&T contact. SAP BRIM expansion planned." },
  { id:"acc7", name:"Oncor Electric",    industry:"Energy",            type:"prospect",  website:"oncor.com",       phone:"214-555-7000", address:"Dallas, TX",      annualRevPotential:500000,  owner:"Manju",   health:"green",  notes:"SAP IS-U implementation RFP expected Q2 2026." },
  { id:"acc8", name:"CHRISTUS Health",   industry:"Healthcare",        type:"prospect",  website:"christushealth.org",phone:"214-555-8000",address:"Irving, TX",      annualRevPotential:350000,  owner:"Manju",   health:"green",  notes:"S/4HANA migration interest. Initial call scheduled." },
  { id:"acc9", name:"Toyota Connected",  industry:"Automotive",        type:"prospect",  website:"toyotaconnected.com",phone:"469-555-9000",address:"Plano, TX",     annualRevPotential:420000,  owner:"Manju",   health:"green",  notes:"Data engineering + AWS opportunity. Kiran fit." },
  { id:"acc10",name:"NTTA",              industry:"Government",        type:"customer",  website:"ntta.org",        phone:"972-555-1010", address:"Dallas, TX",      annualRevPotential:180000,  owner:"Manju",   health:"green",  notes:"Rajesh placed. Billing at $185/hr. Stable." },
];

const CRM_CONTACTS_SEED = [
  { id:"con1", accountId:"acc1", name:"James Wright",    title:"VP SAP Delivery",       email:"j.wright@att.com",    phone:"214-555-1001", linkedIn:"", isPrimary:true,  notes:"Main decision maker. Responsive. Quarterly calls." },
  { id:"con2", accountId:"acc1", name:"Sarah Chen",      title:"SAP Program Manager",   email:"s.chen@att.com",      phone:"214-555-1002", linkedIn:"", isPrimary:false, notes:"Day-to-day PM. Manages Suresh relationship." },
  { id:"con3", accountId:"acc2", name:"Mark Davis",      title:"Director IT",           email:"m.davis@clientb.com", phone:"972-555-2001", linkedIn:"", isPrimary:true,  notes:"Controls budget. Expansion approval needed from him." },
  { id:"con4", accountId:"acc3", name:"Linda Park",      title:"CIO",                   email:"l.park@clientc.com",  phone:"817-555-3001", linkedIn:"", isPrimary:true,  notes:"Exec sponsor. Renewal decision comes from her." },
  { id:"con5", accountId:"acc6", name:"Robert Kim",      title:"SAP Center of Excellence Lead", email:"r.kim@verizon.com",phone:"212-555-6001",linkedIn:"", isPrimary:true, notes:"AT&T connection intro'd us. Very warm. Schedule follow-up." },
  { id:"con6", accountId:"acc7", name:"Amanda Torres",   title:"IT Procurement Lead",   email:"a.torres@oncor.com",  phone:"214-555-7001", linkedIn:"", isPrimary:true,  notes:"Driving RFP. Timeline Q2 2026." },
  { id:"con7", accountId:"acc8", name:"David Nguyen",    title:"VP Technology",         email:"d.nguyen@christus.com",phone:"214-555-8001",linkedIn:"", isPrimary:true,  notes:"Initial call went well. S/4HANA budget confirmed." },
  { id:"con8", accountId:"acc9", name:"Priya Rajan",     title:"Head of Data Engineering",email:"p.rajan@toyota.com",phone:"469-555-9001", linkedIn:"", isPrimary:true, notes:"Python/Databricks heavy. Kiran Patel strong fit." },
  { id:"con9", accountId:"acc4", name:"Tom Bradley",     title:"IT Director",           email:"t.bradley@clientd.com",phone:"469-555-4001",linkedIn:"", isPrimary:true,  notes:"New contact Q1. Positive on expansion." },
];

const CRM_DEALS_SEED = [
  { id:"deal1", accountId:"acc1", name:"AT&T BRIM Phase 3 Expansion",   stage:"proposal",     value:480000, closeDate:"2026-06-30", owner:"Manju", probability:70, type:"expansion",   notes:"Upsell 2 additional BRIM consultants for Phase 3. SOW in review.", nextStep:"Follow up on SOW redlines by Mar 20." },
  { id:"deal2", accountId:"acc6", name:"Verizon SAP BRIM Initial",      stage:"qualified",    value:800000, closeDate:"2026-09-30", owner:"Manju", probability:40, type:"new",         notes:"Intro via AT&T. Need to understand their BRIM roadmap. Deck sent.", nextStep:"Discovery call with Robert Kim — schedule for Apr." },
  { id:"deal3", accountId:"acc7", name:"Oncor IS-U Implementation",     stage:"prospecting",  value:500000, closeDate:"2026-12-31", owner:"Manju", probability:25, type:"new",         notes:"RFP expected Q2. Building relationship with Amanda Torres.", nextStep:"RFP response prep. Get Deepa + team on it." },
  { id:"deal4", accountId:"acc2", name:"Client B Headcount Expansion",  stage:"negotiation",  value:120000, closeDate:"2026-04-30", owner:"Manju", probability:80, type:"expansion",   notes:"Adding 1 SAP Functional (Arun or candidate). Mark Davis approved in principle.", nextStep:"Send updated SOW with rate card by Mar 15." },
  { id:"deal5", accountId:"acc8", name:"CHRISTUS S/4HANA Assessment",   stage:"qualified",    value:350000, closeDate:"2026-10-31", owner:"Manju", probability:35, type:"new",         notes:"Budget confirmed. Assessment phase first, then impl. Good cultural fit.", nextStep:"Proposal deck for assessment phase — due Mar 25." },
  { id:"deal6", accountId:"acc9", name:"Toyota Data Pipeline Build",    stage:"prospecting",  value:420000, closeDate:"2026-11-30", owner:"Manju", probability:20, type:"new",         notes:"Kiran + Fatima fit. Need to position Databricks + AWS capability.", nextStep:"Capability deck + case studies to Priya Rajan." },
  { id:"deal7", accountId:"acc3", name:"Client C Contract Renewal",     stage:"negotiation",  value:320000, closeDate:"2026-06-30", owner:"Manju", probability:60, type:"renewal",     notes:"Renewal at risk — need exec touchpoint. Rate discussion expected.", nextStep:"Exec meeting with Linda Park — schedule ASAP." },
  { id:"deal8", accountId:"acc4", name:"Client D Phase 2 Expansion",   stage:"proposal",     value:100000, closeDate:"2026-08-31", owner:"Manju", probability:65, type:"expansion",   notes:"Tom Bradley keen on adding cloud architect. Sanjay Gupta fit when active.", nextStep:"Proposal with Sanjay profile — send by Mar 18." },
];

const CRM_ACTIVITIES_SEED = [
  { id:"act1",  dealId:"deal1", accountId:"acc1", contactId:"con1", type:"email",   date:"2026-03-10", subject:"SOW Redlines — AT&T BRIM Phase 3",        notes:"James sent redlines on Section 4. Reviewing with legal. Will respond by Mar 20.", completed:true  },
  { id:"act2",  dealId:"deal1", accountId:"acc1", contactId:"con2", type:"meeting", date:"2026-03-05", subject:"Weekly sync — BRIM Phase 3 planning",      notes:"Discussed consultant requirements. 2 more BRIM resources needed from Apr 1.", completed:true  },
  { id:"act3",  dealId:"deal4", accountId:"acc2", contactId:"con3", type:"call",    date:"2026-03-08", subject:"Rate card discussion",                      notes:"Mark happy with $130/hr for SAP Functional. Wants SOW by Mar 15.", completed:true  },
  { id:"act4",  dealId:"deal2", accountId:"acc6", contactId:"con5", type:"email",   date:"2026-03-06", subject:"BRIM capability deck sent",                 notes:"Sent 15-slide deck. Robert acknowledged. Follow up in 2 weeks.", completed:true  },
  { id:"act5",  dealId:"deal7", accountId:"acc3", contactId:"con4", type:"call",    date:"2026-03-09", subject:"Renewal check-in with Linda Park",          notes:"Brief call. She wants exec meeting before Apr. Rate increase concern flagged.", completed:true  },
  { id:"act6",  dealId:"deal1", accountId:"acc1", contactId:"con1", type:"meeting", date:"2026-03-20", subject:"SOW redline response meeting",              notes:"Review legal changes to Phase 3 SOW.", completed:false },
  { id:"act7",  dealId:"deal4", accountId:"acc2", contactId:"con3", type:"email",   date:"2026-03-15", subject:"Updated SOW — Client B expansion",          notes:"Send final SOW with rate card and start date.", completed:false },
  { id:"act8",  dealId:"deal5", accountId:"acc8", contactId:"con7", type:"meeting", date:"2026-03-25", subject:"CHRISTUS assessment proposal review",       notes:"Walk through scope + pricing for S/4HANA assessment.", completed:false },
  { id:"act9",  dealId:"deal7", accountId:"acc3", contactId:"con4", type:"meeting", date:"2026-04-05", subject:"Client C exec renewal meeting",             notes:"Exec-level renewal discussion with CIO Linda Park.", completed:false },
  { id:"act10", dealId:"deal8", accountId:"acc4", contactId:"con9", type:"email",   date:"2026-03-18", subject:"Client D Phase 2 proposal",                notes:"Send Sanjay profile + cloud arch expansion proposal.", completed:false },
  { id:"act11", dealId:"deal2", accountId:"acc6", contactId:"con5", type:"call",    date:"2026-04-10", subject:"Verizon discovery call",                   notes:"Deep-dive on BRIM roadmap and resourcing needs.", completed:false },
  { id:"act12", dealId:"deal3", accountId:"acc7", contactId:"con6", type:"meeting", date:"2026-04-15", subject:"Oncor RFP kickoff",                        notes:"RFP briefing + Q&A with procurement team.", completed:false },
];


// ═══════════════════════════════════════════════════════════════════════════════
// ORG & ACCESS SEED DATA
// ═══════════════════════════════════════════════════════════════════════════════

// Module registry — all controllable modules
const ALL_MODULES = [
  { id:"home",       label:"Home",                icon:ICONS.dash,     group:"Overview"    },
    { id:"home",       label:"Home",                icon:ICONS.dash,     group:"Overview"    },
    { id:"dashboard",  label:"Executive Dashboard", group:"Overview"    },
  { id:"notifications",label:"Notifications",         group:"Overview"    },
  { id:"auditlog",    label:"Audit Log",             group:"Overview"    },
  { id:"pdfexport",   label:"PDF Export",            group:"Overview"    },
  { id:"settings",    label:"Settings",               group:"Overview"    },
  { id:"proposals",   label:"Proposals",             group:"Sales"       },
  { id:"emailtpl",    label:"Email Templates",        group:"Sales"       },
  { id:"taxcal",      label:"Tax Calendar",           group:"Finance"     },
  { id:"benefits",    label:"Benefits Tracker",       group:"Finance"     },
  { id:"reports",     label:"Report Builder",         group:"Overview"    },
  { id:"portal",      label:"Client Portal",          group:"Overview"    },
  { id:"glexport",    label:"QB GL Export",           group:"Finance"     },
  { id:"esign",       label:"E-Signature",            group:"Overview"    },
  { id:"capacity",    label:"Capacity Planner",       group:"Delivery"    },
  { id:"budget",      label:"Budget vs. Actual",      group:"Finance"     },
  { id:"onboarding",  label:"Onboarding",             group:"Hiring"      },
  { id:"crm",        label:"Sales CRM",            group:"Sales"      },
  { id:"contracts",  label:"Contracts & SOW",      group:"Sales"      },
  { id:"projects",   label:"Project Tracker",       group:"Delivery"   },
  { id:"profitability",label:"Project P&L",           group:"Delivery"   },
  { id:"roster",     label:"Team Roster",           group:"Delivery"   },
  { id:"timesheet",  label:"Timesheet",             group:"Delivery"   },
  { id:"clients",    label:"Client Portfolio",      group:"Delivery"   },
  { id:"ebitda",     label:"EBITDA Optimizer",      group:"Delivery"   },
  { id:"pl",         label:"P&L / Income",          group:"Finance"    },
  { id:"finance",    label:"Finance Module",        group:"Finance"    },
  { id:"vendors",     label:"Vendors & AP",          group:"Finance"    },
  { id:"adp",        label:"ADP Payroll",           group:"Finance"    },
  { id:"cashflow",   label:"Cash Flow Forecast",    group:"Finance"    },
  { id:"freshbooks", label:"FreshBooks",            group:"Finance"    },
  { id:"pipeline",   label:"Hiring Pipeline",       group:"Hiring"     },
  { id:"recruiting", label:"Recruiting",            group:"Hiring"     },
  { id:"pto",        label:"PTO & Leave",           group:"Compliance" },
  { id:"compliance", label:"Compliance",            group:"Compliance" },
];

// Role templates — define default permissions
const ROLE_TEMPLATES = {
  owner: {
    label:"Owner / CEO", color:"#a78bfa", bg:"#1a1a2e",
    perms: Object.fromEntries(ALL_MODULES.map(m=>[m.id,"full"])),
  },
  finance_mgr: {
    label:"Finance Manager", color:"#34d399", bg:"#021f14",
    perms: { dashboard:"view", crm:"view", contracts:"view", projects:"view", roster:"view", timesheet:"view", clients:"view", ebitda:"none", pl:"full", finance:"full", adp:"full", freshbooks:"full", pipeline:"none", recruiting:"none", compliance:"view" },
  },
  delivery_lead: {
    label:"Delivery Lead", color:"#38bdf8", bg:"#0c2340",
    perms: { dashboard:"view", crm:"view", contracts:"view", projects:"full", roster:"full", timesheet:"full", clients:"full", ebitda:"view", pl:"none", finance:"none", adp:"none", freshbooks:"none", pipeline:"view", recruiting:"view", compliance:"full" },
  },
  recruiter: {
    label:"Recruiter / HR", color:"#f59e0b", bg:"#1a1005",
    perms: { dashboard:"view", crm:"none", contracts:"none", projects:"view", roster:"view", timesheet:"none", clients:"none", ebitda:"none", pl:"none", finance:"none", adp:"none", freshbooks:"none", pipeline:"full", recruiting:"full", compliance:"view" },
  },
  consultant: {
    label:"Consultant (FTE)", color:"#94a3b8", bg:"#0a1626",
    perms: { dashboard:"view", crm:"none", contracts:"none", projects:"view", roster:"none", timesheet:"view", clients:"none", ebitda:"none", pl:"none", finance:"none", adp:"none", freshbooks:"none", pipeline:"none", recruiting:"none", compliance:"none" },
  },
  contractor: {
    label:"Contractor", color:"#64748b", bg:"#070b14",
    perms: { dashboard:"none", crm:"none", contracts:"none", projects:"view", roster:"none", timesheet:"view", clients:"none", ebitda:"none", pl:"none", finance:"none", adp:"none", freshbooks:"none", pipeline:"none", recruiting:"none", compliance:"none" },
  },
};

const ORG_MEMBERS_SEED = [
  { id:"org1",  rosterId:"",    name:"Manju",          title:"Owner / CEO",               email:"manju@ziksatech.com",         phone:"",            reportsTo:"",     role:"owner",        active:true, customPerms:{} },
  { id:"org2",  rosterId:"r1",  name:"Suresh Menon",   title:"Sr. Consultant / Delivery Lead", email:"suresh@ziksatech.com",   phone:"",            reportsTo:"org1", role:"delivery_lead",active:true, customPerms:{} },
  { id:"org3",  rosterId:"r2",  name:"Deepa Rao",      title:"SAP Functional Consultant",  email:"deepa@ziksatech.com",         phone:"",            reportsTo:"org2", role:"consultant",   active:true, customPerms:{} },
  { id:"org4",  rosterId:"r3",  name:"Vikram Singh",   title:"SAP Technical Consultant",   email:"vikram@ziksatech.com",        phone:"",            reportsTo:"org2", role:"consultant",   active:true, customPerms:{} },
  { id:"org5",  rosterId:"r4",  name:"Ananya Krishnan",title:"BRIM Consultant",            email:"ananya@ziksatech.com",        phone:"",            reportsTo:"org2", role:"consultant",   active:true, customPerms:{} },
  { id:"org6",  rosterId:"r5",  name:"Arun Sharma",    title:"SAP Functional Consultant",  email:"arun@ziksatech.com",          phone:"",            reportsTo:"org2", role:"consultant",   active:true, customPerms:{} },
  { id:"org7",  rosterId:"r6",  name:"Meena Iyer",     title:"BRIM Consultant",            email:"meena@ziksatech.com",         phone:"",            reportsTo:"org2", role:"consultant",   active:true, customPerms:{} },
  { id:"org8",  rosterId:"r7",  name:"Rajesh Kumar",   title:"BRIM Architect (Contractor)", email:"rajesh@ziksatech.com",       phone:"",            reportsTo:"org1", role:"contractor",   active:true, customPerms:{} },
  { id:"org9",  rosterId:"r8",  name:"Priya Nair",     title:"SAP IS-U Lead (Contractor)", email:"priya@ziksatech.com",         phone:"",            reportsTo:"org8", role:"contractor",   active:true, customPerms:{} },
  { id:"org10", rosterId:"r9",  name:"Kiran Patel",    title:"Data Engineer (Contractor)", email:"kiran@ziksatech.com",         phone:"",            reportsTo:"org8", role:"contractor",   active:true, customPerms:{} },
  { id:"org11", rosterId:"r10", name:"Sanjay Gupta",   title:"AWS Architect (Contractor)", email:"sanjay@ziksatech.com",        phone:"",            reportsTo:"org8", role:"contractor",   active:true, customPerms:{} },
];




// ─── VENDOR / AP SEED DATA ────────────────────────────────────────────────────
const VENDOR_STATUS_COLOR  = { active:"#34d399", inactive:"#475569", onboarding:"#f59e0b" };
const VENDOR_TYPE_COLOR    = { subcontractor:"#38bdf8", staffing:"#a78bfa", software:"#f59e0b", office:"#64748b", legal:"#f87171", insurance:"#34d399" };
const AP_STATUS_COLOR      = { draft:"#475569", pending:"#f59e0b", approved:"#38bdf8", paid:"#34d399", overdue:"#f87171", voided:"#1e3a5f" };
const AP_STATUS_BG         = { draft:"#0a1626", pending:"#1a1005", approved:"#0c2340", paid:"#021f14", overdue:"#1a0808", voided:"#070b14" };
const AP_STATUS_LABEL      = { draft:"Draft", pending:"Pending Approval", approved:"Approved", paid:"Paid", overdue:"Overdue", voided:"Voided" };
const W9_STATUS_COLOR      = { received:"#34d399", pending:"#f59e0b", missing:"#f87171" };

const VENDORS_SEED = [
  { id:"v1",  name:"Rajesh Kumar",       type:"subcontractor", taxId:"***-**-7821", w9Status:"received", w9Date:"2026-01-15", contact:"rajesh@rajeshkumar.com",    phone:"214-555-0141", address:"Frisco, TX", paymentTerms:"Net 30", paymentMethod:"ACH", accountNotes:"BRIM Architect — 70% rev share on NTTA & Naxon projects", ytdPaid:42560,  ytdThreshold:600, needs1099:true,  active:true  },
  { id:"v2",  name:"Priya Nair",         type:"subcontractor", taxId:"***-**-3342", w9Status:"received", w9Date:"2026-01-15", contact:"priya@priyaconsulting.com",  phone:"469-555-0188", address:"Plano, TX",  paymentTerms:"Net 30", paymentMethod:"ACH", accountNotes:"SAP IS-U Lead — 70% rev share on Naxon project",        ytdPaid:18480,  ytdThreshold:600, needs1099:true,  active:true  },
  { id:"v3",  name:"Kiran Patel",        type:"subcontractor", taxId:"***-**-9910", w9Status:"received", w9Date:"2026-01-20", contact:"kiran@kirandata.io",         phone:"972-555-0227", address:"Irving, TX", paymentTerms:"Net 30", paymentMethod:"ACH", accountNotes:"Data Engineer — 70% rev share. OPT expires May 15 — H-1B filing by Apr 1!", ytdPaid:10192, ytdThreshold:600, needs1099:true,  active:true  },
  { id:"v4",  name:"Sanjay Gupta",       type:"subcontractor", taxId:"",            w9Status:"missing",  w9Date:"",          contact:"sanjay@sanjaycloud.com",     phone:"817-555-0093", address:"Grapevine, TX", paymentTerms:"Net 30", paymentMethod:"Check", accountNotes:"AWS Architect — currently on bench. W-9 outstanding!",  ytdPaid:0,      ytdThreshold:600, needs1099:true,  active:true  },
  { id:"v5",  name:"Microsoft Azure",    type:"software",      taxId:"91-1144442",  w9Status:"received", w9Date:"2025-03-01", contact:"billing@microsoft.com",      phone:"",             address:"Redmond, WA", paymentTerms:"Net 30", paymentMethod:"CC",   accountNotes:"Azure subscription — shared dev/staging environments",  ytdPaid:8400,   ytdThreshold:600, needs1099:false, active:true  },
  { id:"v6",  name:"Regus Frisco",       type:"office",        taxId:"47-3829104",  w9Status:"received", w9Date:"2025-06-01", contact:"frisco@regus.com",           phone:"972-555-0300", address:"Frisco, TX",  paymentTerms:"Due on receipt", paymentMethod:"ACH", accountNotes:"Office suite — 3 private offices, shared conference room", ytdPaid:7500,  ytdThreshold:600, needs1099:true,  active:true  },
  { id:"v7",  name:"Littler Mendelson",  type:"legal",         taxId:"94-1255555",  w9Status:"received", w9Date:"2025-01-10", contact:"billing@littler.com",        phone:"",             address:"Dallas, TX",  paymentTerms:"Net 15", paymentMethod:"Wire", accountNotes:"Immigration & employment law — H-1B filings, MSA review", ytdPaid:12500,  ytdThreshold:600, needs1099:true,  active:true  },
  { id:"v8",  name:"Travelers Insurance",type:"insurance",     taxId:"06-0132120",  w9Status:"received", w9Date:"2025-08-01", contact:"billing@travelers.com",      phone:"",             address:"Hartford, CT", paymentTerms:"Annual", paymentMethod:"ACH", accountNotes:"E&O, GL, Workers Comp — renewal August 2026",           ytdPaid:18600,  ytdThreshold:600, needs1099:false, active:true  },
];

const AP_INVOICES_SEED = [
  // Subcontractor — January (paid)
  { id:"ap1",  vendorId:"v1", number:"RKUMAR-2601", description:"NTTA Integration consulting — Jan 2026 (128h @ $140)",            amount:17920, status:"paid",    issueDate:"2026-02-01", dueDate:"2026-03-03", paidDate:"2026-02-28", projectId:"proj5", poNumber:"PO-2601", category:"subcontractor", notes:"" },
  { id:"ap2",  vendorId:"v2", number:"PNAIR-2601",  description:"Naxon BRIM Overflow — Jan 2026 (96h @ $110)",                     amount:10560, status:"paid",    issueDate:"2026-02-01", dueDate:"2026-03-03", paidDate:"2026-02-28", projectId:"proj3", poNumber:"PO-2602", category:"subcontractor", notes:"" },
  { id:"ap3",  vendorId:"v3", number:"KPATEL-2601", description:"Misc data engineering — Jan 2026 (64h @ $110)",                   amount:7040,  status:"paid",    issueDate:"2026-02-01", dueDate:"2026-03-03", paidDate:"2026-02-28", projectId:"",      poNumber:"PO-2603", category:"subcontractor", notes:"" },
  // Subcontractor — February (approved)
  { id:"ap4",  vendorId:"v1", number:"RKUMAR-2602", description:"NTTA Integration + Naxon consulting — Feb 2026 (128h @ $140)",    amount:17920, status:"approved",  issueDate:"2026-03-01", dueDate:"2026-03-31", paidDate:"",           projectId:"proj5", poNumber:"PO-2604", category:"subcontractor", notes:"" },
  { id:"ap5",  vendorId:"v2", number:"PNAIR-2602",  description:"Naxon BRIM Overflow — Feb 2026 (80h @ $110) — DISPUTED",         amount:8800,  status:"pending",   issueDate:"2026-03-01", dueDate:"2026-03-31", paidDate:"",           projectId:"proj3", poNumber:"",        category:"subcontractor", notes:"Hours don't match timesheet (rejected). Hold payment until resubmission." },
  { id:"ap6",  vendorId:"v3", number:"KPATEL-2602", description:"Data engineering — Feb 2026 (64h @ $110)",                       amount:7040,  status:"approved",  issueDate:"2026-03-03", dueDate:"2026-04-02", paidDate:"",           projectId:"",      poNumber:"PO-2605", category:"subcontractor", notes:"" },
  // Software
  { id:"ap7",  vendorId:"v5", number:"MSFT-MAR26",  description:"Microsoft Azure — March 2026 subscription",                      amount:700,   status:"paid",    issueDate:"2026-03-01", dueDate:"2026-03-01", paidDate:"2026-03-01", projectId:"",      poNumber:"",        category:"software",      notes:"Auto-pay" },
  // Office
  { id:"ap8",  vendorId:"v6", number:"REGUS-MAR26", description:"Regus Frisco office suite — March 2026",                        amount:2500,  status:"approved",  issueDate:"2026-03-01", dueDate:"2026-03-05", paidDate:"",           projectId:"",      poNumber:"",        category:"office",        notes:"" },
  // Legal — OVERDUE
  { id:"ap9",  vendorId:"v7", number:"LM-2026-031", description:"H-1B petition prep — Kiran Patel (Apr 1 deadline)",              amount:4500,  status:"overdue", issueDate:"2026-02-15", dueDate:"2026-03-01", paidDate:"",           projectId:"",      poNumber:"",        category:"legal",         notes:"URGENT — H-1B must be filed Apr 1. Pay immediately." },
  // Insurance
  { id:"ap10", vendorId:"v8", number:"TRV-2026-Q1", description:"Travelers Insurance — Q1 2026 premium",                         amount:4650,  status:"paid",    issueDate:"2026-01-01", dueDate:"2026-01-15", paidDate:"2026-01-10", projectId:"",      poNumber:"",        category:"insurance",     notes:"" },
  // March subcontractor (draft)
  { id:"ap11", vendorId:"v1", number:"RKUMAR-2603", description:"NTTA + Naxon consulting — Mar 2026 (partial, 96h @ $140)",       amount:13440, status:"draft",   issueDate:"2026-03-01", dueDate:"2026-04-10", paidDate:"",           projectId:"proj5", poNumber:"",        category:"subcontractor", notes:"Mar not yet complete. Draft for tracking." },
];




// ─── PROPOSALS SEED DATA ──────────────────────────────────────────────────────
const PROP_STATUS_COLOR = { draft:"#475569", sent:"#38bdf8", accepted:"#34d399", declined:"#f87171", expired:"#94a3b8" };
const PROP_STATUS_BG    = { draft:"#0a1626", sent:"#0c2340", accepted:"#021f14", declined:"#1a0808", expired:"#0a1020" };

const PROPOSALS_SEED = [
  {
    id:"prop1", number:"PRO-2601", status:"accepted", createdDate:"2026-01-10", sentDate:"2026-01-12", validUntil:"2026-02-12",
    title:"AT&T BRIM Phase 3 — SAP Consulting Services",
    client:"AT&T", contactName:"John Smith", contactEmail:"jsmith@att.com",
    dealId:"deal1", executiveSummary:"Ziksatech proposes to provide SAP BRIM consulting services for AT&T's Phase 3 implementation, including configuration, testing, and go-live support.",
    scopeItems:[
      {id:"s1",title:"BRIM Configuration & Setup",description:"Full BRIM module configuration including convergent invoicing and contract account setup.",hours:480,rate:155},
      {id:"s2",title:"SAP Functional Support",description:"IS-U and S/4HANA functional analysis, gap assessment, and documentation.",hours:320,rate:135},
      {id:"s3",title:"Testing & QA",description:"Integration testing, UAT support, and defect resolution.",hours:160,rate:140},
      {id:"s4",title:"Go-Live & Hypercare",description:"Go-live support and 30-day hypercare period.",hours:80,rate:155},
    ],
    teamIds:["r1","r2","r3"], paymentTerms:"Net 30", billingType:"Time & Materials",
    timeline:"April 2026 — December 2026",
    notes:"Proposal accepted. SOW and MSA amendment in progress.",
    internalNotes:"Projected margin ~42% blended. Key risk: AT&T scope creep."
  },
  {
    id:"prop2", number:"PRO-2602", status:"sent", createdDate:"2026-02-20", sentDate:"2026-02-22", validUntil:"2026-03-22",
    title:"Client B SAP Functional Implementation",
    client:"Client B", contactName:"Sarah Lee", contactEmail:"slee@clientb.com",
    dealId:"deal3", executiveSummary:"Ziksatech proposes SAP Functional consulting for Client B's S/4HANA implementation, covering finance, procurement, and project systems modules.",
    scopeItems:[
      {id:"s1",title:"S/4HANA Finance Configuration",description:"GL, AR, AP, and asset accounting setup.",hours:200,rate:125},
      {id:"s2",title:"Procurement Module",description:"MM and procurement workflow configuration.",hours:160,rate:125},
      {id:"s3",title:"Testing & Training",description:"User acceptance testing and end-user training delivery.",hours:120,rate:125},
    ],
    teamIds:["r5"], paymentTerms:"Net 30", billingType:"Time & Materials",
    timeline:"May 2026 — September 2026",
    notes:"Awaiting client response. Follow up scheduled Mar 15.",
    internalNotes:"Arun is 20% utilized — good fit. Watch margin vs fixed-fee risk."
  },
  {
    id:"prop3", number:"PRO-2603", status:"draft", createdDate:"2026-03-08", sentDate:"", validUntil:"",
    title:"Client E Cloud Architecture & AWS Migration",
    client:"Client E", contactName:"Mike Torres", contactEmail:"mtorres@cliente.com",
    dealId:"deal8", executiveSummary:"Ziksatech proposes AWS cloud architecture and migration services for Client E, leveraging our certified AWS and Databricks expertise.",
    scopeItems:[
      {id:"s1",title:"AWS Architecture Design",description:"Reference architecture, security review, and IaC templates.",hours:120,rate:160},
      {id:"s2",title:"Data Pipeline Migration",description:"Databricks migration from on-prem Hadoop to AWS.",hours:200,rate:145},
      {id:"s3",title:"Go-Live & Monitoring Setup",description:"CloudWatch dashboards, alerts, and runbook documentation.",hours:80,rate:160},
    ],
    teamIds:["r9","r10"], paymentTerms:"Net 45", billingType:"Time & Materials",
    timeline:"June 2026 — September 2026",
    notes:"Draft — needs executive summary review before sending.",
    internalNotes:"Kiran + Sanjay best fit. Sanjay W-9 missing — must resolve before engagement."
  },
  {
    id:"prop4", number:"PRO-2604", status:"expired", createdDate:"2025-11-15", sentDate:"2025-11-18", validUntil:"2025-12-18",
    title:"Client C Contract Renewal — IS-U Maintenance",
    client:"Client C", contactName:"Amy Chen", contactEmail:"achen@clientc.com",
    dealId:"deal2", executiveSummary:"Renewal proposal for ongoing IS-U maintenance and support services.",
    scopeItems:[
      {id:"s1",title:"IS-U Maintenance & Support",description:"Monthly retainer for IS-U helpdesk, patches, and minor enhancements.",hours:960,rate:135},
    ],
    teamIds:["r2"], paymentTerms:"Net 30", billingType:"Time & Materials",
    timeline:"January 2026 — December 2026",
    notes:"Expired — client requested revised pricing. New proposal in progress.",
    internalNotes:"Client wants 10% discount. Deepa's rate is already at floor."
  },
];

const PROPOSAL_SECTIONS = [
  { id:"exec",     label:"Executive Summary" },
  { id:"scope",    label:"Scope of Work"     },
  { id:"team",     label:"Proposed Team"     },
  { id:"timeline", label:"Timeline"          },
  { id:"pricing",  label:"Pricing"           },
  { id:"terms",    label:"Terms"             },
];

// =============================================================================
// BENEFITS SEED DATA
// =============================================================================

// Health plan options available to Ziksatech FTEs
const HEALTH_PLANS = [
  { id:"hmo_silver", name:"BCBS HMO Silver",   tier:"Silver", premium_ee:320,  premium_dep:680,  deductible:1500, oop_max:5000,  hsaEligible:false },
  { id:"ppo_gold",   name:"BCBS PPO Gold",      tier:"Gold",   premium_ee:480,  premium_dep:920,  deductible:500,  oop_max:3500,  hsaEligible:false },
  { id:"hdhp",       name:"BCBS HDHP + HSA",    tier:"HDHP",   premium_ee:240,  premium_dep:520,  deductible:3000, oop_max:6000,  hsaEligible:true  },
];

const DENTAL_PLANS = [
  { id:"dental_basic", name:"Delta Dental Basic",   premium_ee:18,  premium_dep:42  },
  { id:"dental_plus",  name:"Delta Dental Plus",    premium_ee:32,  premium_dep:68  },
];

const VISION_PLANS = [
  { id:"vision_std",   name:"VSP Standard",          premium_ee:8,   premium_dep:18  },
  { id:"vision_plus",  name:"VSP Plus",              premium_ee:14,  premium_dep:28  },
];

// Per-employee benefits enrollment & 401k data
const BENEFITS_SEED = [
  {
    id:"ben1", memberId:"r1", name:"Suresh Menon", type:"FTE", salary:120000,
    healthPlan:"ppo_gold",   healthTier:"ee_only",  dentalPlan:"dental_plus", visionPlan:"vision_plus",
    hsa:0, fsaBalance:600,
    k401_enrolled:true, k401_pct:6, k401_match_pct:3, k401_ytd:3000, k401_match_ytd:1500,
    lifeInsured:true, lifeMultiple:2, stdEnrolled:true, ltdEnrolled:true,
    openEnrollment:"2026-11-01", beneficiaryOnFile:true,
    notes:"Max contributing to FSA. Considering HDHP switch next cycle.",
  },
  {
    id:"ben2", memberId:"r2", name:"Deepa Rao", type:"FTE", salary:98000,
    healthPlan:"hdhp",       healthTier:"ee_spouse", dentalPlan:"dental_plus", visionPlan:"vision_std",
    hsa:2400, fsaBalance:0,
    k401_enrolled:true, k401_pct:8, k401_match_pct:3, k401_match_ytd:1225, k401_ytd:3267,
    lifeInsured:true, lifeMultiple:2, stdEnrolled:true, ltdEnrolled:true,
    openEnrollment:"2026-11-01", beneficiaryOnFile:true,
    notes:"On HDHP+HSA. Employer HSA contribution $100/mo.",
  },
  {
    id:"ben3", memberId:"r3", name:"Vikram Singh", type:"FTE", salary:102000,
    healthPlan:"hmo_silver",  healthTier:"ee_only",  dentalPlan:"dental_basic", visionPlan:"vision_std",
    hsa:0, fsaBalance:0,
    k401_enrolled:true, k401_pct:4, k401_match_pct:3, k401_match_ytd:1275, k401_ytd:1700,
    lifeInsured:true, lifeMultiple:1, stdEnrolled:false, ltdEnrolled:true,
    openEnrollment:"2026-11-01", beneficiaryOnFile:false,
    notes:"Beneficiary form missing — follow up required.",
  },
  {
    id:"ben4", memberId:"r4", name:"Ananya Krishnan", type:"FTE", salary:88000,
    healthPlan:"ppo_gold",    healthTier:"family",    dentalPlan:"dental_plus", visionPlan:"vision_plus",
    hsa:0, fsaBalance:1200,
    k401_enrolled:true, k401_pct:5, k401_match_pct:3, k401_match_ytd:1100, k401_ytd:1833,
    lifeInsured:true, lifeMultiple:2, stdEnrolled:true, ltdEnrolled:true,
    openEnrollment:"2026-11-01", beneficiaryOnFile:true,
    notes:"Family coverage. Two dependents on health + dental.",
  },
  {
    id:"ben5", memberId:"r5", name:"Arun Sharma", type:"FTE", salary:85000,
    healthPlan:"hmo_silver",  healthTier:"ee_only",  dentalPlan:"dental_basic", visionPlan:"vision_std",
    hsa:0, fsaBalance:0,
    k401_enrolled:false, k401_pct:0, k401_match_pct:0, k401_match_ytd:0, k401_ytd:0,
    lifeInsured:true, lifeMultiple:1, stdEnrolled:false, ltdEnrolled:false,
    openEnrollment:"2026-11-01", beneficiaryOnFile:true,
    notes:"Not enrolled in 401k — outreach needed. H-1B expiring Apr 14.",
  },
  {
    id:"ben6", memberId:"r6", name:"Meena Iyer", type:"FTE", salary:82000,
    healthPlan:"hdhp",        healthTier:"ee_only",  dentalPlan:"dental_basic", visionPlan:"vision_std",
    hsa:1200, fsaBalance:0,
    k401_enrolled:true, k401_pct:6, k401_match_pct:3, k401_match_ytd:1025, k401_ytd:2050,
    lifeInsured:true, lifeMultiple:1, stdEnrolled:true, ltdEnrolled:true,
    openEnrollment:"2026-11-01", beneficiaryOnFile:true,
    notes:"On bench — monitor utilization during leave.",
  },
];

// Annual 401k IRS limits 2026
const LIMIT_401K_EE   = 23000;   // employee contribution limit
const LIMIT_401K_TOTAL= 69000;   // total (ee + employer)
const LIMIT_HSA_SINGLE= 4150;
const LIMIT_HSA_FAMILY= 8300;
const LIMIT_FSA       = 3200;
const ER_HSA_CONTRIB  = 100;     // Ziksatech monthly HSA contribution for HDHP enrollees
// ─── AUDIT LOG SEED DATA ──────────────────────────────────────────────────────
const AUDIT_ACTIONS = {
  create:"create", update:"update", delete:"delete", approve:"approve",
  deny:"deny", lock:"lock", submit:"submit", invoice:"invoice", pay:"pay",
  login:"login", export:"export", restore:"restore"
};
const AUDIT_MODULE_COLOR = {
  contracts:"#38bdf8", projects:"#a78bfa", finance:"#f59e0b", timesheet:"#34d399",
  compliance:"#f87171", crm:"#818cf8", recruiting:"#fb923c", vendors:"#94a3b8",
  roster:"#38bdf8", changeorders:"#f59e0b", pto:"#34d399", system:"#475569"
};
const AUDIT_ACTION_COLOR = {
  create:"#34d399", update:"#38bdf8", delete:"#f87171", approve:"#34d399",
  deny:"#f87171", lock:"#a78bfa", submit:"#f59e0b", invoice:"#38bdf8",
  pay:"#34d399", login:"#475569", export:"#94a3b8", restore:"#f59e0b"
};

const ESIGN_SEED = [
  { id:"es1", title:"AT&T BRIM Phase 3 SOW", docType:"SOW", contractId:"c1",
    status:"signed", createdDate:"2026-01-10", sentDate:"2026-01-11",
    signers:[
      { id:"sg1", name:"Manju Ziksatech", role:"Ziksatech CEO",    email:"manju@ziksatech.com",  status:"signed", signedDate:"2026-01-12", method:"draw" },
      { id:"sg2", name:"AT&T Procurement", role:"Client Signatory", email:"procurement@att.com",  status:"signed", signedDate:"2026-01-14", method:"type" },
    ],
    auditTrail:[
      { ts:"2026-01-10T09:00:00", event:"Document created",    actor:"Manju" },
      { ts:"2026-01-11T10:30:00", event:"Sent for signature",  actor:"Manju" },
      { ts:"2026-01-12T14:22:00", event:"Signed by Ziksatech CEO", actor:"Manju" },
      { ts:"2026-01-14T16:05:00", event:"Signed by AT&T Procurement", actor:"AT&T Procurement" },
      { ts:"2026-01-14T16:06:00", event:"Document fully executed", actor:"System" },
    ],
    value:320000, expiryDays:30, notes:"Phase 3 kicks off Feb 1." },
  { id:"es2", title:"Naxon Systems Master Services Agreement", docType:"Contract", contractId:"c2",
    status:"pending", createdDate:"2026-03-01", sentDate:"2026-03-02",
    signers:[
      { id:"sg3", name:"Manju Ziksatech", role:"Ziksatech CEO",    email:"manju@ziksatech.com",  status:"signed", signedDate:"2026-03-03", method:"draw" },
      { id:"sg4", name:"Naxon Legal",     role:"Client Signatory", email:"legal@naxon.com",       status:"pending", signedDate:null, method:null },
    ],
    auditTrail:[
      { ts:"2026-03-01T11:00:00", event:"Document created",    actor:"Manju" },
      { ts:"2026-03-02T09:15:00", event:"Sent for signature",  actor:"Manju" },
      { ts:"2026-03-03T13:40:00", event:"Signed by Ziksatech CEO", actor:"Manju" },
    ],
    value:170000, expiryDays:14, notes:"Awaiting Naxon legal team. Follow up Mar 16." },
  { id:"es3", title:"Client C IS-U Renewal SOW", docType:"SOW", contractId:"c3",
    status:"draft", createdDate:"2026-03-10", sentDate:null,
    signers:[
      { id:"sg5", name:"Manju Ziksatech", role:"Ziksatech CEO",    email:"manju@ziksatech.com",  status:"pending", signedDate:null, method:null },
      { id:"sg6", name:"Client C Contact", role:"Client Signatory", email:"ops@clientc.com",      status:"pending", signedDate:null, method:null },
    ],
    auditTrail:[
      { ts:"2026-03-10T15:00:00", event:"Document created",    actor:"Manju" },
    ],
    value:85000, expiryDays:21, notes:"Renewal for IS-U support contract. Price increase 8%." },
  { id:"es4", title:"Arun Sharma Employment Agreement Amendment", docType:"HR", contractId:null,
    status:"expired", createdDate:"2026-01-05", sentDate:"2026-01-06",
    signers:[
      { id:"sg7", name:"Manju Ziksatech", role:"Ziksatech CEO", email:"manju@ziksatech.com",  status:"signed", signedDate:"2026-01-07", method:"draw" },
      { id:"sg8", name:"Arun Sharma",     role:"Employee",       email:"arun@ziksatech.com",   status:"pending", signedDate:null, method:null },
    ],
    auditTrail:[
      { ts:"2026-01-05T10:00:00", event:"Document created",    actor:"Manju" },
      { ts:"2026-01-06T09:00:00", event:"Sent for signature",  actor:"Manju" },
      { ts:"2026-01-07T14:00:00", event:"Signed by Ziksatech CEO", actor:"Manju" },
      { ts:"2026-02-05T00:00:00", event:"Request expired (30 days)", actor:"System" },
    ],
    value:null, expiryDays:0, notes:"Expired — resend required. H-1B clause update." },
];

const AUDIT_SEED = [
  // System / login
  { id:"al001", ts:"2026-03-11T08:02:11Z", user:"Manju", module:"system",    action:"login",   entity:"Session",         detail:"User logged in",                                          before:null, after:null },
  { id:"al002", ts:"2026-03-11T08:05:33Z", user:"Manju", module:"compliance",action:"approve", entity:"Document doc10",  detail:"Approved H-1B Petition for Kiran Patel",                  before:{status:"pending"}, after:{status:"approved"} },
  { id:"al003", ts:"2026-03-11T07:45:00Z", user:"Suresh",module:"system",    action:"login",   entity:"Session",         detail:"User logged in",                                          before:null, after:null },
  // PTO
  { id:"al004", ts:"2026-03-10T16:20:00Z", user:"Meena", module:"pto",       action:"submit",  entity:"PTO Request pt8", detail:"Submitted 1-day personal leave request for Mar 20",       before:null, after:{status:"pending"} },
  { id:"al005", ts:"2026-03-08T09:11:22Z", user:"Suresh",module:"pto",       action:"submit",  entity:"PTO Request pt7", detail:"Submitted 5-day PTO request Apr 6-10 (Cancun)",           before:null, after:{status:"pending"} },
  { id:"al006", ts:"2026-03-01T14:30:00Z", user:"Manju", module:"pto",       action:"approve", entity:"PTO Request pt10",detail:"Approved Deepa Rao 5-day PTO May 25-29",                  before:{status:"pending"}, after:{status:"approved", approvedBy:"Manju"} },
  { id:"al007", ts:"2026-03-01T14:28:00Z", user:"Manju", module:"pto",       action:"deny",    entity:"PTO Request pt12",detail:"Denied Vikram Singh PTO Mar 16-20 (AT&T go-live week)",   before:{status:"pending"}, after:{status:"denied", notes:"AT&T go-live week — cannot approve"} },
  // Finance / AP
  { id:"al008", ts:"2026-03-10T11:05:00Z", user:"Manju", module:"vendors",   action:"approve", entity:"AP Invoice ap4",  detail:"Approved Rajesh Kumar Feb invoice $17,920",               before:{status:"submitted"}, after:{status:"approved"} },
  { id:"al009", ts:"2026-03-09T10:15:00Z", user:"Manju", module:"vendors",   action:"approve", entity:"AP Invoice ap6",  detail:"Approved Kiran Patel Feb invoice $7,040",                 before:{status:"submitted"}, after:{status:"approved"} },
  { id:"al010", ts:"2026-03-05T15:42:00Z", user:"Manju", module:"vendors",   action:"pay",     entity:"AP Invoice ap7",  detail:"Paid Azure Mar subscription $700 (auto-pay)",             before:{status:"approved"}, after:{status:"paid"} },
  { id:"al011", ts:"2026-03-03T09:00:00Z", user:"Manju", module:"finance",   action:"invoice", entity:"Invoice FB-2609", detail:"Created FreshBooks invoice FB-2609 AT&T Mar $160,000",    before:null, after:{status:"sent", amount:160000} },
  // Timesheets
  { id:"al012", ts:"2026-03-08T17:00:00Z", user:"Suresh",module:"timesheet", action:"submit",  entity:"TS tss12",        detail:"Submitted Mar Week 1 timesheet (40h AT&T BRIM)",          before:{status:"draft"}, after:{status:"submitted"} },
  { id:"al013", ts:"2026-03-07T16:45:00Z", user:"Deepa", module:"timesheet", action:"submit",  entity:"TS tss13",        detail:"Submitted Mar Week 1 timesheet (32h IS-U)",               before:{status:"draft"}, after:{status:"submitted"} },
  { id:"al014", ts:"2026-03-02T09:22:00Z", user:"Manju", module:"timesheet", action:"approve", entity:"TS tss7",         detail:"Owner-approved Deepa Rao Feb W1 timesheet",               before:{status:"pm_approved"}, after:{status:"approved"} },
  { id:"al015", ts:"2026-03-02T09:15:00Z", user:"Manju", module:"timesheet", action:"deny",    entity:"TS tss10",        detail:"Rejected Priya Nair Feb W2 (hours mismatch with AP bill)", before:{status:"submitted"}, after:{status:"rejected", reason:"Hours mismatch"} },
  { id:"al016", ts:"2026-02-28T18:00:00Z", user:"Manju", module:"timesheet", action:"lock",    entity:"Period Feb 2026", detail:"Locked February 2026 timesheets — invoices generated",    before:{status:"approved"}, after:{status:"locked"} },
  // Contracts
  { id:"al017", ts:"2026-03-06T14:10:00Z", user:"Manju", module:"contracts", action:"update",  entity:"Contract con3",   detail:"Updated Client C renewal status → expiring (90d notice)",  before:{status:"active"}, after:{status:"expiring"} },
  { id:"al018", ts:"2026-02-20T11:00:00Z", user:"Manju", module:"contracts", action:"create",  entity:"Contract con6",   detail:"Created AT&T NDA — BRIM Portal ($0, 2-year term)",         before:null, after:{status:"active"} },
  // Change Orders
  { id:"al019", ts:"2026-03-04T16:30:00Z", user:"Manju", module:"changeorders",action:"approve",entity:"CO co1",         detail:"Approved CO-001 AT&T Sprint 1 expansion +$24,400",         before:{status:"pending_approval"}, after:{status:"approved"} },
  { id:"al020", ts:"2026-03-04T16:35:00Z", user:"Manju", module:"changeorders",action:"invoice",entity:"CO co1",         detail:"Invoiced CO-001 — created FB-2606 $24,400",                before:{status:"approved"}, after:{status:"invoiced"} },
  { id:"al021", ts:"2026-03-01T10:00:00Z", user:"Manju", module:"changeorders",action:"approve",entity:"CO co4",         detail:"Approved CO-004 AT&T reporting module removal -$7,750",    before:{status:"pending_approval"}, after:{status:"approved"} },
  // CRM
  { id:"al022", ts:"2026-03-09T10:45:00Z", user:"Manju", module:"crm",       action:"update",  entity:"Deal CRM-008",    detail:"Advanced AT&T BRIM Phase 4 deal to Proposal stage ($480K)", before:{stage:"Qualified"}, after:{stage:"Proposal"} },
  { id:"al023", ts:"2026-03-07T14:20:00Z", user:"Manju", module:"crm",       action:"create",  entity:"Activity act11",  detail:"Logged call with Client E — qualified $120K opportunity",  before:null, after:{type:"call"} },
  // Roster
  { id:"al024", ts:"2026-02-15T09:30:00Z", user:"Manju", module:"roster",    action:"update",  entity:"Roster r4",       detail:"Updated Ananya Krishnan utilization 80% → 60% (AT&T scope reduction)", before:{utilization:80}, after:{utilization:60} },
  { id:"al025", ts:"2026-02-10T11:00:00Z", user:"Manju", module:"roster",    action:"update",  entity:"Roster r6",       detail:"Moved Meena Iyer to Bench (project ended)",                before:{client:"AT&T",utilization:80}, after:{client:"Bench",utilization:0} },
  // Projects
  { id:"al026", ts:"2026-03-05T16:00:00Z", user:"Suresh",module:"projects",  action:"update",  entity:"Project proj2",   detail:"Updated Client C IS-U project health: green → amber",      before:{health:"green"}, after:{health:"amber"} },
  { id:"al027", ts:"2026-03-01T09:00:00Z", user:"Manju", module:"projects",  action:"create",  entity:"Project proj4",   detail:"Created Client B SAP Functional project ($120K budget)",   before:null, after:{status:"planning"} },
  // Recruiting
  { id:"al028", ts:"2026-03-08T15:30:00Z", user:"Manju", module:"recruiting",action:"approve", entity:"Offer off1",      detail:"Extended offer to Arjun Reddy $140/hr AT&T BRIM",          before:{status:"draft"}, after:{status:"pending"} },
  { id:"al029", ts:"2026-03-05T11:15:00Z", user:"Manju", module:"recruiting",action:"approve", entity:"Offer off2",      detail:"Lakshmi Venkat accepted offer $155/hr AT&T",               before:{status:"pending"}, after:{status:"accepted"} },
  // Export
  { id:"al030", ts:"2026-03-03T14:00:00Z", user:"Manju", module:"finance",   action:"export",  entity:"ADP Payroll",     detail:"Exported Feb 2026 ADP payroll CSV (6 employees)",          before:null, after:null },
];

// ─── PTO & LEAVE SEED DATA ────────────────────────────────────────────────────
const PTO_TYPE_COLOR = {
  pto:"#34d399", sick:"#f87171", personal:"#a78bfa",
  bereavement:"#94a3b8", holiday:"#f59e0b", unpaid:"#475569"
};
const PTO_TYPE_BG = {
  pto:"#021f14", sick:"#1a0808", personal:"#160d2a",
  bereavement:"#0a1020", holiday:"#1a1005", unpaid:"#0a1020"
};
const PTO_STATUS_COLOR = { pending:"#f59e0b", approved:"#34d399", denied:"#f87171", cancelled:"#475569" };
const PTO_STATUS_BG    = { pending:"#1a1005", approved:"#021f14", denied:"#1a0808", cancelled:"#0a1020" };

const PTO_BALANCES_SEED = [
  { memberId:"r1",  name:"Suresh Menon",    ptoAccrued:15, ptoUsed:3,  sickAccrued:10, sickUsed:0,  personalAccrued:3, personalUsed:0 },
  { memberId:"r2",  name:"Deepa Rao",       ptoAccrued:15, ptoUsed:5,  sickAccrued:10, sickUsed:2,  personalAccrued:3, personalUsed:1 },
  { memberId:"r3",  name:"Vikram Singh",    ptoAccrued:15, ptoUsed:0,  sickAccrued:10, sickUsed:1,  personalAccrued:3, personalUsed:0 },
  { memberId:"r4",  name:"Ananya Krishnan", ptoAccrued:15, ptoUsed:8,  sickAccrued:10, sickUsed:0,  personalAccrued:3, personalUsed:0 },
  { memberId:"r5",  name:"Arun Sharma",     ptoAccrued:15, ptoUsed:2,  sickAccrued:10, sickUsed:3,  personalAccrued:3, personalUsed:2 },
  { memberId:"r6",  name:"Meena Iyer",      ptoAccrued:15, ptoUsed:0,  sickAccrued:10, sickUsed:0,  personalAccrued:3, personalUsed:0 },
];

const PTO_REQUESTS_SEED = [
  // Approved past
  { id:"pt1",  memberId:"r1", name:"Suresh Menon",    type:"pto",        start:"2026-01-19", end:"2026-01-23", days:5, reason:"Family vacation",                   status:"approved", approvedBy:"Manju", notes:"",                                   submitted:"2026-01-05" },
  { id:"pt2",  memberId:"r2", name:"Deepa Rao",       type:"pto",        start:"2026-02-16", end:"2026-02-20", days:5, reason:"India trip",                        status:"approved", approvedBy:"Manju", notes:"",                                   submitted:"2026-01-20" },
  { id:"pt3",  memberId:"r2", name:"Deepa Rao",       type:"sick",       start:"2026-02-09", end:"2026-02-10", days:2, reason:"Sick - flu",                         status:"approved", approvedBy:"Manju", notes:"Doctor note on file",                submitted:"2026-02-09" },
  { id:"pt4",  memberId:"r5", name:"Arun Sharma",     type:"pto",        start:"2026-01-26", end:"2026-01-28", days:3, reason:"Personal travel",                   status:"approved", approvedBy:"Manju", notes:"",                                   submitted:"2026-01-10" },
  { id:"pt5",  memberId:"r3", name:"Vikram Singh",    type:"sick",       start:"2026-02-03", end:"2026-02-03", days:1, reason:"Sick - not feeling well",           status:"approved", approvedBy:"Manju", notes:"",                                   submitted:"2026-02-03" },
  // Pending approval
  { id:"pt6",  memberId:"r4", name:"Ananya Krishnan", type:"pto",        start:"2026-03-23", end:"2026-03-27", days:5, reason:"Spring break with kids",            status:"pending",  approvedBy:"",      notes:"",                                   submitted:"2026-03-05" },
  { id:"pt7",  memberId:"r1", name:"Suresh Menon",    type:"pto",        start:"2026-04-06", end:"2026-04-10", days:5, reason:"Vacation - Cancun trip",            status:"pending",  approvedBy:"",      notes:"Needs coverage: AT&T sprint review",  submitted:"2026-03-08" },
  { id:"pt8",  memberId:"r6", name:"Meena Iyer",      type:"personal",   start:"2026-03-20", end:"2026-03-20", days:1, reason:"Personal appointment",              status:"pending",  approvedBy:"",      notes:"",                                   submitted:"2026-03-10" },
  { id:"pt9",  memberId:"r5", name:"Arun Sharma",     type:"sick",       start:"2026-03-11", end:"2026-03-11", days:1, reason:"Sick day",                          status:"pending",  approvedBy:"",      notes:"",                                   submitted:"2026-03-11" },
  // Future approved
  { id:"pt10", memberId:"r2", name:"Deepa Rao",       type:"pto",        start:"2026-05-25", end:"2026-05-29", days:5, reason:"Memorial Day week vacation",       status:"approved", approvedBy:"Manju", notes:"IS-U tickets covered by Arun",       submitted:"2026-03-01" },
  { id:"pt11", memberId:"r4", name:"Ananya Krishnan", type:"pto",        start:"2026-04-27", end:"2026-05-01", days:5, reason:"Personal trip",                    status:"approved", approvedBy:"Manju", notes:"",                                   submitted:"2026-02-15" },
  // Denied
  { id:"pt12", memberId:"r3", name:"Vikram Singh",    type:"pto",        start:"2026-03-16", end:"2026-03-20", days:5, reason:"Vacation",                          status:"denied",   approvedBy:"Manju", notes:"AT&T go-live week — cannot approve", submitted:"2026-03-01" },
];

// ─── CHANGE ORDER SEED DATA ───────────────────────────────────────────────────
const CO_STATUS_COLOR = {
  draft:    "#475569", pending:  "#f59e0b", approved: "#34d399",
  rejected: "#f87171", voided:   "#1e3a5f",
};
const CO_STATUS_BG = {
  draft:    "#0a1626", pending:  "#1a1005", approved: "#021f14",
  rejected: "#1a0808", voided:   "#070b14",
};
const CO_STATUS_LABEL = {
  draft:"Draft", pending:"Pending Client", approved:"Approved", rejected:"Rejected", voided:"Voided",
};
const CO_TYPE_COLOR  = { addition:"#34d399", reduction:"#f87171", timeline:"#f59e0b", scope_change:"#a78bfa" };
const CO_TYPE_LABEL  = { addition:"Budget Addition", reduction:"Budget Reduction", timeline:"Timeline Change", scope_change:"Scope Change" };

const CHANGE_ORDERS_SEED = [
  {
    id:"co1", number:"CO-001", projectId:"proj1", contractId:"con1", sowId:"sow1",
    title:"Sprint 1 Scope Expansion — AT&T BRIM Portal",
    description:"Client requested additional BRIM configuration for FI-CA module and custom dunning workflow. Original scope covered only standard configuration. Additional 120 hours required for Suresh + 40 hours for Deepa.",
    type:"addition", status:"approved",
    originalBudget:480000, changeAmount:24400, newBudget:504400,
    originalEndDate:"2026-12-31", newEndDate:"2026-12-31",
    requestedBy:"Sarah Johnson (AT&T)", requestedAt:"2026-02-10",
    submittedAt:"2026-02-12", clientResponseAt:"2026-02-18",
    approvedBy:"Manju", clientSignedBy:"Sarah Johnson",
    affectedRoster:["r1","r2"], additionalHours:160,
    internalNotes:"Suresh confirmed scope in kickoff call. Email trail saved.",
    attachments:["CO-001-scope-doc.pdf","AT&T-approval-email.pdf"],
    invoiced:true, invoiceRef:"FB-2606",
  },
  {
    id:"co2", number:"CO-002", projectId:"proj2", contractId:"con3", sowId:"sow2",
    title:"Client C IS-U Maintenance — Contract Renewal Extension",
    description:"Client C IS-U maintenance contract expires June 30. Client wants 3-month extension through September 30, 2026 at the same rate. Additional 3 milestone payments of $40,500 each.",
    type:"timeline", status:"pending",
    originalBudget:162000, changeAmount:121500, newBudget:283500,
    originalEndDate:"2026-06-30", newEndDate:"2026-09-30",
    requestedBy:"Manju", requestedAt:"2026-03-05",
    submittedAt:"2026-03-06", clientResponseAt:"",
    approvedBy:"", clientSignedBy:"",
    affectedRoster:["r2"], additionalHours:240,
    internalNotes:"Client verbally confirmed intent to renew. Awaiting formal sign-off.",
    attachments:["CO-002-draft.pdf"],
    invoiced:false, invoiceRef:"",
  },
  {
    id:"co3", number:"CO-003", projectId:"proj5", contractId:"con1", sowId:"",
    title:"NTTA Integration — Additional AWS Lambda Development",
    description:"NTTA requested custom API gateway layer between SAP BRIM and legacy billing system. Not in original scope. Rajesh to lead; estimated 80 hours.",
    type:"addition", status:"draft",
    originalBudget:180000, changeAmount:14800, newBudget:194800,
    originalEndDate:"2026-08-31", newEndDate:"2026-08-31",
    requestedBy:"David Chen (NTTA)", requestedAt:"2026-03-08",
    submittedAt:"", clientResponseAt:"",
    approvedBy:"", clientSignedBy:"",
    affectedRoster:["r7"], additionalHours:80,
    internalNotes:"Rajesh needs to finalize hours estimate before we submit.",
    attachments:[],
    invoiced:false, invoiceRef:"",
  },
  {
    id:"co4", number:"CO-004", projectId:"proj1", contractId:"con1", sowId:"sow1",
    title:"AT&T BRIM Phase 3 — Remove Reporting Module",
    description:"AT&T decided to handle BI reporting internally. Removing the custom reporting sprint from scope. 40 hours reduction in Suresh's allocation.",
    type:"reduction", status:"approved",
    originalBudget:504400, changeAmount:-7750, newBudget:496650,
    originalEndDate:"2026-12-31", newEndDate:"2026-12-31",
    requestedBy:"AT&T PMO", requestedAt:"2026-03-01",
    submittedAt:"2026-03-02", clientResponseAt:"2026-03-05",
    approvedBy:"Manju", clientSignedBy:"AT&T PMO",
    affectedRoster:["r1"], additionalHours:-40,
    internalNotes:"Saves $7,750. Budget credit applied to next invoice.",
    attachments:["CO-004-approved.pdf"],
    invoiced:false, invoiceRef:"",
  },
];

// ─── TIMESHEET APPROVAL SEED DATA ────────────────────────────────────────────
const TS_SUBMISSIONS_SEED = [
  // January 2026 — all fully approved & locked
  { id:"tss1",  rosterId:"r1",  period:"Jan 2026", monthIdx:0, year:2026, totalHours:160, billRate:155, totalRevenue:24800,  status:"locked",      clientId:"acc1",  projectId:"proj1", submittedAt:"2026-02-01", pmApproverId:"org2", pmApprovedAt:"2026-02-02", ownerApprovedAt:"2026-02-03", lockedAt:"2026-02-03", pmNotes:"",       rejectionNote:"", invoiceRef:"FB-2601" },
  { id:"tss2",  rosterId:"r2",  period:"Jan 2026", monthIdx:0, year:2026, totalHours:128, billRate:135, totalRevenue:17280,  status:"locked",      clientId:"acc1",  projectId:"proj2", submittedAt:"2026-02-01", pmApproverId:"org2", pmApprovedAt:"2026-02-02", ownerApprovedAt:"2026-02-03", lockedAt:"2026-02-03", pmNotes:"",       rejectionNote:"", invoiceRef:"FB-2602" },
  { id:"tss3",  rosterId:"r3",  period:"Jan 2026", monthIdx:0, year:2026, totalHours:128, billRate:140, totalRevenue:17920,  status:"locked",      clientId:"acc1",  projectId:"proj1", submittedAt:"2026-02-01", pmApproverId:"org2", pmApprovedAt:"2026-02-02", ownerApprovedAt:"2026-02-03", lockedAt:"2026-02-03", pmNotes:"",       rejectionNote:"", invoiceRef:"FB-2602" },
  { id:"tss4",  rosterId:"r7",  period:"Jan 2026", monthIdx:0, year:2026, totalHours:128, billRate:185, totalRevenue:23680,  status:"locked",      clientId:"acc10", projectId:"proj5", submittedAt:"2026-02-01", pmApproverId:"org2", pmApprovedAt:"2026-02-02", ownerApprovedAt:"2026-02-03", lockedAt:"2026-02-03", pmNotes:"",       rejectionNote:"", invoiceRef:"FB-2603" },
  { id:"tss5",  rosterId:"r8",  period:"Jan 2026", monthIdx:0, year:2026, totalHours:96,  billRate:165, totalRevenue:15840,  status:"locked",      clientId:"acc5",  projectId:"proj3", submittedAt:"2026-02-01", pmApproverId:"org2", pmApprovedAt:"2026-02-02", ownerApprovedAt:"2026-02-03", lockedAt:"2026-02-03", pmNotes:"",       rejectionNote:"", invoiceRef:"FB-2604" },

  // February 2026 — mixed states
  { id:"tss6",  rosterId:"r1",  period:"Feb 2026", monthIdx:1, year:2026, totalHours:160, billRate:155, totalRevenue:24800,  status:"approved",    clientId:"acc1",  projectId:"proj1", submittedAt:"2026-03-01", pmApproverId:"org2", pmApprovedAt:"2026-03-02", ownerApprovedAt:"2026-03-05", lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },
  { id:"tss7",  rosterId:"r2",  period:"Feb 2026", monthIdx:1, year:2026, totalHours:120, billRate:135, totalRevenue:16200,  status:"pm_approved", clientId:"acc3",  projectId:"proj2", submittedAt:"2026-03-01", pmApproverId:"org2", pmApprovedAt:"2026-03-02", ownerApprovedAt:"",           lockedAt:"",           pmNotes:"Looks good — Q2 renewal hours included.", rejectionNote:"", invoiceRef:"" },
  { id:"tss8",  rosterId:"r3",  period:"Feb 2026", monthIdx:1, year:2026, totalHours:128, billRate:140, totalRevenue:17920,  status:"submitted",   clientId:"acc1",  projectId:"proj1", submittedAt:"2026-03-02", pmApproverId:"",     pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },
  { id:"tss9",  rosterId:"r7",  period:"Feb 2026", monthIdx:1, year:2026, totalHours:128, billRate:185, totalRevenue:23680,  status:"submitted",   clientId:"acc10", projectId:"proj5", submittedAt:"2026-03-01", pmApproverId:"",     pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },
  { id:"tss10", rosterId:"r8",  period:"Feb 2026", monthIdx:1, year:2026, totalHours:80,  billRate:165, totalRevenue:13200,  status:"rejected",    clientId:"acc5",  projectId:"proj3", submittedAt:"2026-02-28", pmApproverId:"org2", pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"Hours don't match project tracker. Priya was on bench Feb 15-28. Please correct.", invoiceRef:"" },
  { id:"tss11", rosterId:"r9",  period:"Feb 2026", monthIdx:1, year:2026, totalHours:64,  billRate:145, totalRevenue:9280,   status:"submitted",   clientId:"",      projectId:"",      submittedAt:"2026-03-03", pmApproverId:"",     pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },

  // March 2026 — drafts (current month in progress)
  { id:"tss12", rosterId:"r1",  period:"Mar 2026", monthIdx:2, year:2026, totalHours:80,  billRate:155, totalRevenue:12400,  status:"draft",       clientId:"acc1",  projectId:"proj1", submittedAt:"",           pmApproverId:"",     pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },
  { id:"tss13", rosterId:"r2",  period:"Mar 2026", monthIdx:2, year:2026, totalHours:60,  billRate:135, totalRevenue:8100,   status:"draft",       clientId:"acc3",  projectId:"proj2", submittedAt:"",           pmApproverId:"",     pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },
  { id:"tss14", rosterId:"r7",  period:"Mar 2026", monthIdx:2, year:2026, totalHours:96,  billRate:185, totalRevenue:17760,  status:"draft",       clientId:"acc10", projectId:"proj5", submittedAt:"",           pmApproverId:"",     pmApprovedAt:"",           ownerApprovedAt:"",           lockedAt:"",           pmNotes:"",       rejectionNote:"", invoiceRef:"" },
];

// ─── CONTRACTS & SOW SEED DATA ────────────────────────────────────────────────
const CONTRACTS_SEED = [
  { id:"con1", accountId:"acc1", dealId:"deal1", name:"AT&T BRIM Phase 3 MSA Amendment",   type:"MSA Amendment", status:"active",    value:480000, startDate:"2026-04-01", endDate:"2026-12-31", signedDate:"2026-03-15", counterparty:"AT&T Inc.",           owner:"Manju", renewalAlert:60, notes:"Renewal of master agreement with Phase 3 SOW attached.", fileName:"att_msa_amendment_2026.pdf" },
  { id:"con2", accountId:"acc2", dealId:"deal4", name:"Client B SAP Functional SOW",        type:"SOW",           status:"pending",   value:120000, startDate:"2026-04-01", endDate:"2026-09-30", signedDate:"",          counterparty:"Client B Corp.",       owner:"Manju", renewalAlert:45, notes:"Expansion SOW — 1 additional consultant. Awaiting countersign.", fileName:"" },
  { id:"con3", accountId:"acc3", dealId:"deal7", name:"Client C Contract Renewal",           type:"MSA",           status:"expiring",  value:320000, startDate:"2025-07-01", endDate:"2026-06-30", signedDate:"2025-06-28", counterparty:"Client C Healthcare",  owner:"Manju", renewalAlert:90, notes:"Renewal negotiation in progress. Rate discussion expected.", fileName:"clientc_msa_2025.pdf" },
  { id:"con4", accountId:"acc5", dealId:"",      name:"Naxon Systems Partner Agreement",     type:"Partner",       status:"active",    value:170000, startDate:"2026-01-01", endDate:"2026-12-31", signedDate:"2025-12-20", counterparty:"Naxon Systems LLC",    owner:"Manju", renewalAlert:60, notes:"Revenue share arrangement. Rajesh + Priya overflow billing.", fileName:"naxon_partner_2026.pdf" },
  { id:"con5", accountId:"acc4", dealId:"deal8", name:"Client D Cloud Architecture SOW",    type:"SOW",           status:"draft",     value:100000, startDate:"2026-09-01", endDate:"2027-02-28", signedDate:"",          counterparty:"Client D Energy",      owner:"Manju", renewalAlert:30, notes:"Draft SOW for cloud arch expansion. Needs legal review.", fileName:"" },
  { id:"con6", accountId:"acc1", dealId:"",      name:"AT&T NDA — BRIM Portal",             type:"NDA",           status:"active",    value:0,      startDate:"2023-01-01", endDate:"2027-12-31", signedDate:"2023-01-05", counterparty:"AT&T Inc.",           owner:"Manju", renewalAlert:180,notes:"Master NDA covering all AT&T projects.", fileName:"att_nda_2023.pdf" },
];

const SOW_SEED = [
  { id:"sow1", contractId:"con1", accountId:"acc1", name:"AT&T BRIM Phase 3",         description:"Extend BRIM implementation team with 2 additional consultants for Phase 3 delivery.",
    consultants:["r1","r2"], startDate:"2026-04-01", endDate:"2026-12-31",
    billRate:140, estimatedHours:1920, status:"active", poNumber:"ATT-PO-2026-0312",
    milestones:[
      { id:"m1", name:"Kick-off & Discovery",       dueDate:"2026-04-15", status:"pending",  value:24000,  notes:"Kick-off meeting, requirements, environment access." },
      { id:"m2", name:"Phase 3 Design & Blueprint", dueDate:"2026-05-30", status:"pending",  value:72000,  notes:"Functional design docs, technical blueprint." },
      { id:"m3", name:"Build & Config Sprint 1",    dueDate:"2026-07-15", status:"pending",  value:120000, notes:"Core BRIM config, unit testing." },
      { id:"m4", name:"Build & Config Sprint 2",    dueDate:"2026-09-30", status:"pending",  value:120000, notes:"Integration, SIT support." },
      { id:"m5", name:"UAT & Go-Live Support",      dueDate:"2026-11-30", status:"pending",  value:120000, notes:"UAT facilitation, defect triage, go-live." },
      { id:"m6", name:"Hypercare & Sign-off",        dueDate:"2026-12-31", status:"pending",  value:24000,  notes:"30-day hypercare, final documentation." },
    ],
    notes:"Fixed-scope SOW with T&M elements for change orders." },
  { id:"sow2", contractId:"con3", accountId:"acc3", name:"Client C IS-U Maintenance", description:"Ongoing IS-U support and maintenance for Client C healthcare systems.",
    consultants:["r2"], startDate:"2025-07-01", endDate:"2026-06-30",
    billRate:135, estimatedHours:960, status:"expiring", poNumber:"CC-PO-2025-0701",
    milestones:[
      { id:"m7", name:"Q3 2025 Support",  dueDate:"2025-09-30", status:"complete", value:40500, notes:"" },
      { id:"m8", name:"Q4 2025 Support",  dueDate:"2025-12-31", status:"complete", value:40500, notes:"" },
      { id:"m9", name:"Q1 2026 Support",  dueDate:"2026-03-31", status:"complete", value:40500, notes:"" },
      { id:"m10",name:"Q2 2026 Support",  dueDate:"2026-06-30", status:"pending",  value:40500, notes:"Renewal discussion in parallel." },
    ],
    notes:"Renewal negotiations in progress. AT-RISK." },
];

// ─── PROJECTS SEED DATA ────────────────────────────────────────────────────────
const PROJECTS_SEED = [
  { id:"proj1", accountId:"acc1", sowId:"sow1", name:"AT&T BRIM Phase 3",          status:"active",    health:"green",  startDate:"2026-04-01", endDate:"2026-12-31", budget:480000, spent:0,    pm:"Suresh Menon",  consultants:["r1","r2","r4"], notes:"On track. Kick-off Apr 1." },
  { id:"proj2", accountId:"acc3", sowId:"sow2", name:"Client C IS-U Maintenance",  status:"active",    health:"amber",  startDate:"2025-07-01", endDate:"2026-06-30", budget:162000, spent:121500, pm:"Deepa Rao",    consultants:["r2"],           notes:"Renewal at risk. Q2 final milestone in progress." },
  { id:"proj3", accountId:"acc5", sowId:"",     name:"Naxon BRIM Overflow",        status:"active",    health:"green",  startDate:"2026-01-01", endDate:"2026-12-31", budget:170000, spent:42500, pm:"Rajesh Kumar",  consultants:["r7","r8"],      notes:"Stable. Rajesh leading. Monthly check-ins." },
  { id:"proj4", accountId:"acc2", sowId:"",     name:"Client B SAP Functional",    status:"planning",  health:"green",  startDate:"2026-04-01", endDate:"2026-09-30", budget:120000, spent:0,    pm:"Manju",         consultants:["r5"],           notes:"SOW pending signature. Arun confirmed." },
  { id:"proj5", accountId:"acc10",sowId:"",     name:"NTTA Integration Support",   status:"active",    health:"green",  startDate:"2026-01-15", endDate:"2026-09-30", budget:180000, spent:72000, pm:"Rajesh Kumar",  consultants:["r7"],           notes:"Steady. Rajesh billing $185/hr. Q2 review scheduled." },
];

const TASKS_SEED = [
  { id:"task1", projectId:"proj1", title:"Set up development environment",    assignee:"r1", dueDate:"2026-04-08", status:"todo",        priority:"high",   notes:"Need AT&T VPN access + BRIM sandbox." },
  { id:"task2", projectId:"proj1", title:"Kick-off meeting with AT&T team",   assignee:"r1", dueDate:"2026-04-01", status:"todo",        priority:"high",   notes:"James Wright + Sarah Chen to attend." },
  { id:"task3", projectId:"proj1", title:"Complete requirements document",     assignee:"r2", dueDate:"2026-04-15", status:"todo",        priority:"high",   notes:"Review with AT&T PM before submitting." },
  { id:"task4", projectId:"proj2", title:"Q2 support ticket triage",           assignee:"r2", dueDate:"2026-04-05", status:"in-progress", priority:"medium", notes:"15 open tickets from Client C queue." },
  { id:"task5", projectId:"proj2", title:"Renewal proposal to Linda Park",     assignee:"r2", dueDate:"2026-03-25", status:"in-progress", priority:"high",   notes:"Rate increase negotiation. Prepare 3 options." },
  { id:"task6", projectId:"proj3", title:"Monthly status report — Naxon",      assignee:"r7", dueDate:"2026-03-31", status:"in-progress", priority:"low",    notes:"Send to Naxon PM. Include utilization numbers." },
  { id:"task7", projectId:"proj3", title:"BRIM config review — module 4",      assignee:"r8", dueDate:"2026-04-10", status:"todo",        priority:"medium", notes:"Priya leading config session with Naxon team." },
  { id:"task8", projectId:"proj5", title:"NTTA API integration testing",        assignee:"r7", dueDate:"2026-04-05", status:"todo",        priority:"medium", notes:"Test SAP ↔ NTTA toll system integration." },
  { id:"task9", projectId:"proj1", title:"Resource onboarding — Ananya",       assignee:"r4", dueDate:"2026-04-02", status:"todo",        priority:"high",   notes:"Complete AT&T badge + NDA for Ananya." },
];

const RISKS_SEED = [
  { id:"risk1", projectId:"proj2", title:"Contract renewal not signed",       probability:"high",   impact:"high",   status:"open",     mitigation:"Exec meeting scheduled Apr 5 with Linda Park. Prepare 2-year renewal option.", owner:"Manju" },
  { id:"risk2", projectId:"proj1", title:"Delayed AT&T environment access",   probability:"medium", impact:"high",   status:"open",     mitigation:"Escalate to James Wright if not resolved by Apr 5.", owner:"r1" },
  { id:"risk3", projectId:"proj3", title:"Kiran OPT expiry May 15",          probability:"high",   impact:"medium", status:"open",     mitigation:"H-1B petition must be filed Apr 1. Attorney briefed.", owner:"Manju" },
  { id:"risk4", projectId:"proj5", title:"Rajesh sole resource — single pt", probability:"medium", impact:"high",   status:"mitigated",mitigation:"Cross-train Omar Hassan as backup. Omar available from May.", owner:"Manju" },
  { id:"risk5", projectId:"proj1", title:"Scope creep in Sprint 1",          probability:"medium", impact:"medium", status:"open",     mitigation:"Strict change order process. Any scope change triggers COA review.", owner:"r1" },
];



// ─── RECRUITING SEED DATA ────────────────────────────────────────────────────
const CANDIDATES_SEED = [
  { id:"cand1", name:"Arjun Reddy",     role:"SAP BRIM Consultant",     email:"arjun.r@email.com",   phone:"214-555-0101", source:"Referral",  visa:"H-1B",  skills:"SAP BRIM, IS-U, ABAP",         status:"active",   notes:"Referred by Suresh. Strong BRIM background.",          linkedIn:"" },
  { id:"cand2", name:"Lakshmi Venkat",  role:"SAP IS-U Senior",         email:"lakshmi.v@email.com", phone:"469-555-0202", source:"LinkedIn",  visa:"GC",    skills:"SAP IS-U, CCS, DM",            status:"active",   notes:"10 yrs utility exp. Available April 1.",               linkedIn:"" },
  { id:"cand3", name:"Omar Hassan",     role:"BRIM Architect",          email:"omar.h@email.com",    phone:"972-555-0303", source:"Network",   visa:"USC",   skills:"SAP BRIM, S/4HANA, BTP",       status:"active",   notes:"Ex-Deloitte. High demand — move fast.",                linkedIn:"" },
  { id:"cand4", name:"Pooja Malhotra",  role:"S/4HANA Finance Lead",    email:"pooja.m@email.com",   phone:"817-555-0404", source:"Referral",  visa:"H-1B",  skills:"S/4HANA FI, CO, COPA",         status:"placed",   notes:"Placed at Client B starting Apr 1.",                   linkedIn:"" },
  { id:"cand5", name:"Chen Wei",        role:"SAP Technical Architect", email:"chen.w@email.com",    phone:"972-555-0505", source:"Job Board", visa:"OPT",   skills:"ABAP, BTP, CPI",               status:"active",   notes:"OPT expires Oct 2026. Need H-1B sponsor.",            linkedIn:"" },
  { id:"cand6", name:"Fatima Al-Rashid",role:"Databricks Engineer",     email:"fatima.a@email.com",  phone:"469-555-0606", source:"LinkedIn",  visa:"USC",   skills:"Databricks, Spark, Python, AWS",status:"active",   notes:"Strong data eng profile. AT&T pipeline fit.",          linkedIn:"" },
  { id:"cand7", name:"Ravi Shankar",    role:"SAP BRIM Consultant",     email:"ravi.s@email.com",    phone:"214-555-0707", source:"Network",   visa:"H-1B",  skills:"SAP BRIM, FI",                 status:"withdrawn",notes:"Accepted competing offer. Keep in touch.",              linkedIn:"" },
  { id:"cand8", name:"Ana Kovacs",      role:"AWS Solutions Architect", email:"ana.k@email.com",     phone:"972-555-0808", source:"LinkedIn",  visa:"USC",   skills:"AWS, Terraform, DevOps",       status:"active",   notes:"Interested in long-term engagement.",                  linkedIn:"" },
];

const SUBMISSIONS_SEED = [
  { id:"sub1", candidateId:"cand1", clientId:"cl1", projectName:"BRIM Phase 3",         submitDate:"2026-02-15", reqId:"AT&T-REQ-001", notes:"Strong match. Submitted with rate $140/hr." },
  { id:"sub2", candidateId:"cand2", clientId:"cl1", projectName:"IS-U Migration",       submitDate:"2026-02-20", reqId:"AT&T-REQ-002", notes:"Utility background aligns perfectly." },
  { id:"sub3", candidateId:"cand3", clientId:"cl5", projectName:"Naxon BRIM Expansion", submitDate:"2026-03-01", reqId:"NAX-REQ-001",  notes:"Architect level for Naxon overflow." },
  { id:"sub4", candidateId:"cand6", clientId:"cl1", projectName:"AT&T Data Pipeline",   submitDate:"2026-03-05", reqId:"AT&T-REQ-003", notes:"Databricks fit for AT&T data team." },
  { id:"sub5", candidateId:"cand8", clientId:"cl4", projectName:"Client D Cloud Arch",  submitDate:"2026-03-08", reqId:"CLd-REQ-001",  notes:"AWS architect for Client D infra." },
];

const INTERVIEWS_SEED = [
  { id:"int1", candidateId:"cand1", submissionId:"sub1", round:1, type:"Technical",  date:"2026-02-22", time:"10:00 AM", interviewer:"AT&T Tech Lead",    status:"completed", feedback:"Strong BRIM knowledge. Passed.", rating:4 },
  { id:"int2", candidateId:"cand1", submissionId:"sub1", round:2, type:"Manager",   date:"2026-03-01", time:"02:00 PM", interviewer:"AT&T Delivery Mgr", status:"completed", feedback:"Good cultural fit. Recommended.", rating:5 },
  { id:"int3", candidateId:"cand2", submissionId:"sub2", round:1, type:"Technical",  date:"2026-02-28", time:"11:00 AM", interviewer:"AT&T IS-U Lead",    status:"completed", feedback:"Excellent IS-U depth. Moving forward.", rating:5 },
  { id:"int4", candidateId:"cand3", submissionId:"sub3", round:1, type:"Technical",  date:"2026-03-10", time:"09:00 AM", interviewer:"Naxon Architect",   status:"scheduled", feedback:"", rating:0 },
  { id:"int5", candidateId:"cand6", submissionId:"sub4", round:1, type:"Technical",  date:"2026-03-15", time:"01:00 PM", interviewer:"AT&T Data Manager", status:"scheduled", feedback:"", rating:0 },
  { id:"int6", candidateId:"cand8", submissionId:"sub5", round:1, type:"Technical",  date:"2026-03-12", time:"10:00 AM", interviewer:"Client D CTO",      status:"scheduled", feedback:"", rating:0 },
];

const OFFERS_SEED = [
  { id:"off1", candidateId:"cand1", clientId:"cl1", projectName:"BRIM Phase 3",   billRate:140, startDate:"2026-04-07", endDate:"2026-12-31", status:"pending",  terms:"W2/C2C",  notes:"Awaiting candidate response. Deadline Mar 15." },
  { id:"off2", candidateId:"cand2", clientId:"cl1", projectName:"IS-U Migration", billRate:155, startDate:"2026-04-01", endDate:"2026-09-30", status:"accepted", terms:"C2C",     notes:"Accepted Mar 5. Onboarding in progress." },
  { id:"off3", candidateId:"cand4", clientId:"cl2", projectName:"Client B FI",    billRate:130, startDate:"2026-04-01", endDate:"2026-09-30", status:"accepted", terms:"W2",      notes:"Signed. Starting April 1." },
];

// ─── COMPLIANCE SEED DATA ────────────────────────────────────────────────────
const WORK_AUTH_SEED = [
  { id:"wa1",  consultantId:"r1",  name:"Suresh Menon",    type:"H-1B",   status:"active",  startDate:"2024-01-15", expiryDate:"2027-01-14", petitionNo:"WAC2400112345", attorney:"Reddy & Assoc",   notes:"Renewal filed Jan 2027. Green." },
  { id:"wa2",  consultantId:"r2",  name:"Deepa Rao",       type:"H-1B",   status:"active",  startDate:"2023-06-01", expiryDate:"2026-05-31", petitionNo:"WAC2300298765", attorney:"Reddy & Assoc",   notes:"Expires May 2026 — renewal needed Q1." },
  { id:"wa3",  consultantId:"r3",  name:"Vikram Singh",    type:"GC",     status:"active",  startDate:"2022-03-10", expiryDate:"2032-03-09", petitionNo:"GC-2022-003",   attorney:"N/A",              notes:"GC holder. No action needed." },
  { id:"wa4",  consultantId:"r4",  name:"Ananya Krishnan", type:"H-1B",   status:"active",  startDate:"2025-02-01", expiryDate:"2028-01-31", petitionNo:"WAC2500154321", attorney:"Singh Law Group", notes:"Recently renewed. Current." },
  { id:"wa5",  consultantId:"r5",  name:"Arun Sharma",     type:"H-1B",   status:"expiring",startDate:"2023-04-15", expiryDate:"2026-04-14", petitionNo:"WAC2300312345", attorney:"Reddy & Assoc",   notes:"Expires in 34 days! Renewal in progress." },
  { id:"wa6",  consultantId:"r6",  name:"Meena Iyer",      type:"GC",     status:"active",  startDate:"2021-07-20", expiryDate:"2031-07-19", petitionNo:"GC-2021-006",   attorney:"N/A",              notes:"GC holder." },
  { id:"wa7",  consultantId:"r7",  name:"Rajesh Kumar",    type:"USC",    status:"active",  startDate:"2020-01-01", expiryDate:"2099-12-31", petitionNo:"USC",           attorney:"N/A",              notes:"US Citizen." },
  { id:"wa8",  consultantId:"r8",  name:"Priya Nair",      type:"H-1B",   status:"expiring",startDate:"2024-03-01", expiryDate:"2026-04-30", petitionNo:"WAC2400287654", attorney:"Singh Law Group", notes:"Expires Apr 30 — 50 days out. Start renewal now." },
  { id:"wa9",  consultantId:"r9",  name:"Kiran Patel",     type:"OPT",    status:"expiring",startDate:"2025-08-01", expiryDate:"2026-05-15", petitionNo:"OPT-2025-009",  attorney:"InHouse",          notes:"OPT expires May 15. H-1B petition must be filed by Apr 1." },
  { id:"wa10", consultantId:"r10", name:"Sanjay Gupta",    type:"H-1B",   status:"active",  startDate:"2024-09-01", expiryDate:"2027-08-31", petitionNo:"WAC2400398765", attorney:"Reddy & Assoc",   notes:"Current. Renewal 2027." },
];

const DOCUMENTS_SEED = [
  { id:"doc1",  consultantId:"r1",  name:"Suresh Menon",    docType:"I-9",            issueDate:"2024-01-15", expiryDate:"2027-01-14", status:"current",  fileName:"i9_suresh.pdf",    notes:"" },
  { id:"doc2",  consultantId:"r1",  name:"Suresh Menon",    docType:"AT&T Badge",     issueDate:"2024-02-01", expiryDate:"2026-09-30", status:"current",  fileName:"badge_att.pdf",    notes:"Client badge — renew with contract." },
  { id:"doc3",  consultantId:"r2",  name:"Deepa Rao",       docType:"I-9",            issueDate:"2023-06-01", expiryDate:"2026-05-31", status:"expiring", fileName:"i9_deepa.pdf",     notes:"Tied to H-1B. Renew when visa renewed." },
  { id:"doc4",  consultantId:"r2",  name:"Deepa Rao",       docType:"NDA — AT&T",     issueDate:"2023-07-01", expiryDate:"2026-06-30", status:"expiring", fileName:"nda_deepa_att.pdf",notes:"NDA expires with engagement." },
  { id:"doc5",  consultantId:"r3",  name:"Vikram Singh",    docType:"I-9",            issueDate:"2022-03-10", expiryDate:"2032-03-09", status:"current",  fileName:"i9_vikram.pdf",    notes:"GC — long validity." },
  { id:"doc6",  consultantId:"r5",  name:"Arun Sharma",     docType:"I-9",            issueDate:"2023-04-15", expiryDate:"2026-04-14", status:"expiring", fileName:"i9_arun.pdf",      notes:"Expires same day as H-1B." },
  { id:"doc7",  consultantId:"r5",  name:"Arun Sharma",     docType:"Client B NDA",   issueDate:"2025-01-01", expiryDate:"2027-01-01", status:"current",  fileName:"nda_arun_clb.pdf", notes:"" },
  { id:"doc8",  consultantId:"r8",  name:"Priya Nair",      docType:"I-9",            issueDate:"2024-03-01", expiryDate:"2026-04-30", status:"expiring", fileName:"i9_priya.pdf",     notes:"Expires Apr 30." },
  { id:"doc9",  consultantId:"r9",  name:"Kiran Patel",     docType:"I-9 (OPT EAD)", issueDate:"2025-08-01", expiryDate:"2026-05-15", status:"expiring", fileName:"i9_kiran_opt.pdf", notes:"OPT EAD card expires May 15." },
  { id:"doc10", consultantId:"r9",  name:"Kiran Patel",     docType:"H-1B Petition",  issueDate:"2026-03-01", expiryDate:"2026-04-01", status:"urgent",   fileName:"",                 notes:"H-1B must be FILED by Apr 1. Not yet filed!" },
  { id:"doc11", consultantId:"r4",  name:"Ananya Krishnan", docType:"I-9",            issueDate:"2025-02-01", expiryDate:"2028-01-31", status:"current",  fileName:"i9_ananya.pdf",    notes:"" },
  { id:"doc12", consultantId:"r10", name:"Sanjay Gupta",    docType:"I-9",            issueDate:"2024-09-01", expiryDate:"2027-08-31", status:"current",  fileName:"i9_sanjay.pdf",    notes:"" },
];





// ─── HELPERS ─────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2,9);
const fmt = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
const fmtD = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:0,maximumFractionDigits:0}).format(n);
const pct = n => (n*100).toFixed(1)+"%";
const fmtDate = d => new Date(d+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});

function calcRoster(r) {
  const hrs = Math.round(r.util * BURDEN.hoursPerYear);
  const rev = hrs * r.billRate;
  let bonus = 0;
  if (r.revShare > 0 && r.baseSalary > 0) {
    const consRate = r.billRate * r.revShare;
    const salRate = r.baseSalary / BURDEN.hoursPerYear;
    bonus = Math.max(0, (consRate - salRate) * hrs);
  }
  const consTake = r.type === "Contractor" ? Math.round(r.fixedRate * hrs * r.revShare || r.fixedRate * hrs) : bonus;
  const thirdParty = r.type === "Contractor" && r.thirdPartySplit > 0
    ? Math.round((r.billRate - r.fixedRate) * hrs * r.thirdPartySplit) : 0;
  // Calculate totalCost FIRST so coKeeps can use it
  let totalCost = 0;
  if (r.type === "FTE") {
    const fica = r.baseSalary * BURDEN.fica;
    const futa = BURDEN.futa * Math.min(r.baseSalary, BURDEN.futaCap);
    const suta = BURDEN.suta * Math.min(r.baseSalary, BURDEN.sutaCap);
    const wc = r.baseSalary * BURDEN.wc;
    const ret = r.baseSalary * BURDEN.retire;
    const oth = r.baseSalary * BURDEN.other;
    totalCost = r.baseSalary + fica + futa + suta + wc + BURDEN.health + ret + oth + bonus;
  } else {
    totalCost = r.fixedRate * hrs + thirdParty + (r.insurance || 0);
  }
  // Co.Keeps = what the company nets after all costs
  // FTE: revenue minus full employment cost
  // Contractor: revenue minus what we pay the contractor + any third-party split
  const coKeeps = r.type === "FTE"
    ? rev - totalCost
    : rev - (r.fixedRate * hrs) - thirdParty - (r.revShare > 0 && r.baseSalary > 0 ? bonus : 0);
  const netMargin = rev > 0 ? (rev - totalCost) / rev : 0;
  return { hrs, rev, bonus, consTake, thirdParty, coKeeps, totalCost, netMargin };
}

const statusColors = { draft:"#94a3b8", sent:"#f59e0b", paid:"#10b981", overdue:"#ef4444", processed:"#10b981", pending:"#f59e0b" };
const statusBg    = { draft:"#1e293b", sent:"#451a03", paid:"#022c22", overdue:"#2d0a0a", processed:"#022c22", pending:"#451a03" };
const healthColor = { Green:"#10b981", Amber:"#f59e0b", Red:"#ef4444" };
const effortColor = { Low:"#10b981", Medium:"#f59e0b", High:"#ef4444" };
const pipelineColor = { "Offer Pending":"#10b981", "Reference Check":"#60a5fa", "Interviewing":"#f59e0b", "Screening":"#94a3b8" };

// ─── ICONS ───────────────────────────────────────────────────────────────────
const I = ({d,s=16}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
const ICONS = {
  dash:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  roster:"M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  ts:"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  clients:"M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  pipeline:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  ebitda:"M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
  pl:"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  adp:"M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
  fb:"M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  plus:"M12 4v16m8-8H4",
  x:"M6 18L18 6M6 6l12 12",
  check:"M5 13l4 4L19 7",
  trash:"M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
  edit:"M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  send:"M12 19l9 2-9-18-9 18 9-2zm0 0v-8",
  refresh:"M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
  back:"M15 19l-7-7 7-7",
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// AUTH SCREENS
// ═══════════════════════════════════════════════════════════════════════════════

function AuthCard({ children }) {
  return (
    <div style={{minHeight:"100vh",background:"#070b14",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <div style={{width:420,background:"#0f1623",border:"1px solid #1e2a3a",borderRadius:16,padding:"40px 44px",boxShadow:"0 24px 60px rgba(0,0,0,0.5)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:32}}>
          <span style={{color:"#38bdf8",fontWeight:900,fontSize:20,letterSpacing:1}}>◎ ZIKSATECH</span>
          <span style={{color:"#475569",fontSize:12,fontWeight:500,letterSpacing:2}}>OPS CENTER</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin, onGoRegister }) {
  const [email, setEmail] = useState("");
  const [pw, setPw]       = useState("");
  const [err, setErr]     = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const res = await supaAuth.signIn(email.trim(), pw);
      if (res.error || !res.access_token) { setErr(res.error?.message || res.msg || "Invalid email or password"); setLoading(false); return; }
      const profile = await supaAuth.getProfile(res.user.id, res.access_token);
      if (!profile) { setErr("Account not found. Contact admin."); setLoading(false); return; }
      if (profile.status === "pending")  { setErr("Your account is pending approval. Please wait for Manju to approve."); setLoading(false); return; }
      if (profile.status === "rejected") { setErr("Your access request was declined. Contact mmurthy@ziksatech.com."); setLoading(false); return; }
      supaAuth.saveSession(res);
      onLogin(res, profile);
    } catch(e) { setErr("Connection error. Try again."); setLoading(false); }
  }

  const inp = {width:"100%",background:"#0a0f1a",border:"1px solid #1e2a3a",borderRadius:8,padding:"10px 14px",color:"#e2e8f0",fontSize:14,outline:"none",boxSizing:"border-box"};
  const lbl = {display:"block",fontSize:12,color:"#94a3b8",marginBottom:6,fontWeight:600,letterSpacing:.5};

  return (
    <AuthCard>
      <h2 style={{color:"#e2e8f0",fontSize:22,fontWeight:700,margin:"0 0 6px"}}>Sign In</h2>
      <p style={{color:"#64748b",fontSize:13,margin:"0 0 28px"}}>Access your Ziksatech Ops dashboard</p>
      <form onSubmit={handleLogin}>
        <div style={{marginBottom:18}}>
          <label style={lbl}>Email</label>
          <input style={inp} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@ziksatech.com" required autoFocus />
        </div>
        <div style={{marginBottom:24}}>
          <label style={lbl}>Password</label>
          <input style={inp} type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" required />
        </div>
        {err && <div style={{background:"#3d1515",border:"1px solid #7f1d1d",borderRadius:8,padding:"10px 14px",color:"#fca5a5",fontSize:13,marginBottom:18}}>{err}</div>}
        <button type="submit" disabled={loading} style={{width:"100%",background:loading?"#1e3a5f":"#0ea5e9",border:"none",borderRadius:8,padding:"12px",color:"#fff",fontWeight:700,fontSize:15,cursor:loading?"not-allowed":"pointer"}}>
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </form>
      <p style={{textAlign:"center",marginTop:20,fontSize:13,color:"#64748b"}}>
        Don't have access? <span style={{color:"#38bdf8",cursor:"pointer",fontWeight:600}} onClick={onGoRegister}>Request Access</span>
      </p>
    </AuthCard>
  );
}

function RegisterScreen({ onGoLogin, onRegistered }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw]       = useState("");
  const [pw2, setPw2]     = useState("");
  const [role, setRole]   = useState("consultant");
  const [err, setErr]     = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister(e) {
    e.preventDefault();
    setErr("");
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    if (pw.length < 6) { setErr("Password must be at least 6 characters."); return; }
    setLoading(true);
    try {
      const res = await supaAuth.signUp(email.trim(), pw, name.trim(), role);
      if (res.error) { setErr(res.error.message || "Registration failed. Try again."); setLoading(false); return; }
      onRegistered(email);
    } catch(e) { setErr("Connection error. Try again."); setLoading(false); }
  }

  const inp = {width:"100%",background:"#0a0f1a",border:"1px solid #1e2a3a",borderRadius:8,padding:"10px 14px",color:"#e2e8f0",fontSize:14,outline:"none",boxSizing:"border-box"};
  const lbl = {display:"block",fontSize:12,color:"#94a3b8",marginBottom:6,fontWeight:600,letterSpacing:.5};
  const sel = {...inp,cursor:"pointer"};

  return (
    <AuthCard>
      <h2 style={{color:"#e2e8f0",fontSize:22,fontWeight:700,margin:"0 0 6px"}}>Request Access</h2>
      <p style={{color:"#64748b",fontSize:13,margin:"0 0 28px"}}>Submit your details — Manju will approve your account</p>
      <form onSubmit={handleRegister}>
        <div style={{marginBottom:16}}>
          <label style={lbl}>Full Name</label>
          <input style={inp} value={name} onChange={e=>setName(e.target.value)} placeholder="Suresh Menon" required autoFocus />
        </div>
        <div style={{marginBottom:16}}>
          <label style={lbl}>Work Email</label>
          <input style={inp} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@email.com" required />
        </div>
        <div style={{marginBottom:16}}>
          <label style={lbl}>Role</label>
          <select style={sel} value={role} onChange={e=>setRole(e.target.value)}>
            <option value="consultant">Consultant</option>
            <option value="manager">Manager</option>
            <option value="finance">Finance</option>
            <option value="hr">HR</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div style={{marginBottom:16}}>
          <label style={lbl}>Password</label>
          <input style={inp} type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Min 6 characters" required />
        </div>
        <div style={{marginBottom:24}}>
          <label style={lbl}>Confirm Password</label>
          <input style={inp} type="password" value={pw2} onChange={e=>setPw2(e.target.value)} placeholder="Repeat password" required />
        </div>
        {err && <div style={{background:"#3d1515",border:"1px solid #7f1d1d",borderRadius:8,padding:"10px 14px",color:"#fca5a5",fontSize:13,marginBottom:18}}>{err}</div>}
        <button type="submit" disabled={loading} style={{width:"100%",background:loading?"#1e3a5f":"#0ea5e9",border:"none",borderRadius:8,padding:"12px",color:"#fff",fontWeight:700,fontSize:15,cursor:loading?"not-allowed":"pointer"}}>
          {loading ? "Submitting…" : "Request Access"}
        </button>
      </form>
      <p style={{textAlign:"center",marginTop:20,fontSize:13,color:"#64748b"}}>
        Already have access? <span style={{color:"#38bdf8",cursor:"pointer",fontWeight:600}} onClick={onGoLogin}>Sign In</span>
      </p>
    </AuthCard>
  );
}

function PendingScreen({ email, onGoLogin }) {
  return (
    <AuthCard>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:16}}>⏳</div>
        <h2 style={{color:"#e2e8f0",fontSize:22,fontWeight:700,margin:"0 0 10px"}}>Request Submitted!</h2>
        <p style={{color:"#94a3b8",fontSize:14,lineHeight:1.6,marginBottom:8}}>
          Your access request for <strong style={{color:"#38bdf8"}}>{email}</strong> has been submitted.
        </p>
        <p style={{color:"#64748b",fontSize:13,lineHeight:1.6,marginBottom:28}}>
          Manju will review and approve your account. You'll be able to sign in once approved.
        </p>
        <button onClick={onGoLogin} style={{background:"#0f1e30",border:"1px solid #1e3a5f",borderRadius:8,padding:"10px 24px",color:"#38bdf8",fontWeight:600,fontSize:14,cursor:"pointer"}}>
          Back to Sign In
        </button>
      </div>
    </AuthCard>
  );
}

export default function ZiksatechOps() {
  const [tab, setTab] = useState("home");
  const [roster, setRoster] = useState(ROSTER_SEED);
  const [pipeline, setPipeline] = useState(PIPELINE_SEED);
  const [clients, setClients] = useState(CLIENTS_SEED);
  const [tsHours, setTsHours] = useState(TS_HOURS_SEED);
  const [plIncome, setPlIncome] = useState(PL_INCOME_SEED);
  const [plExpense, setPlExpense] = useState(PL_EXPENSE_SEED);
  const [ebitdaLevers, setEbitdaLevers] = useState(EBITDA_LEVERS_SEED);
  const [fbInvoices, setFbInvoices] = useState(FB_INVOICES_SEED);
  const [adpRuns, setAdpRuns] = useState(ADP_RUNS_SEED);
  const [finInvoices, setFinInvoices] = useState(FIN_INVOICES_SEED);
  const [finPayments, setFinPayments] = useState(FIN_PAYMENTS_SEED);
  const [finExpenses, setFinExpenses] = useState(FIN_EXPENSES_SEED);
  // Recruiting
  const [candidates, setCandidates]   = useState(CANDIDATES_SEED);
  const [submissions, setSubmissions] = useState(SUBMISSIONS_SEED);
  const [interviews, setInterviews]   = useState(INTERVIEWS_SEED);
  const [offers, setOffers]           = useState(OFFERS_SEED);
  // Compliance
  const [workAuth, setWorkAuth]       = useState(WORK_AUTH_SEED);
  const [compDocs, setCompDocs]       = useState(DOCUMENTS_SEED);
  // Org & Access
  const [orgMembers, setOrgMembers]     = useState(ORG_MEMBERS_SEED);
  // Cash Flow overrides
  const [cfOverrides, setCfOverrides] = useState({});
  // Proposals
  const [proposals, setProposals] = useState(PROPOSALS_SEED);
  // Benefits
  const [benefits, setBenefits] = useState(BENEFITS_SEED);
  // E-Signature requests
  const [esignRequests, setEsignRequests] = useState(ESIGN_SEED);
  // Onboarding checklists
  const [onboardings, setOnboardings] = useState(ONBOARDING_SEED);
  // Audit log
  const [auditLog, setAuditLog] = useState(AUDIT_SEED);
  // Notifications
  const [dismissedAlerts, setDismissedAlerts] = useState([]);
  // PTO & Leave
  const [ptoRequests, setPtoRequests]   = useState(PTO_REQUESTS_SEED);
  const [ptoBalances, setPtoBalances]   = useState(PTO_BALANCES_SEED);
  // Vendor / AP
  const [vendors, setVendors]             = useState(VENDORS_SEED);
  const [apInvoices, setApInvoices]       = useState(AP_INVOICES_SEED);
  // Change Orders
  const [changeOrders, setChangeOrders]   = useState(CHANGE_ORDERS_SEED);
  // Timesheet Approvals
  const [tsSubmissions, setTsSubmissions] = useState(TS_SUBMISSIONS_SEED);
  // Contracts & SOW
  const [contracts, setContracts]       = useState(CONTRACTS_SEED);
  const [sows, setSows]                 = useState(SOW_SEED);
  // Projects
  const [projects, setProjects]         = useState(PROJECTS_SEED);
  const [tasks, setTasks]               = useState(TASKS_SEED);
  const [risks, setRisks]               = useState(RISKS_SEED);
  // Sales CRM
  const [crmAccounts, setCrmAccounts]   = useState(CRM_ACCOUNTS_SEED);
  const [crmContacts, setCrmContacts]   = useState(CRM_CONTACTS_SEED);
  const [crmDeals, setCrmDeals]         = useState(CRM_DEALS_SEED);
  const [crmActivities, setCrmActivities] = useState(CRM_ACTIVITIES_SEED);
  const [loaded, setLoaded] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [appSettings, setAppSettings] = useState({
    ownerName: "Manju",
    ownerEmail: "manju@ziksatech.com",
    companyName: "Ziksatech LLC",
    companyWebsite: "ziksatech.com",
    fiscalYearStart: "January",
    defaultBillRate: 150,
    currency: "USD",
    timezone: "America/Chicago",
  });
  const [colorMode, setColorMode]       = useState('dark'); // 'dark' | 'light'
  const [cmdOpen,    setCmdOpen]        = useState(false);
  const [cmdQuery,   setCmdQuery]       = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState("idle"); // idle | saving | saved | error
  const [backupModal, setBackupModal] = useState(false);
  // Prevent auto-save from overwriting Supabase data on initial load
  const skipSaveRef = useRef(true); // true = skip, set to false after first load completes
  const [restoreError, setRestoreError] = useState("");
  const [restoreSuccess, setRestoreSuccess] = useState("");

  // ── Mobile responsive ─────────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(() => typeof window!=="undefined" && window.innerWidth < 768);
  const [sideOpen, setSideOpen] = useState(false);

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [authView, setAuthView] = useState("login"); // login | register | pending
  const [authSession, setAuthSession] = useState(() => supaAuth ? supaAuth.loadSession() : null);
  const [authProfile, setAuthProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  useEffect(()=>{
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  useEffect(()=>{ if(isMobile) setSideOpen(false); }, [tab]);

  // ── Auth bootstrap — restore session on load ───────────────────────────────
  useEffect(()=>{
    if (!supaAuth) { setAuthLoading(false); return; }
    const sess = supaAuth.loadSession();
    if (!sess?.access_token) { setAuthLoading(false); return; }
    supaAuth.getUser(sess.access_token).then(async user => {
      if (user?.id) {
        const profile = await supaAuth.getProfile(user.id, sess.access_token);
        if (profile) { setAuthSession(sess); setAuthProfile(profile); }
        else supaAuth.clearSession();
      } else { supaAuth.clearSession(); }
      setAuthLoading(false);
    }).catch(() => { supaAuth.clearSession(); setAuthLoading(false); });
  }, []);

  // ── Color mode ──────────────────────────────────────────────
  useEffect(()=>{
    if (colorMode==="light") document.body.classList.add("light-mode");
    else document.body.classList.remove("light-mode");
  },[colorMode]);

  // ── Cmd+K / Ctrl+K command palette ───────────────────────────
  useEffect(()=>{
    const down = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      const typing = tag==="input"||tag==="textarea"||tag==="select"||document.activeElement?.contentEditable==="true";
      if ((e.metaKey||e.ctrlKey) && e.key==="k" && !typing) { e.preventDefault(); setCmdOpen(o=>!o); setCmdQuery(""); setCmdSel(0); }
      if (e.key==="Escape" && cmdOpen) setCmdOpen(false);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  },[cmdOpen]);

  // ── collect all data into one snapshot ──
  const allData = () => ({
    version: 2,
    savedAt: new Date().toISOString(),
    roster, pipeline, clients, tsHours, plIncome, plExpense, ebitdaLevers, fbInvoices, adpRuns, finInvoices, finPayments, finExpenses, candidates, submissions, interviews, offers, workAuth, compDocs, crmAccounts, crmContacts, crmDeals, crmActivities, contracts, sows, projects, tasks, risks, orgMembers, tsSubmissions, changeOrders, vendors, apInvoices, cfOverrides, setCfOverrides
  });

  useEffect(() => {
    (async () => {
      const keys = ["roster","pipeline","clients","tsHours","plIncome","plExpense","ebitdaLevers","fbInvoices","adpRuns","finInvoices","finPayments","finExpenses","candidates","submissions","interviews","offers","workAuth","compDocs","crmAccounts","crmContacts","crmDeals","crmActivities","contracts","sows","projects","tasks","risks","orgMembers","tsSubmissions","changeOrders","vendors","apInvoices","cfOverrides","ptoRequests","ptoBalances","dismissedAlerts","auditLog","proposals","benefits","esignRequests","onboardings"];
      const setters = [setRoster,setPipeline,setClients,setTsHours,setPlIncome,setPlExpense,setEbitdaLevers,setFbInvoices,setAdpRuns,setFinInvoices,setFinPayments,setFinExpenses,setCandidates,setSubmissions,setInterviews,setOffers,setWorkAuth,setCompDocs,setCrmAccounts,setCrmContacts,setCrmDeals,setCrmActivities,setContracts,setSows,setProjects,setTasks,setRisks,setOrgMembers,setTsSubmissions,setChangeOrders,setVendors,setApInvoices,setCfOverrides,setPtoRequests,setPtoBalances,setDismissedAlerts,setAuditLog,setProposals,setBenefits,setEsignRequests,setOnboardings,(v)=>setAppSettings(p=>({...p,...v}))];
      const results = await Promise.all(keys.map(k => store.get("zt-"+k)));
      results.forEach((r,i) => { if(r) setters[i](r); });
      // load last-saved timestamp
      const meta = await store.get("zt-meta");
      if (meta?.lastSaved) setLastSaved(new Date(meta.lastSaved));
      setLoaded(true);
      // Allow auto-saves AFTER initial load is complete
      setTimeout(() => { skipSaveRef.current = false; }, 500);
    })();
  },[]);

  // ── auto-save to window.storage on every change ──
  useEffect(() => {
    if (!loaded) return;
    if (skipSaveRef.current) return; // Skip save during initial load — prevents seed data overwriting real DB data
    setSaveStatus("saving");
    const t = setTimeout(async () => {
      try {
        await Promise.all([
          store.set("zt-roster",roster), store.set("zt-pipeline",pipeline),
          store.set("zt-clients",clients), store.set("zt-tsHours",tsHours),
          store.set("zt-plIncome",plIncome), store.set("zt-plExpense",plExpense),
          store.set("zt-ebitdaLevers",ebitdaLevers), store.set("zt-fbInvoices",fbInvoices),
          store.set("zt-adpRuns",adpRuns), store.set("zt-finInvoices",finInvoices),
          store.set("zt-finPayments",finPayments), store.set("zt-finExpenses",finExpenses),
          store.set("zt-candidates",candidates), store.set("zt-submissions",submissions),
          store.set("zt-interviews",interviews), store.set("zt-offers",offers),
          store.set("zt-workAuth",workAuth), store.set("zt-compDocs",compDocs),
          store.set("zt-crmAccounts",crmAccounts), store.set("zt-crmContacts",crmContacts),
          store.set("zt-crmDeals",crmDeals), store.set("zt-crmActivities",crmActivities),
          store.set("zt-contracts",contracts), store.set("zt-sows",sows),
          store.set("zt-projects",projects), store.set("zt-tasks",tasks), store.set("zt-risks",risks),
          store.set("zt-orgMembers",orgMembers), store.set("zt-tsSubmissions",tsSubmissions),
          store.set("zt-changeOrders",changeOrders),
          store.set("zt-vendors",vendors), store.set("zt-apInvoices",apInvoices),
          store.set("zt-cfOverrides",cfOverrides),
          store.set("zt-ptoRequests",ptoRequests), store.set("zt-ptoBalances",ptoBalances),
          store.set("zt-dismissedAlerts",dismissedAlerts),
          store.set("zt-auditLog",auditLog),
          store.set("zt-proposals",proposals),
          store.set("zt-benefits",benefits),
          store.set("zt-esignRequests",esignRequests),
          store.set("zt-onboardings",onboardings),
          store.set("zt-appSettings",appSettings),
        ]);
        const now = new Date();
        await store.set("zt-meta", { lastSaved: now.toISOString() });
        setLastSaved(now);
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2500);
      } catch(e) { setSaveStatus("error"); }
    }, 800); // debounce 800ms
    return () => clearTimeout(t);
  },[roster,pipeline,clients,tsHours,plIncome,plExpense,ebitdaLevers,fbInvoices,adpRuns,finInvoices,finPayments,finExpenses,candidates,submissions,interviews,offers,workAuth,compDocs,crmAccounts,crmContacts,crmDeals,crmActivities,contracts,sows,projects,tasks,risks,orgMembers,tsSubmissions,changeOrders,vendors,apInvoices,cfOverrides,ptoRequests,ptoBalances,dismissedAlerts,auditLog,proposals,benefits,esignRequests,onboardings,loaded]);

  // ── export full backup JSON ──
  const exportBackup = () => {
    const data = allData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type:"application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0,16).replace("T","_").replace(/:/g,"-");
    const a = document.createElement("a");
    a.href = url; a.download = `ziksatech_ops_backup_${ts}.json`;
    a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
  };

  // ── restore from backup JSON ──
  const restoreBackup = (text) => {
    setRestoreError(""); setRestoreSuccess("");
    try {
      const d = JSON.parse(text);
      if (!d.roster || !d.clients) throw new Error("Invalid backup file — missing required fields.");
      if (d.roster)       setRoster(d.roster);
      if (d.pipeline)     setPipeline(d.pipeline);
      if (d.clients)      setClients(d.clients);
      if (d.tsHours)      setTsHours(d.tsHours);
      if (d.plIncome)     setPlIncome(d.plIncome);
      if (d.plExpense)    setPlExpense(d.plExpense);
      if (d.ebitdaLevers) setEbitdaLevers(d.ebitdaLevers);
      if (d.fbInvoices)   setFbInvoices(d.fbInvoices);
      if (d.adpRuns)      setAdpRuns(d.adpRuns);
      if (d.finInvoices)  setFinInvoices(d.finInvoices);
      if (d.finPayments)  setFinPayments(d.finPayments);
      if (d.finExpenses)  setFinExpenses(d.finExpenses);
      if (d.candidates)   setCandidates(d.candidates);
      if (d.submissions)  setSubmissions(d.submissions);
      if (d.interviews)   setInterviews(d.interviews);
      if (d.offers)       setOffers(d.offers);
      if (d.workAuth)     setWorkAuth(d.workAuth);
      if (d.compDocs)     setCompDocs(d.compDocs);
      if (d.crmAccounts)  setCrmAccounts(d.crmAccounts);
      if (d.crmContacts)  setCrmContacts(d.crmContacts);
      if (d.crmDeals)     setCrmDeals(d.crmDeals);
      if (d.crmActivities)setCrmActivities(d.crmActivities);
      if (d.contracts)    setContracts(d.contracts);
      if (d.sows)         setSows(d.sows);
      if (d.projects)     setProjects(d.projects);
      if (d.tasks)        setTasks(d.tasks);
      if (d.risks)        setRisks(d.risks);
      if (d.orgMembers)   setOrgMembers(d.orgMembers);
      if (d.tsSubmissions) setTsSubmissions(d.tsSubmissions);
      if (d.changeOrders)  setChangeOrders(d.changeOrders);
      if (d.vendors)       setVendors(d.vendors);
      if (d.apInvoices)    setApInvoices(d.apInvoices);
      if (d.cfOverrides)   setCfOverrides(d.cfOverrides||{});
      if (d.ptoRequests)   setPtoRequests(d.ptoRequests);
      if (d.ptoBalances)   setPtoBalances(d.ptoBalances);
      if (d.dismissedAlerts) setDismissedAlerts(d.dismissedAlerts||[]);
      if (d.auditLog)       setAuditLog(d.auditLog||AUDIT_SEED);
      if (d.proposals)      setProposals(d.proposals||PROPOSALS_SEED);
      if (d.benefits)       setBenefits(d.benefits||BENEFITS_SEED);
      if (d.esignRequests)  setEsignRequests(d.esignRequests||ESIGN_SEED);
      if (d.onboardings)    setOnboardings(d.onboardings||ONBOARDING_SEED);
      const savedAt = d.savedAt ? new Date(d.savedAt).toLocaleString() : "unknown date";
      setRestoreSuccess(`✓ Restored from backup saved on ${savedAt}`);
    } catch(e) { setRestoreError("Could not restore: " + e.message); }
  };

  const nav = [
    { id:"dashboard",   label:"Executive Dashboard", icon:ICONS.dash,     group:"Overview" },
    { id:"notifications",label:"Notifications",          icon:ICONS.dash,     group:"Overview" },
    { id:"auditlog",     label:"Audit Log",            icon:ICONS.dash,     group:"Overview" },
    { id:"pdfexport",    label:"PDF Export",           icon:ICONS.pl,       group:"Overview" },
    { id:"settings",     label:"Settings",             icon:ICONS.org,      group:"Overview" },
    { id:"proposals",    label:"Proposals & Quotes",   icon:ICONS.pl,       group:"Sales" },
    { id:"emailtpl",     label:"Email Templates",       icon:ICONS.dash,     group:"Sales" },
    { id:"taxcal",       label:"Tax Calendar",          icon:ICONS.pl,       group:"Finance" },
    { id:"benefits",     label:"Benefits Tracker",      icon:ICONS.pl,       group:"Finance" },
    { id:"reports",      label:"Report Builder",        icon:ICONS.pl,       group:"Overview" },
    { id:"portal",       label:"Client Portal",         icon:ICONS.dash,     group:"Overview" },
    { id:"glexport",     label:"QB GL Export",          icon:ICONS.pl,       group:"Finance" },
    { id:"esign",        label:"E-Signature",           icon:ICONS.pl,       group:"Overview" },
    { id:"capacity",     label:"Capacity Planner",      icon:ICONS.dash,     group:"Delivery" },
    { id:"budget",       label:"Budget vs. Actual",     icon:ICONS.pl,       group:"Finance"  },
    { id:"onboarding",   label:"Onboarding",            icon:ICONS.dash,     group:"Hiring"   },
    { id:"org",          label:"Org & Access",         icon:ICONS.roster,   group:"Overview" },
    { id:"myprofile",     label:"My Profile",            icon:ICONS.roster,   group:"Overview" },
    { id:"roster",      label:"Team Roster",          icon:ICONS.roster,   group:"Delivery" },
    { id:"timesheet",   label:"Timesheet",            icon:ICONS.ts,       group:"Delivery" },
    { id:"clients",     label:"Client Portfolio",     icon:ICONS.clients,  group:"Delivery" },
    { id:"ebitda",      label:"EBITDA Optimizer",     icon:ICONS.ebitda,   group:"Delivery" },
    { id:"contracts",   label:"Contracts & SOW",      icon:ICONS.clients,  group:"Sales" },
    { id:"projects",    label:"Project Tracker",       icon:ICONS.ts,       group:"Delivery" },
    { id:"profitability",label:"Project P&L",            icon:ICONS.pl,       group:"Delivery" },
    { id:"changeorders", label:"Change Orders",         icon:ICONS.edit,     group:"Delivery" },
    { id:"crm",         label:"Sales CRM",            icon:ICONS.clients,  group:"Sales" },
    { id:"recruiting",  label:"Recruiting",           icon:ICONS.pipeline, group:"Hiring" },
    { id:"pipeline",    label:"Hiring Pipeline",      icon:ICONS.pipeline, group:"Hiring" },
    { id:"finance",     label:"Finance",              icon:ICONS.pl,       group:"Finance" },
    { id:"pl",          label:"P&L / Income",         icon:ICONS.pl,       group:"Finance" },
    { id:"vendors",     label:"Vendors & AP",         icon:ICONS.pl,       group:"Finance" },
    { id:"adp",         label:"ADP Payroll",          icon:ICONS.adp,      group:"Finance" },
    { id:"cashflow",    label:"Cash Flow Forecast",  icon:ICONS.pl,       group:"Finance" },
    { id:"freshbooks",  label:"FreshBooks",           icon:ICONS.fb,       group:"Finance" },
    { id:"pto",         label:"PTO & Leave",          icon:ICONS.dash,     group:"Compliance" },
    { id:"compliance",  label:"Compliance",           icon:ICONS.dash,     group:"Compliance" },
  ];

  const shared = { roster, setRoster, pipeline, setPipeline, clients, setClients, tsHours, setTsHours, plIncome, setPlIncome, plExpense, setPlExpense, ebitdaLevers, setEbitdaLevers, fbInvoices, setFbInvoices, adpRuns, setAdpRuns, finInvoices, setFinInvoices, finPayments, setFinPayments, finExpenses, setFinExpenses, candidates, setCandidates, submissions, setSubmissions, interviews, setInterviews, offers, setOffers, workAuth, setWorkAuth, compDocs, setCompDocs, crmAccounts, setCrmAccounts, crmContacts, setCrmContacts, crmDeals, setCrmDeals, crmActivities, setCrmActivities, contracts, setContracts, sows, setSows, projects, setProjects, tasks, setTasks, risks, setRisks, orgMembers, setOrgMembers, tsSubmissions, setTsSubmissions, changeOrders, setChangeOrders, vendors, setVendors, apInvoices, setApInvoices, cfOverrides, setCfOverrides, ptoRequests, setPtoRequests, ptoBalances, setPtoBalances, dismissedAlerts, setDismissedAlerts, auditLog, setAuditLog, proposals, setProposals, benefits, setBenefits, esignRequests, setEsignRequests, onboardings, setOnboardings,
    appSettings, setAppSettings,
    globalSearch, setGlobalSearch, searchOpen, setSearchOpen,
    addAudit: makeAddAudit(setAuditLog, appSettings.ownerName),
    setTab };

  // ── Auth gate — show login/register/pending if not authenticated ─────────
  if (supaAuth) {
    if (authLoading) return (
      <div style={{minHeight:"100vh",background:"#070b14",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{color:"#38bdf8",fontSize:18,fontWeight:600}}>◎ Loading…</div>
      </div>
    );
    if (!authSession || !authProfile) {
      if (authView === "register") return <RegisterScreen onGoLogin={()=>setAuthView("login")} onRegistered={(email)=>{ setAuthView("pending_"+email); }} />;
      if (authView.startsWith("pending_")) return <PendingScreen email={authView.replace("pending_","")} onGoLogin={()=>setAuthView("login")} />;
      return <LoginScreen onGoLogin={()=>setAuthView("login")} onGoRegister={()=>setAuthView("register")}
        onLogin={(sess,profile)=>{ setAuthSession(sess); setAuthProfile(profile); }} />;
    }
  }

  return (
    <div style={{fontFamily:"'DM Sans','Segoe UI',sans-serif",background:"#070b14",minHeight:"100vh",color:"#e2e8f0",display:"flex"}}>
      <style>{`
/* ── Light mode override ───────────────────────────────────── */
body.light-mode {
  --bg-base:      #f0f4f8;
  --bg-card:      #ffffff;
  --bg-sidebar:   #e8eef5;
  --text-primary: #1e293b;
  --text-sec:     #64748b;
  --border:       #cbd5e1;
}
body.light-mode .sidebar { background: #e8eef5 !important; border-right: 1px solid #cbd5e1 !important; }
body.light-mode .card { background: #ffffff !important; border-color: #e2e8f0 !important;   overflow-x: auto;
}
body.light-mode .inp { background: #f8fafc !important; border-color: #cbd5e1 !important; color: #1e293b !important; }
body.light-mode .tr { border-bottom-color: #e2e8f0 !important; color: #475569 !important; }
body.light-mode .th { color: #64748b !important; }
body.light-mode .btn { color: #475569 !important; border-color: #cbd5e1 !important; background: #f8fafc !important; }
body.light-mode .btn:hover { border-color: #0284c7 !important; color: #0284c7 !important; }
body.light-mode .modal { background: #ffffff !important; border-color: #e2e8f0 !important; }
body.light-mode .modal-bg { background: rgba(0,0,0,0.4) !important; }
body.light-mode .section-hdr { color: #0369a1 !important; border-color: #bfdbfe !important; }
body.light-mode .lbl { color: #64748b !important; }
body.light-mode .bdg { background: #f1f5f9 !important; }
body.light-mode .mono { color: #1e293b !important; }
body.light-mode body, body.light-mode #root { background: #f0f4f8 !important; }


        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#0b1120}::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:4px}
        input,select,textarea{font-family:inherit}
        .navi{display:flex;align-items:center;gap:9px;padding:9px 14px;border-radius:9px;cursor:pointer;transition:all 0.15s;color:#475569;font-size:13px;font-weight:500;border:none;background:none;width:100%;text-align:left;white-space:nowrap}
        .navi:hover{background:#0f1e30;color:#7dd3fc}
        .navi.on{background:linear-gradient(135deg,#0c2340,#0d1f38);color:#38bdf8;border-left:2px solid #0284c7}
        .btn{padding:8px 16px;border-radius:8px;border:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px}
        .bp{background:linear-gradient(135deg,#0369a1,#0284c7);color:#fff}.bp:hover{background:linear-gradient(135deg,#0284c7,#38bdf8);transform:translateY(-1px)}
        .bg{background:#0f1e30;color:#7dd3fc;border:1px solid #1e3a5f}.bg:hover{background:#142840;color:#bae6fd}
        .br{background:#1a0808;color:#f87171;border:1px solid #3d1010}.br:hover{background:#240c0c}
        .bs{background:#021f14;color:#34d399;border:1px solid #063d28}.bs:hover{background:#032a1c}
        .card{background:#0b1120;border:1px solid #1a2d45;border-radius:12px}
        .inp{background:#0b1120;border:1px solid #1a2d45;border-radius:8px;padding:8px 12px;color:#e2e8f0;font-size:13px;width:100%;outline:none;transition:border 0.15s}
        .inp:focus{border-color:#0284c7}
        .lbl{font-size:11px;font-weight:700;color:#3d5a7a;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:5px;display:block}
        .bdg{padding:2px 9px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em}
        .tr{display:grid;align-items:center;padding:12px 18px;border-bottom:1px solid #111d2d;transition:background 0.12s}
        .tr:hover{background:#0a1626}.tr:last-child{border-bottom:none}
        .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)}
        .modal{background:#0b1120;border:1px solid #1a2d45;border-radius:16px;padding:26px;width:100%;max-width:580px;max-height:90vh;overflow-y:auto}
        .mono{font-family:'DM Mono',monospace}
        .pos{color:#34d399}.neg{color:#f87171}.neu{color:#94a3b8}
        select option{background:#0b1120}
        .th{font-size:10px;font-weight:700;color:#2d4a63;text-transform:uppercase;letter-spacing:0.07em}
        .section-hdr{padding:14px 18px;border-bottom:1px solid #111d2d;font-weight:700;font-size:13px;color:#7dd3fc;display:flex;align-items:center;justify-content:space-between}
        .adp-badge{background:linear-gradient(135deg,#cc0000,#990000);color:white;font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px;letter-spacing:0.05em}
        .fb-badge{background:linear-gradient(135deg,#0075dd,#0055aa);color:white;font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px;letter-spacing:0.05em}
        /* Mobile nav bar */
        .mobile-nav{display:none}
        @media(max-width:767px){
          .mobile-nav{display:flex;position:fixed;bottom:0;left:0;right:0;z-index:90;background:#060a10;border-top:1px solid #1a2d45;height:58px}
          .desktop-sidebar{display:none!important}
          .main-content{padding-bottom:68px!important;padding-left:12px!important;padding-right:12px!important}
          .kpi-grid-4{grid-template-columns:1fr 1fr!important}
          .kpi-grid-5{grid-template-columns:1fr 1fr!important}
          .two-col{grid-template-columns:1fr!important}
          .three-col{grid-template-columns:1fr!important}
          .hide-mobile{display:none!important}
          h1{font-size:18px!important}
          .tr{padding:10px 12px!important}
        }
        @media(min-width:768px){
          .mobile-topbar{display:none!important}
        }
      `}</style>

      {/* Mobile overlay when sidebar open */}
      {isMobile && sideOpen && (
        <div onClick={()=>setSideOpen(false)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:89,backdropFilter:"blur(2px)"}}/>
      )}

      {/* Mobile top bar */}
      <div className="mobile-topbar" style={{position:"fixed",top:0,left:0,right:0,zIndex:90,background:"#060a10",borderBottom:"1px solid #0f1e30",
        height:52,display:"flex",alignItems:"center",padding:"0 16px",gap:12}}>
        <button onClick={()=>setSideOpen(s=>!s)}
          style={{background:"none",border:"none",color:"#38bdf8",cursor:"pointer",padding:"6px",borderRadius:8,display:"flex",flexDirection:"column",gap:4}}>
          {[0,1,2].map(i=><div key={i} style={{width:20,height:2,background:"#38bdf8",borderRadius:2,transition:"all 0.2s",
            transform:sideOpen&&i===0?"rotate(45deg) translate(4px,4px)":sideOpen&&i===2?"rotate(-45deg) translate(4px,-4px)":"none",
            opacity:sideOpen&&i===1?0:1}}/>)}
        </button>
        <div onClick={()=>setTab("home")} style={{fontSize:15,fontWeight:800,color:"#38bdf8",cursor:"pointer"}} title="Home">⬡ ZIKSATECH</div>
        <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
          <button onClick={()=>setTab("home")} title="Home" style={{background:"none",border:"1px solid #1e2a3a",borderRadius:6,color:"#38bdf8",fontSize:11,fontWeight:700,padding:"3px 10px",cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
            🏠 Home
          </button>
          <div style={{width:7,height:7,borderRadius:"50%",background:saveStatus==="saved"?"#34d399":saveStatus==="saving"?"#f59e0b":"#1e3a5f"}}/>
          <span style={{fontSize:10,color:"#3d5a7a"}}>{saveStatus==="saved"?"Saved":saveStatus==="saving"?"Saving…":"Auto-save"}</span>
        </div>
      </div>

      {/* Sidebar — slides in on mobile, fixed on desktop */}
      <aside className="desktop-sidebar" style={{
        width:210, background:"#060a10", borderRight:"1px solid #0f1e30",
        padding:"20px 10px", display:"flex", flexDirection:"column", gap:2,
        position: isMobile ? "fixed" : "sticky",
        top: isMobile ? 0 : 0,
        left: isMobile ? (sideOpen ? 0 : -220) : 0,
        height:"100vh", flexShrink:0, overflowY:"auto",
        zIndex: isMobile ? 91 : 1,
        transition: isMobile ? "left 0.25s cubic-bezier(0.4,0,0.2,1)" : "none",
        boxShadow: isMobile && sideOpen ? "4px 0 24px rgba(0,0,0,0.5)" : "none",
      }}>
        <div style={{padding:"8px 14px 18px",borderBottom:"1px solid #0f1e30",marginBottom:6}}>
          <div onClick={()=>setTab("home")} style={{fontSize:16,fontWeight:800,color:"#38bdf8",letterSpacing:"-0.03em",cursor:"pointer",display:"flex",alignItems:"center",gap:6}} title="Go to Home">
            ⬡ ZIKSATECH
          </div>
          <div onClick={()=>setTab("home")} style={{fontSize:10,color:"#1e3a5f",marginTop:1,letterSpacing:"0.1em",textTransform:"uppercase",cursor:"pointer"}}>Ops Center</div>
          {supaAuth && authProfile && (
            <div style={{marginTop:10,padding:"8px 10px",background:"#0a1120",borderRadius:8,border:"1px solid #0f1e30"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{overflow:"hidden"}}>
                  <div style={{fontSize:11,fontWeight:600,color:"#cbd5e1",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{authProfile.full_name}</div>
                  <div style={{fontSize:10,color:authProfile.role==="super_admin"?"#f59e0b":"#475569",marginTop:1,textTransform:"capitalize"}}>
                    {authProfile.role==="super_admin"?"⭐ Super Admin":authProfile.role} · {authProfile.status==="approved"?"✓ Active":"Pending"}
                  </div>
                </div>
                <button onClick={async()=>{ await supaAuth.signOut(authSession?.access_token); supaAuth.clearSession(); setAuthSession(null); setAuthProfile(null); }}
                  style={{background:"none",border:"1px solid #1e2a3a",borderRadius:6,color:"#94a3b8",fontSize:10,padding:"3px 8px",cursor:"pointer",flexShrink:0,marginLeft:6}}>
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Global Search */}
        <div style={{padding:"0 10px 10px"}}>
          <div style={{position:"relative"}}>
            <input
              className="inp"
              style={{fontSize:12,padding:"6px 10px 6px 28px",width:"100%"}}
              placeholder="Search… (⌘K for commands)"
              value={globalSearch}
              onChange={e=>{setGlobalSearch(e.target.value);if(e.target.value.length>0)setSearchOpen(true);else setSearchOpen(false);}}
              onFocus={()=>{if(globalSearch.length>0)setSearchOpen(true);}}
              onBlur={()=>setTimeout(()=>setSearchOpen(false),200)}
            />
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3d5a7a" strokeWidth="2.5"
              style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            {globalSearch&&<button onClick={()=>{setGlobalSearch("");setSearchOpen(false);}}
              style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"#3d5a7a",cursor:"pointer",fontSize:14,lineHeight:1}}>×</button>}
          </div>
      <CommandPalette cmdOpen={cmdOpen} setCmdOpen={setCmdOpen} cmdQuery={cmdQuery} setCmdQuery={setCmdQuery} setTab={setTab}/>
          {searchOpen&&globalSearch.length>1&&<GlobalSearchResults q={globalSearch} roster={shared.roster} finInvoices={shared.finInvoices} apInvoices={shared.apInvoices} projects={shared.projects} crmDeals={shared.crmDeals} clients={shared.clients} tsSubmissions={shared.tsSubmissions} workAuth={shared.workAuth} setTab={setTab} onClose={()=>setSearchOpen(false)}/>}
        </div>

        <button onClick={()=>setTab("home")}
          style={{width:"calc(100% - 20px)",margin:"0 10px 6px",background:tab==="home"?"#0f1e30":"none",
            border:tab==="home"?"1px solid #1e3a5f":"1px solid transparent",borderRadius:8,
            color:tab==="home"?"#38bdf8":"#64748b",fontSize:13,fontWeight:700,padding:"8px 12px",
            cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:8}}
          onMouseEnter={e=>{if(tab!=="home"){e.currentTarget.style.background="#0a1120";e.currentTarget.style.color="#94a3b8";}}}
          onMouseLeave={e=>{if(tab!=="home"){e.currentTarget.style.background="none";e.currentTarget.style.color="#64748b";}}}>
          🏠 Home
        </button>
        {["Overview","Sales","Delivery","Hiring","Finance","Compliance"].map(group => {
          const items = nav.filter(n=>n.group===group);
          return (
            <div key={group}>
              <div style={{fontSize:9,color:"#1e3a5f",textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700,padding:"10px 14px 4px"}}>{group}</div>
              {items.map(n => (
                <button key={n.id} className={`navi${tab===n.id?" on":""}`} onClick={()=>setTab(n.id)}>
                  <I d={n.icon} s={14}/>{n.label}
                </button>
              ))}
            </div>
          );
        })}
        <div style={{marginTop:"auto",borderTop:"1px solid #0f1e30",paddingTop:14}}>
          {/* Auto-save status */}
          <div style={{padding:"0 14px 10px"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
              <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,background:saveStatus==="saving"?"#f59e0b":saveStatus==="saved"?"#34d399":saveStatus==="error"?"#f87171":"#1e3a5f",transition:"background 0.3s"}}/>
              <span style={{fontSize:11,color:saveStatus==="saving"?"#f59e0b":saveStatus==="saved"?"#34d399":saveStatus==="error"?"#f87171":"#3d5a7a",fontWeight:600}}>
                {saveStatus==="saving"?"Saving…":saveStatus==="saved"?"Saved":saveStatus==="error"?"Save error":"Auto-save on"}
              </span>
            </div>
            {lastSaved && (
              <div style={{fontSize:10,color:"#1e3a5f",paddingLeft:13}}>
                Last: {lastSaved.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}
              </div>
            )}
          </div>

          {/* Drive backup */}
          <div style={{padding:"10px 14px",borderTop:"1px solid #0f1e30"}}>
            <div style={{fontSize:10,color:"#1e3a5f",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.06em"}}>Google Drive Backup</div>
            <button
              onClick={()=>setBackupModal(true)}
              style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:"#050e1c",border:"1px solid #1a2d45",borderRadius:8,cursor:"pointer",color:"#7dd3fc",fontSize:12,fontWeight:600,transition:"background 0.15s"}}
              onMouseEnter={e=>e.currentTarget.style.background="#0a1829"}
              onMouseLeave={e=>e.currentTarget.style.background="#050e1c"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"/></svg>
              Backup / Restore
            </button>
          </div>

          {/* Integrations */}
          <div style={{padding:"10px 14px 0",borderTop:"1px solid #0f1e30"}}>
            <div style={{fontSize:10,color:"#1e3a5f",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.06em"}}>Integrations</div>
            <div style={{display:"flex",gap:6}}>
              <span className="adp-badge">ADP</span>
              <span className="fb-badge">FreshBooks</span>
            </div>
          </div>
        </div>

        {/* Backup / Restore Modal */}
        {backupModal && (
          <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setBackupModal(false)} style={{zIndex:200}}>
            <div className="modal" style={{maxWidth:520}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
                <div>
                  <h2 style={{fontSize:17,fontWeight:700,color:"#e2e8f0"}}>Backup & Restore</h2>
                  <p style={{fontSize:12,color:"#3d5a7a",marginTop:3}}>Export to Google Drive or restore from a backup</p>
                </div>
                <button className="btn bg" style={{padding:"5px 8px"}} onClick={()=>{setBackupModal(false);setRestoreError("");setRestoreSuccess("");}}>✕</button>
              </div>

              {/* Drive instructions */}
              <div style={{background:"#050e1c",border:"1px solid #1e3a5f",borderRadius:10,padding:"14px 16px",marginBottom:18}}>
                <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <svg width="18" height="18" viewBox="0 0 87.3 78" fill="none" style={{flexShrink:0,marginTop:1}}>
                    <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
                    <path d="M43.65 25L29.9 0c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
                    <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 10.6z" fill="#ea4335"/>
                    <path d="M43.65 25L57.4 0H29.9z" fill="#00832d"/>
                    <path d="M59.8 53H87.3L73.55 29.5H45.15z" fill="#2684fc"/>
                    <path d="M45.15 29.5L27.5 53l16.15 23.8L59.8 53z" fill="#ffba00"/>
                  </svg>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:"#7dd3fc",marginBottom:4}}>How to back up to Google Drive</div>
                    <div style={{fontSize:11,color:"#475569",lineHeight:1.8}}>
                      1. Click <b style={{color:"#94a3b8"}}>"Export Backup"</b> below — downloads a JSON file<br/>
                      2. Open <b style={{color:"#94a3b8"}}>drive.google.com</b> → New → File Upload<br/>
                      3. Upload the <code style={{color:"#38bdf8",fontSize:10}}>ziksatech_ops_backup_*.json</code> file<br/>
                      4. To restore: download from Drive → click "Restore from File" below
                    </div>
                    <div style={{fontSize:10,color:"#1e3a5f",marginTop:6}}>
                      💡 Live Drive sync coming soon — connect Google Drive in Claude settings to enable
                    </div>
                  </div>
                </div>
              </div>

              {/* Last auto-save info */}
              <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:8,padding:"10px 14px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:"#34d399"}}>● Auto-save active</div>
                  <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>
                    {lastSaved ? `Last saved: ${lastSaved.toLocaleString()}` : "Not yet saved this session"}
                  </div>
                </div>
                <div style={{fontSize:10,color:"#1e3a5f",textAlign:"right"}}>
                  Saves to<br/>browser storage
                </div>
              </div>

              {/* Export button */}
              <button className="btn bp" style={{width:"100%",justifyContent:"center",padding:"12px",marginBottom:12,fontSize:14}}
                onClick={()=>{ exportBackup(); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"/></svg>
                Export Backup — Download JSON
              </button>

              {/* Restore section */}
              <div style={{borderTop:"1px solid #1a2d45",paddingTop:16}}>
                <div style={{fontSize:12,fontWeight:700,color:"#94a3b8",marginBottom:10}}>Restore from Backup File</div>
                {restoreError && <div style={{background:"#1a0808",border:"1px solid #3d1010",borderRadius:8,padding:"9px 12px",marginBottom:10,color:"#f87171",fontSize:12}}>⚠ {restoreError}</div>}
                {restoreSuccess && <div style={{background:"#021f14",border:"1px solid #063d28",borderRadius:8,padding:"9px 12px",marginBottom:10,color:"#34d399",fontSize:12}}>{restoreSuccess}</div>}
                <button className="btn bg" style={{width:"100%",justifyContent:"center",padding:"10px"}}
                  onClick={()=>{
                    const inp = document.createElement("input");
                    inp.type="file"; inp.accept=".json";
                    inp.onchange = e => {
                      const f = e.target.files[0]; if(!f) return;
                      const r = new FileReader();
                      r.onload = ev => restoreBackup(ev.target.result);
                      r.readAsText(f);
                    };
                    inp.click();
                  }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 17 12 21 8 17"/><line x1="12" y1="12" x2="12" y2="3"/><path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"/></svg>
                  Restore from File…
                </button>
                <div style={{fontSize:10,color:"#1e3a5f",marginTop:8,textAlign:"center"}}>
                  ⚠ Restoring will overwrite all current data
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Dark / Light Mode Toggle ─── */}
        <div style={{padding:"10px 14px 14px"}}>
          <button onClick={()=>setColorMode(m=>m==="dark"?"light":"dark")}
            style={{width:"100%",padding:"8px 14px",borderRadius:8,
              border:"1px solid #1a2d45",background:"transparent",cursor:"pointer",
              display:"flex",alignItems:"center",gap:8,fontSize:11,fontWeight:600,
              color:colorMode==="light"?"#f59e0b":"#64748b",transition:"all 0.2s"}}>
            <span style={{fontSize:16}}>{colorMode==="light"?"☀️":"🌙"}</span>
            {colorMode==="light" ? "Light Mode" : "Dark Mode"}
            <span style={{marginLeft:"auto",fontSize:9,color:"#1e3a5f",padding:"2px 5px",
              background:"#060d1c",borderRadius:3,border:"1px solid #111d2d"}}>click to toggle</span>
          </button>
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <nav className="mobile-nav" style={{alignItems:"stretch"}}>
        {[
          { id:"dashboard",  icon:"🏠", label:"Home"    },
          { id:"crm",        icon:"🤝", label:"Sales"   },
          { id:"projects",   icon:"📊", label:"Projects"},
          { id:"finance",    icon:"💰", label:"Finance" },
          { id:"compliance", icon:"🛡", label:"Comply"  },
        ].map(item=>(
          <button key={item.id} onClick={()=>setTab(item.id)}
            style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,
              background:"none",border:"none",cursor:"pointer",padding:"6px 0",
              borderTop:tab===item.id?"2px solid #38bdf8":"2px solid transparent",
              color:tab===item.id?"#38bdf8":"#475569"}}>
            <span style={{fontSize:18}}>{item.icon}</span>
            <span style={{fontSize:9,fontWeight:600}}>{item.label}</span>
          </button>
        ))}
        <button onClick={()=>setSideOpen(s=>!s)}
          style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,
            background:"none",border:"none",cursor:"pointer",padding:"6px 0",
            borderTop:"2px solid transparent",color:"#475569"}}>
          <span style={{fontSize:18}}>☰</span>
          <span style={{fontSize:9,fontWeight:600}}>More</span>
        </button>
      </nav>

      <main className="main-content" style={{flex:1,overflowY:"auto",padding:isMobile?"68px 14px 72px":"28px 32px",minWidth:0}}>
        {tab==="home"       && <HomePage   {...shared} authProfile={authProfile} />}
        {tab==="dashboard"  && <Dashboard  {...shared}/>}
        {tab==="notifications" && <NotificationCenter {...shared}/>}
        {tab==="auditlog"      && <AuditLog {...shared}/>}
        {tab==="pdfexport"     && <PDFExport {...shared}/>}
        {tab==="settings"      && <SettingsPage {...shared}/>}
        {tab==="proposals"     && <ProposalBuilder {...shared}/>}
        {tab==="emailtpl"      && <EmailTemplates {...shared}/>}
        {tab==="taxcal"        && <TaxCalendar {...shared}/>}
        {tab==="benefits"      && <BenefitsTracker {...shared}/>}
        {tab==="reports"       && <ReportBuilder {...shared}/>}
        {tab==="portal"        && <ClientPortal {...shared}/>}
        {tab==="capacity"      && <CapacityPlanner {...shared}/>}
        {tab==="budget"        && <BudgetActual {...shared}/>}
        {tab==="onboarding"    && <OnboardingModule {...shared}/>}
        {tab==="glexport"      && <GLExport {...shared}/>}
        {tab==="esign"         && <ESignature {...shared}/>}
        {tab==="roster"     && <Roster     {...shared}/>}
        {tab==="timesheet"  && <TimesheetApproval {...shared}/>}
        {tab==="clients"    && <ClientPortfolio {...shared}/>}
        {tab==="pipeline"   && <Pipeline   {...shared}/>}
        {tab==="ebitda"     && <EbitdaOpt  {...shared}/>}
        {tab==="pl"         && <PandL      {...shared}/>}
        {tab==="finance"    && <FinanceModule {...shared}/> }
        {tab==="cashflow"   && <CashFlowModule {...shared}/>}
        {tab==="vendors"    && <VendorAPModule {...shared}/>}
        {tab==="adp"        && <ADPPayroll {...shared}/>}
        {tab==="org"          && <OrgAccessModule {...shared}/>}
        {tab==="myprofile"     && <MyProfilePage authProfile={authProfile} authSession={authSession} />}
        {tab==="contracts"   && <ContractsModule {...shared}/> }
        {tab==="projects"    && <ProjectTracker {...shared}/>}
        {tab==="profitability"&& <ProjectProfitability {...shared}/>}
        {tab==="changeorders" && <ChangeOrderModule {...shared}/>}
        {tab==="crm"         && <SalesCRM {...shared}/> }
        {tab==="recruiting"  && <RecruitingModule {...shared}/>}
        {tab==="pto"        && <PTOModule {...shared}/>}
        {tab==="compliance"  && <ComplianceModule {...shared}/>}
        {tab==="freshbooks" && <FreshBooks {...shared}/>}
      </main>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function Dashboard({ roster, clients, tsHours, plIncome, plExpense, fbInvoices, finInvoices, finPayments, workAuth, compDocs, candidates, offers, crmDeals, crmAccounts, auditLog, addAudit, setTab }) {
  // ── Period picker ────────────────────────────────────────────────────────
  const PERIODS = [
    { id:"ytd2026",   label:"YTD 2026",    monthKeys:["2026-01","2026-02","2026-03"],          startIdx:9 },
    { id:"q12026",    label:"Q1 2026",     monthKeys:["2026-01","2026-02","2026-03"],          startIdx:9 },
    { id:"q42025",    label:"Q4 2025",     monthKeys:["2025-10","2025-11","2025-12"],          startIdx:6 },
    { id:"q32025",    label:"Q3 2025",     monthKeys:["2025-07","2025-08","2025-09"],          startIdx:3 },
    { id:"fy2025",    label:"Full 2025",   monthKeys:["2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12"], startIdx:0 },
    { id:"rolling12", label:"Rolling 12m", monthKeys:["2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03"], startIdx:0 },
  ];
  const [dashPeriod, setDashPeriod] = useState("ytd2026");
  const activePeriod = PERIODS.find(p=>p.id===dashPeriod)||PERIODS[0];

  const rData = roster.map(r => ({ ...r, ...calcRoster(r) }));
  const totalRev = rData.reduce((s,r) => s+r.rev, 0);
  const totalCost = rData.reduce((s,r) => s+r.totalCost, 0);
  const coKeeps = rData.reduce((s,r) => s+r.coKeeps, 0);
  const thirdParty = rData.reduce((s,r) => s+r.thirdParty, 0);
  const netMargin = totalRev > 0 ? (totalRev - totalCost) / totalRev : 0;
  const clientRevTotal = clients.reduce((s,c)=>s+c.annualRev,0);
  const exitVal7x = Math.round(clientRevTotal * 0.08 * 7);

  const activeLevers = 0;
  const outstanding = fbInvoices.filter(i=>i.status==="sent").reduce((s,i)=>s+i.amount,0);
  const collected = fbInvoices.filter(i=>i.status==="paid").reduce((s,i)=>s+i.amount,0);

  // ── Rolling 12-month revenue (simulated from finInvoices + seed) ─────────────
  const MONTHS_12 = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  const MONTH_KEYS = ["2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03"];
  // Base revenue from clientRevTotal distributed with slight variation
  const baseMonthly = clientRevTotal / 12;
  const MONTHLY_REV = MONTH_KEYS.map((mk, i) => {
    const inv = (finInvoices||[]).filter(inv => inv.issueDate && inv.issueDate.startsWith(mk));
    const invTotal = inv.reduce((s,inv)=>s+inv.lines.reduce((x,l)=>x+l.amount,0), 0);
    const seed = [0.82,0.88,0.91,0.94,0.97,1.01,1.05,0.98,1.02,1.08,1.04,1.10][i];
    return { month: MONTHS_12[i], key: mk, rev: invTotal > 0 ? invTotal : Math.round(baseMonthly * seed) };
  });
  const maxRev = Math.max(...MONTHLY_REV.map(m=>m.rev));
  const periodRevData = MONTHLY_REV.filter(m=>activePeriod.monthKeys.includes(m.key));
  const totalYTD = periodRevData.reduce((s,m)=>s+m.rev,0);

  // Sparkline SVG helper
  const Spark = ({ data, color="#38bdf8", w=80, h=24 }) => {
    if (!data||data.length<2) return null;
    const mn = Math.min(...data), mx = Math.max(...data);
    const range = mx-mn||1;
    const pts = data.map((v,i)=>{
      const x = (i/(data.length-1))*(w-4)+2;
      const y = h-2-((v-mn)/range)*(h-4);
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg width={w} height={h} style={{display:"block"}}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
        <circle cx={pts.split(" ").pop().split(",")[0]} cy={pts.split(" ").pop().split(",")[1]} r="2.5" fill={color}/>
      </svg>
    );
  };

  // Utilization trend (last 6 months simulated)
  const utilTrend = [72,68,75,80,78,82];
  // AR trend
  const arTrend = MONTHLY_REV.slice(6).map(m=>Math.round(m.rev*0.15));
  // Pipeline trend
  const pipeTrend = [180000,195000,210000,240000,228000,(crmDeals||[]).filter(d=>!["closed-won","closed-lost"].includes(d.stage)).reduce((s,d)=>s+d.value*(d.prob||d.probability||50)/100,0)];

  const kpis = [
    { label:"Team Revenue/yr",  value:fmt(totalRev),    sub:"billed to clients",    color:"#38bdf8" },
    { label:"Total Cost to Co.",value:fmt(totalCost),   sub:"salaries + burden",    color:"#f87171" },
    { label:"Company Keeps",    value:fmt(coKeeps),     sub:`3rd Party out: ${fmt(thirdParty)}`, color:"#34d399" },
    { label:"Client Revenue",   value:fmt(clientRevTotal), sub:"portfolio total",   color:"#a78bfa" },
    { label:"FreshBooks Outstanding", value:fmt(outstanding), sub:`${fmt(collected)} collected`, color:"#f59e0b" },
    { label:"Exit Value (7×)",  value:fmt(exitVal7x),   sub:"based on EBITDA",      color:"#818cf8" },
  ];

  // Finance metrics
  const finBilled    = (finInvoices||[]).reduce((s,i)=>s+i.lines.reduce((x,l)=>x+l.amount,0),0);
  const finCollected = (finPayments||[]).reduce((s,p)=>s+p.amount,0);
  const finAR        = (finInvoices||[]).filter(i=>["sent","overdue"].includes(i.status)).reduce((s,i)=>s+i.lines.reduce((x,l)=>x+l.amount,0)-((finPayments||[]).filter(p=>p.invoiceId===i.id).reduce((x,p)=>x+p.amount,0)),0);
  const finOverdue   = (finInvoices||[]).filter(i=>i.status==="overdue").reduce((s,i)=>s+i.lines.reduce((x,l)=>x+l.amount,0),0);

  // Compliance alerts
  const compAlerts = [...(workAuth||[]),...(compDocs||[])].filter(w=>{
    const d = new Date((w.expiryDate)+"T00:00:00"); const t = new Date("2026-03-11T00:00:00");
    return Math.floor((d-t)/86400000) <= 60;
  }).length;

  // Recruiting
  const openOffers   = (offers||[]).filter(o=>o.status==="pending").length;
  const activeCands  = (candidates||[]).filter(c=>c.status==="active").length;

  // Utilization
  const billable = rData.filter(r=>r.util>0).length;
  const bench    = rData.filter(r=>r.util===0).length;

  return (
    <div>
      <PH title="Executive Dashboard" sub="Ziksatech Ops Center · CEO/COO view · All figures live">
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <span className="adp-badge" style={{padding:"4px 10px",fontSize:11}}>ADP ●</span>
          <span className="fb-badge" style={{padding:"4px 10px",fontSize:11}}>FreshBooks ●</span>
          {/* Period picker */}
          <div style={{display:"flex",gap:3,background:"#060d1c",borderRadius:8,padding:3,border:"1px solid #1a2d45"}}>
            {PERIODS.map(p=>(
              <button key={p.id} onClick={()=>setDashPeriod(p.id)}
                style={{padding:"3px 10px",borderRadius:5,border:"none",cursor:"pointer",fontSize:10,fontWeight:600,
                  background:dashPeriod===p.id?"#0369a1":"transparent",
                  color:dashPeriod===p.id?"#fff":"#475569",transition:"all 0.15s"}}>
                {p.label}
              </button>
            ))}
          </div>
          <span style={{fontSize:11,color:"#38bdf8",fontWeight:600}}>{fmt(totalYTD)}</span>
        </div>
      </PH>

      {/* Row 1 — Revenue KPIs with sparklines */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:12}}>
        {[
          { label:"Annual Revenue",   value:fmt(clientRevTotal), sub:"portfolio total",              color:"#38bdf8", spark:MONTHLY_REV.map(m=>m.rev), tab:"clients" },
          { label:"Billed (Finance)", value:fmt(finBilled),      sub:"from Finance module",          color:"#7dd3fc", spark:MONTHLY_REV.slice(6).map(m=>Math.round(m.rev*0.9)), tab:"finance" },
          { label:"Collected",        value:fmt(finCollected),   sub:`A/R: ${fmt(finAR)} open`,     color:"#34d399", spark:MONTHLY_REV.slice(6).map(m=>Math.round(m.rev*0.78)), tab:"finance" },
          { label:"Overdue A/R",      value:fmt(finOverdue),     sub:"requires follow-up",           color:"#f87171", spark:arTrend, tab:"finance" },
        ].map(k=>(
          <div key={k.label} className="card" style={{padding:"14px 18px",cursor:k.tab?"pointer":"default",transition:"border 0.15s",border:`1px solid ${k.tab?"#1a3a5c":"#1a2d45"}`}}
            onClick={()=>k.tab&&setTab(k.tab)}
            onMouseEnter={e=>{ if(k.tab) e.currentTarget.style.borderColor="#0284c7"; }}
            onMouseLeave={e=>{ if(k.tab) e.currentTarget.style.borderColor="#1a3a5c"; }}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div className="th" style={{marginBottom:4}}>{k.label}{k.tab&&<span style={{fontSize:8,color:"#1e3a5f",marginLeft:4}}>↗</span>}</div>
                <div className="mono" style={{fontSize:20,fontWeight:700,color:k.color}}>{k.value}</div>
                <div style={{fontSize:10,color:"#2d4a63",marginTop:3}}>{k.sub}</div>
              </div>
              <Spark data={k.spark} color={k.color} w={72} h={28}/>
            </div>
          </div>
        ))}
      </div>

      {/* Row 2 — Operations KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
        {[
          { label:"Gross Margin",       value:pct(totalRev>0?(totalRev-totalCost)/totalRev:0), sub:"bill − cost / bill", color:"#a78bfa", spark:[38,40,41,43,42,44], tab:"ebitda" },
          { label:"Utilization",        value:`${billable}/${rData.length}`, sub:`${bench} on bench`, color:bench>1?"#f59e0b":"#34d399", spark:utilTrend, tab:"roster" },
          { label:"Compliance Alerts",  value:compAlerts, sub:"expiring ≤60d", color:compAlerts>0?"#f87171":"#34d399", spark:null, tab:"compliance" },
          { label:"Pipeline (weighted)",value:fmt((crmDeals||[]).filter(d=>!["closed-won","closed-lost"].includes(d.stage)).reduce((s,d)=>s+d.value*(d.prob||d.probability||50)/100,0)), sub:"open deals", color:"#f59e0b", spark:pipeTrend, tab:"crm" },
        ].map(k=>(
          <div key={k.label} className="card" style={{padding:"14px 18px",cursor:k.tab?"pointer":"default",transition:"border 0.15s",border:`1px solid ${k.tab?"#1a3a5c":"#1a2d45"}`}}
            onClick={()=>k.tab&&setTab(k.tab)}
            onMouseEnter={e=>{ if(k.tab) e.currentTarget.style.borderColor="#0284c7"; }}
            onMouseLeave={e=>{ if(k.tab) e.currentTarget.style.borderColor="#1a3a5c"; }}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div className="th" style={{marginBottom:4}}>{k.label}{k.tab&&<span style={{fontSize:8,color:"#1e3a5f",marginLeft:4}}>↗</span>}</div>
                <div className="mono" style={{fontSize:20,fontWeight:700,color:k.color}}>{k.value}</div>
                <div style={{fontSize:10,color:"#2d4a63",marginTop:3}}>{k.sub}</div>
              </div>
              {k.spark&&<Spark data={k.spark} color={k.color} w={72} h={28}/>}
            </div>
          </div>
        ))}
      </div>

      {/* Rolling 12-Month Revenue Bar Chart */}
      <div className="card" style={{padding:"18px 20px",marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div>
            <div className="section-hdr" style={{margin:0}}>Rolling 12-Month Revenue</div>
            <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>{activePeriod.label}: <span style={{color:"#38bdf8",fontFamily:"monospace"}}>{fmt(totalYTD)}</span></div>
          </div>
          <div style={{fontSize:12,color:"#475569"}}>Peak: <span style={{color:"#38bdf8",fontFamily:"monospace"}}>{fmt(maxRev)}</span></div>
        </div>
        <div style={{display:"flex",alignItems:"flex-end",gap:6,height:100}}>
          {MONTHLY_REV.map((m,i)=>{
            const pctH = maxRev>0?(m.rev/maxRev)*88:0;
            const isCur = i===11;
            const isYTD = i>=9;
            return (
              <div key={m.key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                <div style={{fontSize:9,color:"#1e3a5f",fontFamily:"monospace",whiteSpace:"nowrap"}}>{m.rev>=1000?Math.round(m.rev/1000)+"k":m.rev}</div>
                <div style={{width:"100%",height:pctH,borderRadius:"3px 3px 0 0",
                  background:isCur?"linear-gradient(180deg,#38bdf8,#0369a1)":isYTD?"#0c2a44":"#1a2d45",
                  border:isCur?"1px solid #38bdf8":isYTD?"1px solid #1a3a5c":"none",
                  transition:"height 0.3s",minHeight:2}}/>
                <div style={{fontSize:9,color:isCur?"#38bdf8":isYTD?"#1e3a5f":"#1a2d45",fontWeight:isCur?700:400}}>{m.month}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:16,marginBottom:16}}>
        {/* Consultant snapshot */}
        <div className="card">
          <div className="section-hdr" style={{cursor:"pointer"}} onClick={()=>setTab("roster")}>Consultant Snapshot — Utilization & Margin <span style={{fontSize:9,color:"#1e3a5f"}}>↗</span></div>
          <div className="tr" style={{gridTemplateColumns:"1fr 70px 60px 90px 80px 90px",padding:"8px 18px"}}>
            {["Name","Type","Util %","Bill Rev","Margin","Bar"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {rData.map(r=>(
            <div key={r.id} className="tr" style={{gridTemplateColumns:"1fr 70px 60px 90px 80px 90px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{r.client}</div>
              </div>
              <span className="bdg" style={{background:r.type==="FTE"?"#0c2340":"#1a1a2e",color:r.type==="FTE"?"#38bdf8":"#a78bfa",fontSize:9}}>{r.type}</span>
              <span className="mono" style={{fontSize:12,color:r.util>=0.8?"#34d399":r.util>=0.4?"#f59e0b":"#f87171"}}>{pct(r.util)}</span>
              <span className="mono" style={{fontSize:12,color:"#7dd3fc"}}>{fmt(r.rev)}</span>
              <span className="mono" style={{fontSize:12,color:r.netMargin>0.2?"#34d399":r.netMargin>0?"#f59e0b":"#f87171"}}>{pct(r.netMargin)}</span>
              <div style={{height:7,background:"#0a1626",borderRadius:4,width:70}}>
                <div style={{height:7,borderRadius:4,background:r.util>=0.8?"#34d399":r.util>=0.4?"#f59e0b":"#f87171",width:`${r.util*100}%`}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Right column */}
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {/* Client portfolio */}
          <div className="card">
            <div className="section-hdr">Client Portfolio</div>
            {clients.map(c=>(
              <div key={c.id} className="tr" style={{gridTemplateColumns:"1fr 80px auto"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
                  <div style={{fontSize:9,color:"#3d5a7a"}}>{fmtDate(c.renewal)} renewal</div>
                </div>
                <span className="mono" style={{fontSize:12,color:"#7dd3fc"}}>{fmt(c.annualRev)}</span>
                <span className="bdg" style={{background:c.health==="Green"?"#022c22":c.health==="Amber"?"#451a03":"#2d0a0a",color:healthColor[c.health],fontSize:9}}>{c.health}</span>
              </div>
            ))}
          </div>

          {/* Exit value */}
          <div className="card" style={{padding:"14px 18px"}}>
            <div className="th" style={{marginBottom:8}}>Exit Value Scenarios</div>
            {[[5, "#f59e0b"],[7, "#a78bfa"],[10,"#38bdf8"]].map(([mult,c])=>(
              <div key={mult} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #0a1626"}}>
                <span style={{fontSize:12,color:"#475569"}}>{mult}× EBITDA multiple</span>
                <span className="mono" style={{fontSize:13,fontWeight:700,color:c}}>{fmt(Math.round(clientRevTotal*0.08*mult))}</span>
              </div>
            ))}
            <div style={{fontSize:10,color:"#1e3a5f",marginTop:8}}>Based on 8% EBITDA margin</div>
          </div>
        </div>
      </div>

      {/* Compliance & Recruiting alerts row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        <div className="card">
          <div className="section-hdr" style={{color:compAlerts>0?"#f87171":"#7dd3fc",cursor:"pointer"}} onClick={()=>setTab("compliance")}>
            {compAlerts>0?"⚠ Compliance Alerts":"✓ Compliance"} — {compAlerts} item{compAlerts!==1?"s":""} expiring ≤60d <span style={{fontSize:9,color:"#1e3a5f"}}>↗</span>
          </div>
          {[...(workAuth||[]),...(compDocs||[])].filter(w=>{
            const d=new Date((w.expiryDate)+"T00:00:00"); const t=new Date("2026-03-11T00:00:00");
            return Math.floor((d-t)/86400000)<=60;
          }).sort((a,b)=>a.expiryDate.localeCompare(b.expiryDate)).slice(0,5).map((w,i)=>{
            const d=new Date((w.expiryDate)+"T00:00:00"); const t=new Date("2026-03-11T00:00:00");
            const days=Math.floor((d-t)/86400000);
            const color=days<=30?"#f87171":"#f59e0b";
            return (
              <div key={i} className="tr" style={{gridTemplateColumns:"1fr 1fr 70px"}}>
                <span style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{w.name}</span>
                <span style={{fontSize:11,color:"#475569"}}>{w.type||w.docType}</span>
                <span className="bdg" style={{background:"#1a0808",color:color}}>{days}d</span>
              </div>
            );
          })}
          {compAlerts===0&&<div style={{padding:"20px",textAlign:"center",color:"#34d399",fontSize:13}}>✓ All clear</div>}
        </div>

        <div className="card">
          <div className="section-hdr" style={{cursor:"pointer"}} onClick={()=>setTab("crm")}>Sales Pipeline <span style={{fontSize:9,color:"#1e3a5f"}}>↗</span></div>
          {[
            {label:"Pipeline (weighted)", value:fmt((crmDeals||[]).filter(d=>!["closed-won","closed-lost"].includes(d.stage)).reduce((s,d)=>s+d.value*(d.probability/100),0)), color:"#38bdf8"},
            {label:"Open Deals",         value:(crmDeals||[]).filter(d=>!["closed-won","closed-lost"].includes(d.stage)).length, color:"#7dd3fc"},
            {label:"Closed Won (YTD)",   value:fmt((crmDeals||[]).filter(d=>d.stage==="closed-won").reduce((s,d)=>s+d.value,0)), color:"#34d399"},
            {label:"Active Candidates",  value:activeCands, color:"#a78bfa"},
            {label:"Open Offers",        value:openOffers,  color:"#f59e0b"},
          ].map(r=>(
            <div key={r.label} className="tr" style={{gridTemplateColumns:"1fr auto"}}>
              <span style={{fontSize:12,color:"#94a3b8"}}>{r.label}</span>
              <span style={{fontSize:16,fontWeight:800,color:r.color,textAlign:"right",fontFamily:"'DM Mono',monospace"}}>{r.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Activity Feed */}
      <div className="card" style={{padding:"18px 20px",marginTop:16,overflowX:"auto"}}>
        <div className="section-hdr">Recent Activity</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {(auditLog||[]).slice(0,8).map((entry,i)=>(
            <div key={i} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:"1px solid #070b14",alignItems:"flex-start"}}>
              <div style={{width:28,height:28,borderRadius:8,background:"#0c2340",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:13}}>
                {entry.module==="Roster"?"👥":entry.module==="Finance"?"💰":entry.module==="Projects"?"📊":entry.module==="CRM"?"🤝":entry.module==="Compliance"?"🛡":entry.module==="Recruiting"?"👤":"📋"}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,color:"#94a3b8",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.action}</div>
                <div style={{fontSize:10,color:"#3d5a7a",marginTop:1}}>{entry.user} · {entry.timestamp?.slice(5,16)||""}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── ROSTER ───────────────────────────────────────────────────────────────────
function Roster({ roster, setRoster, addAudit }) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const [inlineEdit, setInlineEdit] = useState(null);
  const [inlineVal, setInlineVal] = useState("");
  const [selRows, setSelRows] = useState(new Set());

  const toggleRow = (id) => setSelRows(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const toggleAllRows = () => setSelRows(s => s.size===roster.length ? new Set() : new Set(roster.map(r=>r.id)));
  const bulkDeleteRoster = () => {
    if (!selRows.size) return;
    const names = roster.filter(r=>selRows.has(r.id)).map(r=>r.name).join(", ");
    if (!window.confirm(`Permanently delete ${selRows.size} consultant(s)?\n\n${names}`)) return;
    setRoster(rs => rs.filter(r => !selRows.has(r.id)));
    addAudit && addAudit("Roster","Bulk Delete","Roster",`Deleted ${selRows.size} consultants: ${names}`);
    setSelRows(new Set());
  };

  const emptyForm = { name:"", role:"", type:"FTE", client:"", projects:"", billRate:"", util:"", baseSalary:"", revShare:"", fixedRate:"", thirdPartySplit:"", insurance:"7200" };

  const open = (r=null) => { setEditing(r?.id||null); setForm(r ? {...r, projects: r.projects||""} : {...emptyForm}); setModal(true); };
  const save = () => {
    const f = { ...form, billRate:+form.billRate, util:+form.util, baseSalary:+form.baseSalary, revShare:+form.revShare, fixedRate:+form.fixedRate, thirdPartySplit:+form.thirdPartySplit, insurance:+form.insurance };
    if (editing) { setRoster(rs => rs.map(r => r.id===editing ? f : r)); addAudit&&addAudit("Roster","Update Consultant","Roster",`Updated ${f.name}`,{before:f.name,after:f.name}); }
    else { setRoster(rs => [...rs, { ...f, id:"r"+uid() }]); addAudit&&addAudit("Roster","Add Consultant","Roster",`Added ${f.name}`); }
    setModal(false);
  };
  const del = (id) => setRoster(rs => rs.filter(r => r.id !== id));

  // Start inline edit
  const startInline = (r, field, val) => { setInlineEdit({id:r.id, field}); setInlineVal(String(val)); };
  // Commit inline edit on blur or Enter
  const commitInline = () => {
    if (!inlineEdit) return;
    setRoster(rs => rs.map(r => r.id===inlineEdit.id ? {...r, [inlineEdit.field]: inlineEdit.field==="name"||inlineEdit.field==="projects" ? inlineVal : +inlineVal} : r));
    addAudit&&addAudit("Roster","Edit Field","Roster",`Updated ${inlineEdit.field} for ${inlineEdit.id}`);
    setInlineEdit(null);
  };
  const onInlineKey = e => { if(e.key==="Enter") commitInline(); if(e.key==="Escape") setInlineEdit(null); };

  const totals = roster.reduce((acc, r) => { const d = calcRoster(r); acc.rev+=d.rev; acc.cost+=d.totalCost; acc.keeps+=d.coKeeps; acc.tp+=d.thirdParty; return acc; },{rev:0,cost:0,keeps:0,tp:0});

  const InlineCell = ({r, field, value, color, mono, style={}}) => {
    const isEditing = inlineEdit?.id===r.id && inlineEdit?.field===field;
    if (isEditing) return (
      <input
        autoFocus
        value={inlineVal}
        onChange={e=>setInlineVal(e.target.value)}
        onBlur={commitInline}
        onKeyDown={onInlineKey}
        style={{background:"#0a1829",border:"1px solid #0284c7",borderRadius:6,padding:"3px 8px",color:"#e2e8f0",fontSize:12,fontFamily:mono?"'DM Mono',monospace":"inherit",width:"100%",outline:"none",...style}}
      />
    );
    return (
      <span
        title="Click to edit"
        onClick={()=>startInline(r, field, value)}
        style={{cursor:"text",borderRadius:5,padding:"2px 5px",transition:"background 0.15s",display:"block",color:color||"#94a3b8",fontSize:12,fontFamily:mono?"'DM Mono',monospace":"inherit",...style}}
        onMouseEnter={e=>e.currentTarget.style.background="#0a1829"}
        onMouseLeave={e=>e.currentTarget.style.background="transparent"}
      >{value}</span>
    );
  };

  return (
    <div>
      <PH title="Team Roster & Compensation" sub="Click any name, project or rate cell to edit inline · FICA 7.65% · TX SUTA 2.7% · 401(k) 3%">
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {selRows.size>0&&<button className="btn br" style={{fontSize:11}} onClick={bulkDeleteRoster}>🗑 Delete {selRows.size} selected</button>}
          <button className="btn bp" onClick={()=>open()}><I d={ICONS.plus} s={14}/>Add Consultant</button>
        </div>
      </PH>

      <div className="card" style={{marginBottom:16,overflowX:"auto"}}>
        <div className="tr" style={{gridTemplateColumns:"28px 200px 1fr 90px 80px 70px 80px 90px 90px 90px 80px 80px",padding:"8px 18px",minWidth:960}}>
          <input type="checkbox" checked={selRows.size===roster.length&&roster.length>0} onChange={toggleAllRows} style={{accentColor:"#0369a1",cursor:"pointer"}}/>
          {["Name","Projects / Role","Type","Client","Rate","Util","Revenue","Total Cost","Co. Keeps","Margin",""].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {roster.map(r => {
          const d = calcRoster(r);
          const projects = (r.projects||"").split(",").map(p=>p.trim()).filter(Boolean);
          return (
            <div key={r.id} className="tr" style={{gridTemplateColumns:"28px 200px 1fr 90px 80px 70px 80px 90px 90px 90px 80px 80px",minWidth:960,alignItems:"start",paddingTop:10,paddingBottom:10,background:selRows.has(r.id)?"#0a1a2e":undefined}}>
              <input type="checkbox" checked={selRows.has(r.id)} onChange={()=>toggleRow(r.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"#0369a1",cursor:"pointer",marginTop:4}}/>
              {/* Inline-editable Name */}
              <div>
                <InlineCell r={r} field="name" value={r.name} color="#cbd5e1" style={{fontWeight:600,fontSize:13}}/>
                <div style={{fontSize:10,color:"#3d5a7a",paddingLeft:5,marginTop:2}}>{r.role}</div>
              </div>

              {/* Projects — inline editable, shown as tags */}
              <div style={{paddingRight:8}}>
                {inlineEdit?.id===r.id && inlineEdit?.field==="projects" ? (
                  <input
                    autoFocus
                    value={inlineVal}
                    onChange={e=>setInlineVal(e.target.value)}
                    onBlur={commitInline}
                    onKeyDown={onInlineKey}
                    placeholder="BRIM Phase 3, AT&T Portal, ..."
                    style={{background:"#0a1829",border:"1px solid #0284c7",borderRadius:6,padding:"4px 8px",color:"#e2e8f0",fontSize:11,width:"100%",outline:"none"}}
                  />
                ) : (
                  <div
                    onClick={()=>startInline(r,"projects",r.projects||"")}
                    title="Click to edit projects"
                    style={{cursor:"text",minHeight:22,borderRadius:5,padding:"2px 4px",transition:"background 0.15s"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#0a1829"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                  >
                    {projects.length > 0
                      ? <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                          {projects.map((p,i)=>(
                            <span key={i} style={{background:"#0c2340",color:"#7dd3fc",fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:12,border:"1px solid #1a3a5c",whiteSpace:"nowrap"}}>{p}</span>
                          ))}
                        </div>
                      : <span style={{fontSize:11,color:"#2d4a63",fontStyle:"italic"}}>+ add projects</span>
                    }
                  </div>
                )}
              </div>

              <span className="bdg" style={{background:r.type==="FTE"?"#0c2340":"#1a1a2e",color:r.type==="FTE"?"#38bdf8":"#a78bfa"}}>{r.type}</span>
              <span style={{fontSize:11,color:"#64748b",paddingLeft:4}}>{r.client}</span>

              {/* Inline-editable Bill Rate */}
              <InlineCell r={r} field="billRate" value={"$"+r.billRate} color="#7dd3fc" mono/>

              {/* Inline-editable Util */}
              <InlineCell r={r} field="util" value={pct(r.util)} color={r.util>=0.8?"#34d399":r.util>=0.4?"#f59e0b":"#f87171"} mono/>

              <span className="mono" style={{fontSize:12,color:"#e2e8f0",paddingLeft:4}}>{fmt(d.rev)}</span>
              <span className="mono" style={{fontSize:12,color:"#f87171",paddingLeft:4}}>{fmt(d.totalCost)}</span>
              <span className="mono" style={{fontSize:12,color:d.coKeeps>0?"#34d399":"#f87171",paddingLeft:4}}>{fmt(d.coKeeps)}</span>
              <span className="mono" style={{fontSize:12,color:d.netMargin>0?"#34d399":"#f87171",paddingLeft:4}}>{pct(d.netMargin)}</span>
              <div style={{display:"flex",gap:5}}>
                <button className="btn bg" style={{padding:"4px 7px"}} onClick={()=>open(r)}><I d={ICONS.edit} s={12}/></button>
                <button className="btn br" style={{padding:"4px 7px"}} onClick={()=>del(r.id)}><I d={ICONS.trash} s={12}/></button>
              </div>
            </div>
          );
        })}
        <div className="tr" style={{gridTemplateColumns:"200px 1fr 90px 80px 70px 80px 90px 90px 90px 80px 80px",background:"#0a1626",minWidth:900}}>
          <span style={{fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}}>TOTALS</span>
          <span/><span/><span/><span/><span/>
          <span className="mono" style={{fontSize:13,fontWeight:700,color:"#38bdf8"}}>{fmt(totals.rev)}</span>
          <span className="mono" style={{fontSize:13,fontWeight:700,color:"#f87171"}}>{fmt(totals.cost)}</span>
          <span className="mono" style={{fontSize:13,fontWeight:700,color:"#34d399"}}>{fmt(totals.keeps)}</span>
          <span className="mono" style={{fontSize:12,color:(totals.rev-totals.cost)>=0?"#34d399":"#f87171"}}>{pct(totals.rev>0?(totals.rev-totals.cost)/totals.rev:0)}</span>
          <span/>
        </div>
      </div>

      {/* Edit / Add Modal */}
      {modal && form && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:620}}>
            <MH title={editing?"Edit Consultant":"Add Consultant"} onClose={()=>setModal(false)}/>

            {/* Identity section */}
            <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:12}}>Identity & Assignment</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <FF label="Full Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Suresh Menon"/></FF>
                <FF label="Role / Title"><input className="inp" value={form.role} onChange={e=>setForm({...form,role:e.target.value})} placeholder="BRIM Sr Consultant"/></FF>
                <FF label="Employment Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}><option>FTE</option><option>Contractor</option></select></FF>
                <FF label="Primary Client"><input className="inp" value={form.client} onChange={e=>setForm({...form,client:e.target.value})} placeholder="AT&T"/></FF>
              </div>
              <FF label="Projects (comma-separated)">
                <input className="inp" value={form.projects||""} onChange={e=>setForm({...form,projects:e.target.value})} placeholder="BRIM Phase 3, AT&T Portal Revamp, IS-U Migration"/>
              </FF>
              {(form.projects||"").split(",").map(p=>p.trim()).filter(Boolean).length > 0 && (
                <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>
                  {(form.projects||"").split(",").map(p=>p.trim()).filter(Boolean).map((p,i)=>(
                    <span key={i} style={{background:"#0c2340",color:"#7dd3fc",fontSize:11,padding:"3px 10px",borderRadius:12,border:"1px solid #1a3a5c"}}>{p}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Compensation section */}
            <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:12}}>Compensation & Billing</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <FF label="Bill Rate/hr ($)"><input className="inp" type="number" value={form.billRate} onChange={e=>setForm({...form,billRate:e.target.value})} placeholder="155"/></FF>
                <FF label="Utilization (0–1)"><input className="inp" type="number" step="0.1" min="0" max="1" value={form.util} onChange={e=>setForm({...form,util:e.target.value})} placeholder="0.8"/></FF>
                {form.type==="FTE" && <FF label="Base Salary ($)"><input className="inp" type="number" value={form.baseSalary} onChange={e=>setForm({...form,baseSalary:e.target.value})} placeholder="100000"/></FF>}
                <FF label="Rev Share % (0–1)"><input className="inp" type="number" step="0.05" min="0" max="1" value={form.revShare} onChange={e=>setForm({...form,revShare:e.target.value})} placeholder="0"/></FF>
                {form.type==="Contractor" && <>
                  <FF label="Fixed Rate/hr — your cost ($)"><input className="inp" type="number" value={form.fixedRate} onChange={e=>setForm({...form,fixedRate:e.target.value})} placeholder="140"/></FF>
                  <FF label="3rd Party Split (0–1)"><input className="inp" type="number" step="0.1" min="0" max="1" value={form.thirdPartySplit} onChange={e=>setForm({...form,thirdPartySplit:e.target.value})} placeholder="0.5"/></FF>
                </>}
                <FF label="Insurance/yr ($)"><input className="inp" type="number" value={form.insurance} onChange={e=>setForm({...form,insurance:e.target.value})} placeholder="7200"/></FF>
              </div>
            </div>

            <div style={{display:"flex",gap:10,justifyContent:"space-between",marginTop:4}}>
              {editing && <button className="btn br" onClick={()=>{del(editing);setModal(false);}}>Delete Consultant</button>}
              <div style={{display:"flex",gap:10,marginLeft:"auto"}}>
                <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
                <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save Changes</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TIMESHEET ────────────────────────────────────────────────────────────────
function Timesheet({ roster, setRoster, tsHours, setTsHours }) {
  const [editCell, setEditCell] = useState(null);
  const [editVal, setEditVal]   = useState("");

  const updateHrs = (rid, mi, val) => setTsHours(h => ({ ...h, [rid]: h[rid].map((v,i) => i===mi ? +val : v) }));
  const totalsByMonth = MONTHS.map((_,mi) => roster.reduce((s,r) => s + (tsHours[r.id]?.[mi]||0), 0));
  const totalRevByMonth = MONTHS.map((_,mi) => roster.reduce((s,r) => s + (tsHours[r.id]?.[mi]||0) * r.billRate, 0));

  const startEdit = (rid, field, val) => { setEditCell({rid,field}); setEditVal(val); };
  const commitEdit = () => {
    if (!editCell) return;
    setRoster(rs => rs.map(r => r.id===editCell.rid ? {...r, [editCell.field]: editCell.field==="billRate"?+editVal:editVal} : r));
    setEditCell(null);
  };
  const isEditing = (rid, field) => editCell?.rid===rid && editCell?.field===field;

  const EditCell = ({rid, field, value, style={}}) => isEditing(rid, field)
    ? <input autoFocus className="inp" value={editVal}
        onChange={e=>setEditVal(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={e=>{ if(e.key==="Enter") commitEdit(); if(e.key==="Escape") setEditCell(null); }}
        style={{width:"100%",padding:"3px 6px",fontSize:12,...style}}/>
    : <div onClick={()=>startEdit(rid,field,value)}
        title="Click to edit"
        style={{cursor:"text",padding:"2px 4px",borderRadius:4,transition:"background 0.15s",...style}}
        onMouseEnter={e=>e.currentTarget.style.background="#0f1e30"}
        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        {value}
      </div>;

  return (
    <div>
      <PH title="Monthly Timesheet 2026" sub="Click name, role or rate to edit inline · Hours and revenue auto-calculate"/>
      <div className="card" style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{borderBottom:"1px solid #111d2d"}}>
              <th style={{padding:"10px 14px",textAlign:"left"}} className="th">Consultant</th>
              <th className="th" style={{padding:"8px 6px",textAlign:"left"}}>Rate</th>
              {MONTHS.map(m=><th key={m} className="th" style={{padding:"8px 10px",textAlign:"center",minWidth:58}}>{m}</th>)}
              <th className="th" style={{padding:"8px 12px",textAlign:"right"}}>Total Hrs</th>
              <th className="th" style={{padding:"8px 12px",textAlign:"right"}}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {roster.map(r => {
              const hrs = tsHours[r.id] || Array(12).fill(0);
              const totalH = hrs.reduce((s,v)=>s+v,0);
              const totalR = totalH * r.billRate;
              return (
                <tr key={r.id} style={{borderBottom:"1px solid #0a1626"}}>
                  <td style={{padding:"6px 14px",minWidth:160}}>
                    <EditCell rid={r.id} field="name" value={r.name} style={{fontWeight:600,color:"#cbd5e1"}}/>
                    <EditCell rid={r.id} field="role" value={r.role} style={{fontSize:10,color:"#3d5a7a"}}/>
                  </td>
                  <td style={{padding:"4px 6px",minWidth:55}}>
                    <EditCell rid={r.id} field="billRate" value={`$${r.billRate}`} style={{fontFamily:"'DM Mono',monospace",color:"#7dd3fc",fontSize:12}}/>
                  </td>
                  {hrs.map((h,mi)=>(
                    <td key={mi} style={{padding:"4px 4px",textAlign:"center"}}>
                      <input className="inp" type="number" value={h} onChange={e=>updateHrs(r.id,mi,e.target.value)}
                        style={{width:50,padding:"4px 6px",textAlign:"center",fontSize:12,background:h===0?"#0a0f1a":mi<3?"#0c1e10":"#0b1120"}}/>
                    </td>
                  ))}
                  <td className="mono" style={{padding:"8px 12px",textAlign:"right",fontWeight:700,color:"#e2e8f0"}}>{totalH}h</td>
                  <td className="mono" style={{padding:"8px 12px",textAlign:"right",color:"#38bdf8",fontWeight:600}}>{fmt(totalR)}</td>
                </tr>
              );
            })}
            <tr style={{background:"#0a1626",borderTop:"1px solid #1a2d45"}}>
              <td style={{padding:"10px 14px",fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}} colSpan={2}>TOTALS</td>
              {totalsByMonth.map((t,i)=>(
                <td key={i} className="mono" style={{padding:"8px 10px",textAlign:"center",fontWeight:700,fontSize:12,color:t>0?"#34d399":"#3d5a7a"}}>{t}</td>
              ))}
              <td className="mono" style={{padding:"10px 12px",textAlign:"right",fontWeight:700,fontSize:13,color:"#e2e8f0"}}>{totalsByMonth.reduce((s,v)=>s+v,0)}h</td>
              <td className="mono" style={{padding:"10px 12px",textAlign:"right",fontWeight:700,fontSize:13,color:"#38bdf8"}}>{fmt(totalRevByMonth.reduce((s,v)=>s+v,0))}</td>
            </tr>
            <tr style={{background:"#050910"}}>
              <td style={{padding:"8px 14px",fontSize:10,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}} colSpan={2}>Rev/Mo</td>
              {totalRevByMonth.map((r,i)=>(
                <td key={i} className="mono" style={{padding:"6px 10px",textAlign:"center",fontSize:11,color:"#7dd3fc"}}>{fmt(r/1000)}k</td>
              ))}
              <td colSpan={2}/>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CLIENT PORTFOLIO ─────────────────────────────────────────────────────────
function ClientPortfolio({ clients, setClients, finInvoices, finPayments }) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const empty = { name:"", vertical:"", engType:"Staff Aug", annualRev:"", consultants:"", grossMargin:"", health:"Green", renewal:"", notes:"" };

  const open = (c=null) => { setEditing(c?.id||null); setForm(c?{...c}:{...empty}); setModal(true); };
  const save = () => {
    const f = { ...form, annualRev:+form.annualRev, consultants:+form.consultants, grossMargin:+form.grossMargin };
    if (editing) setClients(cs=>cs.map(c=>c.id===editing?f:c));
    else setClients(cs=>[...cs,{...f,id:"cl"+uid()}]);
    setModal(false);
  };
  const del = id => setClients(cs=>cs.filter(c=>c.id!==id));

  // Auto-score client health from AR data + renewal proximity
  const autoHealth = (cl) => {
    const invs = (finInvoices||[]).filter(i=>i.clientId===cl.id);
    const overdueAmt = invs.filter(i=>i.status==="overdue").reduce((s,i)=>s+invBalance(i,finPayments||[]),0);
    const totalAR    = invs.filter(i=>["sent","overdue"].includes(i.status)).reduce((s,i)=>s+invBalance(i,finPayments||[]),0);
    const overdueRatio = totalAR > 0 ? overdueAmt / totalAR : 0;
    const renewalDays  = cl.renewal ? daysUntil(cl.renewal) : 999;
    if (overdueRatio > 0.5 || renewalDays < 20) return "Red";
    if (overdueRatio > 0.15 || renewalDays < 60) return "Amber";
    return "Green";
  };

  const totals = { rev: clients.reduce((s,c)=>s+c.annualRev,0), ebitda: clients.reduce((s,c)=>s+Math.round(c.annualRev*c.grossMargin),0) };

  return (
    <div>
      <PH title="Client Portfolio" sub="Track client health, engagement types, revenue and renewal dates">
        <button className="btn bp" onClick={()=>open()}><I d={ICONS.plus} s={14}/>Add Client</button>
      </PH>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:18}}>
        {[{l:"Total Portfolio Revenue",v:fmt(totals.rev),c:"#38bdf8"},{l:"EBITDA Contribution",v:fmt(totals.ebitda),c:"#34d399"},{l:"Active Clients",v:clients.filter(c=>c.health!=="Red").length+" of "+clients.length,c:"#a78bfa"}].map(k=>(
          <div key={k.l} className="card" style={{padding:"16px 20px"}}><div className="th" style={{marginBottom:6}}>{k.l}</div><div className="mono" style={{fontSize:22,fontWeight:700,color:k.c}}>{k.v}</div></div>
        ))}
      </div>
      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1.2fr 100px 120px 100px 60px 80px 80px 100px auto",padding:"8px 18px"}}>
          {["Client","Vertical","Engagement","Revenue","Cslt.","Margin","Health","Renewal",""].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {clients.map(c=>(
          <div key={c.id} className="tr" style={{gridTemplateColumns:"1.2fr 100px 120px 100px 60px 80px 80px 100px auto"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
              <div style={{fontSize:10,color:"#3d5a7a",marginTop:1}}>{c.notes}</div>
            </div>
            <span style={{fontSize:11,color:"#64748b"}}>{c.vertical}</span>
            <span className="bdg" style={{background:"#0c1e30",color:"#7dd3fc",width:"fit-content"}}>{c.engType}</span>
            <span className="mono" style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{fmt(c.annualRev)}</span>
            <span className="mono" style={{fontSize:12,color:"#94a3b8",textAlign:"center"}}>{c.consultants}</span>
            <span className="mono" style={{fontSize:12,color:"#34d399"}}>{pct(c.grossMargin)}</span>
            {(()=>{ const h=autoHealth(c); return (
              <span className="bdg" style={{background:h==="Green"?"#022c22":h==="Amber"?"#451a03":"#2d0a0a",color:healthColor[h]}}>
                {h}{h!==c.health&&<span style={{fontSize:8,marginLeft:3,opacity:0.6}}>auto</span>}
              </span>
            );})()}
            <span style={{fontSize:11,color:"#475569"}}>{fmtDate(c.renewal)}</span>
            <div style={{display:"flex",gap:6}}>
              <button className="btn bg" style={{padding:"4px 8px"}} onClick={()=>open(c)}><I d={ICONS.edit} s={12}/></button>
              <button className="btn br" style={{padding:"4px 8px"}} onClick={()=>del(c.id)}><I d={ICONS.trash} s={12}/></button>
            </div>
          </div>
        ))}
      </div>
      {modal && form && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal">
            <MH title={editing?"Edit Client":"Add Client"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Client Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="AT&T"/></FF>
              <FF label="Vertical"><input className="inp" value={form.vertical} onChange={e=>setForm({...form,vertical:e.target.value})} placeholder="Telecom"/></FF>
              <FF label="Engagement Type"><select className="inp" value={form.engType} onChange={e=>setForm({...form,engType:e.target.value})}>{["Managed Services","Staff Aug","Project","Retainer","Internal"].map(o=><option key={o}>{o}</option>)}</select></FF>
              <FF label="Annual Revenue"><input className="inp" type="number" value={form.annualRev} onChange={e=>setForm({...form,annualRev:e.target.value})} placeholder="1200000"/></FF>
              <FF label="# Consultants"><input className="inp" type="number" value={form.consultants} onChange={e=>setForm({...form,consultants:e.target.value})} placeholder="4"/></FF>
              <FF label="Gross Margin (0-1)"><input className="inp" type="number" step="0.01" value={form.grossMargin} onChange={e=>setForm({...form,grossMargin:e.target.value})} placeholder="0.22"/></FF>
              <FF label="Health"><select className="inp" value={form.health} onChange={e=>setForm({...form,health:e.target.value})}><option>Green</option><option>Amber</option><option>Red</option></select></FF>
              <FF label="Renewal Date"><input className="inp" type="date" value={form.renewal} onChange={e=>setForm({...form,renewal:e.target.value})}/></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} style={{resize:"none"}} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Account notes..."/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:18}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save Client</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── HIRING PIPELINE ──────────────────────────────────────────────────────────
function Pipeline({ pipeline, setPipeline }) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const empty = { name:"", role:"", billRate:"", status:"Screening", readyIn:"", source:"", skills:"" };
  const statuses = ["Screening","Interviewing","Reference Check","Offer Pending","Hired","Declined"];

  const open = (p=null) => { setEditing(p?.id||null); setForm(p?{...p}:{...empty}); setModal(true); };
  const save = () => {
    const f = { ...form, billRate:+form.billRate };
    if (editing) setPipeline(ps=>ps.map(p=>p.id===editing?f:p));
    else setPipeline(ps=>[...ps,{...f,id:"p"+uid()}]);
    setModal(false);
  };
  const del = id => setPipeline(ps=>ps.filter(p=>p.id!==id));

  const estRevYear = r => Math.round(r.billRate * BURDEN.hoursPerYear * 0.75);
  const grouped = statuses.reduce((acc,s)=>{ acc[s]=pipeline.filter(p=>p.status===s); return acc; },{});

  return (
    <div>
      <PH title="Hiring Pipeline" sub={`${pipeline.length} candidates · Est. pipeline rev: ${fmt(pipeline.reduce((s,p)=>s+estRevYear(p),0))}/yr at 75% util`}>
        <button className="btn bp" onClick={()=>open()}><I d={ICONS.plus} s={14}/>Add Candidate</button>
      </PH>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:18}}>
        {["Screening","Interviewing","Reference Check","Offer Pending"].map(s=>(
          <div key={s} className="card" style={{padding:"12px 16px"}}>
            <div style={{fontSize:10,fontWeight:700,color:pipelineColor[s]||"#94a3b8",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>{s}</div>
            <div className="mono" style={{fontSize:20,fontWeight:700,color:"#e2e8f0"}}>{(grouped[s]||[]).length}</div>
            <div style={{fontSize:11,color:"#3d5a7a"}}>{fmt((grouped[s]||[]).reduce((s2,p)=>s2+estRevYear(p),0))}/yr potential</div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1.2fr 1fr 80px 120px 100px 100px auto",padding:"8px 18px"}}>
          {["Candidate","Role","Rate","Status","Ready In","Source",""].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {pipeline.map(p=>(
          <div key={p.id} className="tr" style={{gridTemplateColumns:"1.2fr 1fr 80px 120px 100px 100px auto"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{p.name}</div>
              <div style={{fontSize:10,color:"#3d5a7a"}}>{p.skills}</div>
            </div>
            <span style={{fontSize:12,color:"#64748b"}}>{p.role}</span>
            <span className="mono" style={{fontSize:12,color:"#38bdf8"}}>${p.billRate}/hr</span>
            <span className="bdg" style={{background:"#0c1e30",color:pipelineColor[p.status]||"#94a3b8",width:"fit-content",whiteSpace:"nowrap"}}>{p.status}</span>
            <span style={{fontSize:11,color:"#475569"}}>{p.readyIn}</span>
            <span style={{fontSize:11,color:"#475569"}}>{p.source}</span>
            <div style={{display:"flex",gap:6}}>
              <button className="btn bg" style={{padding:"4px 8px"}} onClick={()=>open(p)}><I d={ICONS.edit} s={12}/></button>
              <button className="btn br" style={{padding:"4px 8px"}} onClick={()=>del(p.id)}><I d={ICONS.trash} s={12}/></button>
            </div>
          </div>
        ))}
      </div>
      {modal && form && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal">
            <MH title={editing?"Edit Candidate":"Add Candidate"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Candidate K"/></FF>
              <FF label="Role"><input className="inp" value={form.role} onChange={e=>setForm({...form,role:e.target.value})} placeholder="SAP BRIM Consultant"/></FF>
              <FF label="Bill Rate/hr"><input className="inp" type="number" value={form.billRate} onChange={e=>setForm({...form,billRate:e.target.value})}/></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{statuses.map(s=><option key={s}>{s}</option>)}</select></FF>
              <FF label="Ready In"><input className="inp" value={form.readyIn} onChange={e=>setForm({...form,readyIn:e.target.value})} placeholder="2 weeks"/></FF>
              <FF label="Source"><select className="inp" value={form.source} onChange={e=>setForm({...form,source:e.target.value})}>{["Referral","LinkedIn","Network","Job Board","Other"].map(s=><option key={s}>{s}</option>)}</select></FF>
            </div>
            <FF label="Skills"><input className="inp" value={form.skills} onChange={e=>setForm({...form,skills:e.target.value})} placeholder="SAP BRIM, IS-U, ABAP"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:18}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EBITDA OPTIMIZER ─────────────────────────────────────────────────────────
function EbitdaOpt({ ebitdaLevers, setEbitdaLevers }) {
  const BASE_REV = 2350000, BASE_EBITDA = 188000;
  const toggle = id => setEbitdaLevers(ls=>ls.map(l=>l.id===id?{...l,done:!l.done}:l));
  const active = ebitdaLevers.filter(l=>l.done);
  const revUplift = active.reduce((s,l)=>s+l.revImpact,0);
  const ebitdaUplift = active.reduce((s,l)=>s+l.ebitdaImpact,0);
  const projRev = BASE_REV + revUplift;
  const projEbitda = BASE_EBITDA + ebitdaUplift;
  const maxEbitda = ebitdaLevers.reduce((s,l)=>s+l.ebitdaImpact,0) + BASE_EBITDA;

  return (
    <div>
      <PH title="EBITDA Optimizer & Exit Planner" sub="Toggle levers to model revenue and exit value impact"/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18,marginBottom:22}}>
        <div className="card" style={{padding:20}}>
          <div className="th" style={{marginBottom:14}}>Projected Metrics</div>
          {[
            {l:"Base Revenue",v:fmt(BASE_REV),c:"#64748b"},
            {l:"Revenue Uplift (activated)",v:"+"+fmt(revUplift),c:"#34d399"},
            {l:"Projected Revenue",v:fmt(projRev),c:"#38bdf8"},
            {l:"Projected EBITDA",v:fmt(projEbitda),c:"#34d399"},
            {l:"EBITDA Margin",v:pct(projRev>0?projEbitda/projRev:0),c:"#a78bfa"},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",marginBottom:10,paddingBottom:10,borderBottom:"1px solid #111d2d"}}>
              <span style={{fontSize:12,color:"#3d5a7a"}}>{r.l}</span>
              <span className="mono" style={{fontSize:14,fontWeight:600,color:r.c}}>{r.v}</span>
            </div>
          ))}
        </div>
        <div className="card" style={{padding:20}}>
          <div className="th" style={{marginBottom:14}}>Exit Scenarios</div>
          {[
            {m:"5×",v:projEbitda*5,c:"#f59e0b"},{m:"7×",v:projEbitda*7,c:"#34d399"},{m:"10×",v:projEbitda*10,c:"#818cf8"}
          ].map(s=>(
            <div key={s.m} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div>
                <div className="mono" style={{fontSize:22,fontWeight:700,color:s.c}}>{fmt(s.v)}</div>
                <div style={{fontSize:11,color:"#3d5a7a"}}>Exit at {s.m} EBITDA multiple</div>
              </div>
              <div style={{width:80,height:8,background:"#0a1626",borderRadius:4,overflow:"hidden"}}>
                <div style={{height:"100%",background:s.c,width:pct(Math.min(1,s.v/20000000)),transition:"width 0.4s"}}/>
              </div>
            </div>
          ))}
          <div style={{borderTop:"1px solid #111d2d",paddingTop:12,marginTop:4}}>
            <div style={{fontSize:11,color:"#3d5a7a",marginBottom:4}}>Max EBITDA (all levers): <span className="mono" style={{color:"#34d399"}}>{fmt(maxEbitda)}</span></div>
            <div style={{fontSize:11,color:"#3d5a7a"}}>Max Exit @ 7×: <span className="mono" style={{color:"#34d399"}}>{fmt(maxEbitda*7)}</span></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-hdr">Growth Levers</div>
        <div className="tr" style={{gridTemplateColumns:"40px 1fr 100px 110px 70px 90px",padding:"8px 18px"}}>
          {["","Lever","Rev Impact","EBITDA Impact","Effort","Timeframe"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {ebitdaLevers.map(l=>(
          <div key={l.id} className="tr" style={{gridTemplateColumns:"40px 1fr 100px 110px 70px 90px",background:l.done?"#081c10":"transparent"}}>
            <input type="checkbox" checked={l.done} onChange={()=>toggle(l.id)} style={{width:16,height:16,cursor:"pointer",accentColor:"#34d399"}}/>
            <span style={{fontSize:13,color:l.done?"#34d399":"#94a3b8",fontWeight:l.done?600:400,textDecoration:l.done?"none":"none"}}>{l.lever}</span>
            <span className="mono" style={{fontSize:12,color:l.revImpact>0?"#38bdf8":"#3d5a7a"}}>{l.revImpact>0?"+"+fmt(l.revImpact):"—"}</span>
            <span className="mono" style={{fontSize:12,color:"#34d399"}}>+{fmt(l.ebitdaImpact)}</span>
            <span className="bdg" style={{background:"#0a1626",color:effortColor[l.effort],width:"fit-content"}}>{l.effort}</span>
            <span style={{fontSize:11,color:"#475569"}}>{l.timeframe}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── P&L ─────────────────────────────────────────────────────────────────────
function PandL({ plIncome, setPlIncome, plExpense, setPlExpense }) {
  const [view, setView] = useState("pl"); // pl | projection
  const incomeByMonth = MONTHS.map((_,mi) => plIncome.reduce((s,r)=>s+(r.months[mi]||0),0));
  const expByMonth = MONTHS.map((_,mi) => plExpense.reduce((s,r)=>s+(r.months[mi]||0),0));
  const netByMonth = MONTHS.map((_,mi) => incomeByMonth[mi] - expByMonth[mi]);
  const totalIncome = incomeByMonth.reduce((s,v)=>s+v,0);
  const totalExp = expByMonth.reduce((s,v)=>s+v,0);
  const totalNet = totalIncome - totalExp;
  const ytdInc = incomeByMonth.slice(0,3).reduce((s,v)=>s+v,0);
  const ytdNet = netByMonth.slice(0,3).reduce((s,v)=>s+v,0);

  const updateIncome = (id, mi, val) => setPlIncome(rows=>rows.map(r=>r.id===id?{...r,months:r.months.map((v,i)=>i===mi?+val:v)}:r));
  const updateExp = (id, mi, val) => setPlExpense(rows=>rows.map(r=>r.id===id?{...r,months:r.months.map((v,i)=>i===mi?+val:v)}:r));

  const catColor = { Consulting:"#38bdf8", Internal:"#a78bfa", Retainer:"#34d399", Misc:"#64748b", Payroll:"#f87171", Benefits:"#f59e0b", Delivery:"#818cf8", Incentives:"#10b981", OpEx:"#94a3b8", Growth:"#38bdf8" };

  return (
    <div>
      <PH title="Income & Expenses (P&L)" sub="Monthly view · Enter actuals for past months · Projections for future"/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
        {[{l:"Annual Revenue",v:fmt(totalIncome),c:"#38bdf8"},{l:"Annual Expenses",v:fmt(totalExp),c:"#f87171"},{l:"Annual Net Profit",v:fmt(totalNet),c:"#34d399"},{l:"Net Margin",v:pct(totalIncome>0?totalNet/totalIncome:0),c:"#a78bfa"}].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 18px"}}><div className="th" style={{marginBottom:6}}>{k.l}</div><div className="mono" style={{fontSize:20,fontWeight:700,color:k.c}}>{k.v}</div><div style={{fontSize:10,color:"#3d5a7a"}}>YTD: {k.l==="Annual Revenue"?fmt(ytdInc):k.l==="Annual Net Profit"?fmt(ytdNet):""}</div></div>
        ))}
      </div>

      <div className="card" style={{overflowX:"auto",marginBottom:18}}>
        <div className="section-hdr" style={{paddingLeft:18}}>▶ INCOME</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr style={{borderBottom:"1px solid #111d2d"}}>
            <th className="th" style={{padding:"8px 18px",textAlign:"left",minWidth:220}}>Line Item</th>
            <th className="th" style={{padding:"6px",textAlign:"left",minWidth:80}}>Category</th>
            {MONTHS.map(m=><th key={m} className="th" style={{padding:"6px 8px",textAlign:"right",minWidth:70}}>{m}</th>)}
            <th className="th" style={{padding:"6px 14px",textAlign:"right",minWidth:90}}>TOTAL</th>
          </tr></thead>
          <tbody>
            {plIncome.map(r=>(
              <tr key={r.id} style={{borderBottom:"1px solid #0a1626"}}>
                <td style={{padding:"7px 18px",fontSize:12,color:"#94a3b8",whiteSpace:"nowrap"}}>{r.label}</td>
                <td><span className="bdg" style={{background:"#0a1626",color:catColor[r.category]||"#94a3b8",fontSize:10}}>{r.category}</span></td>
                {r.months.map((v,mi)=>(
                  <td key={mi} style={{padding:"3px 4px",textAlign:"right"}}>
                    <input className="inp" type="number" value={v} onChange={e=>updateIncome(r.id,mi,e.target.value)}
                      style={{width:66,padding:"3px 5px",textAlign:"right",fontSize:11,background:v===0?"#060a10":mi<3?"#0c1e10":"#0b1120"}}/>
                  </td>
                ))}
                <td className="mono" style={{padding:"7px 14px",textAlign:"right",fontWeight:600,color:"#38bdf8"}}>{fmt(r.months.reduce((s,v)=>s+v,0))}</td>
              </tr>
            ))}
            <tr style={{background:"#0a1626",borderTop:"1px solid #1a2d45"}}>
              <td colSpan={2} style={{padding:"9px 18px",fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}}>TOTAL INCOME</td>
              {incomeByMonth.map((v,i)=><td key={i} className="mono" style={{padding:"9px 8px",textAlign:"right",fontWeight:700,fontSize:12,color:"#38bdf8"}}>{fmt(v/1000)}k</td>)}
              <td className="mono" style={{padding:"9px 14px",textAlign:"right",fontWeight:800,fontSize:13,color:"#38bdf8"}}>{fmt(totalIncome)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card" style={{overflowX:"auto",marginBottom:18}}>
        <div className="section-hdr" style={{paddingLeft:18}}>▶ EXPENSES</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead><tr style={{borderBottom:"1px solid #111d2d"}}>
            <th className="th" style={{padding:"8px 18px",textAlign:"left",minWidth:220}}>Line Item</th>
            <th className="th" style={{padding:"6px",textAlign:"left",minWidth:80}}>Category</th>
            {MONTHS.map(m=><th key={m} className="th" style={{padding:"6px 8px",textAlign:"right",minWidth:70}}>{m}</th>)}
            <th className="th" style={{padding:"6px 14px",textAlign:"right",minWidth:90}}>TOTAL</th>
          </tr></thead>
          <tbody>
            {plExpense.map(r=>(
              <tr key={r.id} style={{borderBottom:"1px solid #0a1626"}}>
                <td style={{padding:"7px 18px",fontSize:12,color:"#94a3b8",whiteSpace:"nowrap"}}>{r.label}</td>
                <td><span className="bdg" style={{background:"#0a1626",color:catColor[r.category]||"#94a3b8",fontSize:10}}>{r.category}</span></td>
                {r.months.map((v,mi)=>(
                  <td key={mi} style={{padding:"3px 4px",textAlign:"right"}}>
                    <input className="inp" type="number" value={v} onChange={e=>updateExp(r.id,mi,e.target.value)}
                      style={{width:66,padding:"3px 5px",textAlign:"right",fontSize:11,background:v===0?"#060a10":mi<3?"#1a0808":"#0b1120"}}/>
                  </td>
                ))}
                <td className="mono" style={{padding:"7px 14px",textAlign:"right",fontWeight:600,color:"#f87171"}}>{fmt(r.months.reduce((s,v)=>s+v,0))}</td>
              </tr>
            ))}
            <tr style={{background:"#0a1626",borderTop:"1px solid #1a2d45"}}>
              <td colSpan={2} style={{padding:"9px 18px",fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}}>TOTAL EXPENSES</td>
              {expByMonth.map((v,i)=><td key={i} className="mono" style={{padding:"9px 8px",textAlign:"right",fontWeight:700,fontSize:12,color:"#f87171"}}>{fmt(v/1000)}k</td>)}
              <td className="mono" style={{padding:"9px 14px",textAlign:"right",fontWeight:800,fontSize:13,color:"#f87171"}}>{fmt(totalExp)}</td>
            </tr>
            <tr style={{background:"#070e16",borderTop:"2px solid #1a2d45"}}>
              <td colSpan={2} style={{padding:"11px 18px",fontSize:12,fontWeight:800,color:"#e2e8f0",textTransform:"uppercase",letterSpacing:"0.07em"}}>NET PROFIT / (LOSS)</td>
              {netByMonth.map((v,i)=><td key={i} className="mono" style={{padding:"9px 8px",textAlign:"right",fontWeight:700,fontSize:12,color:v>=0?"#34d399":"#f87171"}}>{fmt(v/1000)}k</td>)}
              <td className="mono" style={{padding:"11px 14px",textAlign:"right",fontWeight:800,fontSize:14,color:totalNet>=0?"#34d399":"#f87171"}}>{fmt(totalNet)}</td>
            </tr>
            <tr style={{background:"#050910"}}>
              <td colSpan={2} style={{padding:"7px 18px",fontSize:11,color:"#3d5a7a",fontWeight:700}}>NET MARGIN %</td>
              {netByMonth.map((v,i)=><td key={i} className="mono" style={{padding:"6px 8px",textAlign:"right",fontSize:11,color:v>=0?"#34d399":"#f87171"}}>{pct(incomeByMonth[i]>0?v/incomeByMonth[i]:0)}</td>)}
              <td className="mono" style={{padding:"7px 14px",textAlign:"right",fontSize:12,fontWeight:700,color:"#a78bfa"}}>{pct(totalIncome>0?totalNet/totalIncome:0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CSV UTILITIES ────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g,"").trim());
  return lines.slice(1).map(line => {
    // handle quoted fields with commas inside
    const cols = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
      else { cur += line[i]; }
    }
    cols.push(cur.trim());
    const obj = {};
    headers.forEach((h,i) => { obj[h] = (cols[i]||"").replace(/^"|"$/g,"").trim(); });
    return obj;
  }).filter(row => Object.values(row).some(v => v !== ""));
}

function downloadCSV(filename, rows, headers) {
  const escape = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type:"text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.style.display = "none";
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
}

function ImportBanner({ format, fields, onClose }) {
  return (
    <div style={{background:"#050e1c",border:"1px solid #1a2d45",borderRadius:10,padding:"14px 18px",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div>
          <div style={{fontSize:12,fontWeight:700,color:"#38bdf8",marginBottom:6}}>📋 Expected CSV Format ({format})</div>
          <div className="mono" style={{fontSize:11,color:"#475569",lineHeight:1.7}}>
            {fields.join(", ")}
          </div>
        </div>
        <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={onClose}>✕</button>
      </div>
    </div>
  );
}

// ─── ADP PAYROLL ──────────────────────────────────────────────────────────────
// ADP Workforce Now CSV export columns (Payroll Register Report)
const ADP_HEADERS = ["Co Code","Batch ID","Employee ID","Employee Name","Pay Period Start","Pay Period End","Pay Date","Regular Hours","OT Hours","Gross Pay","Fed Tax","State Tax","FICA EE","Medicare EE","FICA ER","Medicare ER","401k ER","Health ER","Other Deductions","Net Pay","Department","Position"];
const ADP_SAMPLE_ROWS = [
  {"Co Code":"ZKS","Batch ID":"B001","Employee ID":"EMP001","Employee Name":"Suresh Menon","Pay Period Start":"2026-03-01","Pay Period End":"2026-03-31","Pay Date":"2026-03-31","Regular Hours":"160","OT Hours":"0","Gross Pay":"10000","Fed Tax":"1800","State Tax":"400","FICA EE":"765","Medicare EE":"145","FICA ER":"765","Medicare ER":"145","401k ER":"300","Health ER":"600","Other Deductions":"125","Net Pay":"6890","Department":"Consulting","Position":"BRIM Sr Consultant"},
  {"Co Code":"ZKS","Batch ID":"B001","Employee ID":"EMP002","Employee Name":"Deepa Rao","Pay Period Start":"2026-03-01","Pay Period End":"2026-03-31","Pay Date":"2026-03-31","Regular Hours":"160","OT Hours":"0","Gross Pay":"8167","Fed Tax":"1430","State Tax":"327","FICA EE":"625","Medicare EE":"118","FICA ER":"625","Medicare ER":"118","401k ER":"245","Health ER":"600","Other Deductions":"102","Net Pay":"5667","Department":"Consulting","Position":"SAP Functional"},
];

function ADPPayroll({ roster, adpRuns, setAdpRuns }) {
  const [importModal, setImportModal] = useState(false);
  const [importPreview, setImportPreview] = useState([]);
  const [importError, setImportError] = useState("");
  const [showFormat, setShowFormat] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const ftes = roster.filter(r=>r.type==="FTE");
  const calcBurden = emp => {
    const b = BURDEN;
    const fica = emp.baseSalary * b.fica / 12;
    const futa = b.futa * Math.min(emp.baseSalary, b.futaCap) / 12;
    const suta = b.suta * Math.min(emp.baseSalary, b.sutaCap) / 12;
    const wc = emp.baseSalary * b.wc / 12;
    const health = b.health / 12;
    const ret = emp.baseSalary * b.retire / 12;
    const oth = emp.baseSalary * b.other / 12;
    const gross = emp.baseSalary / 12;
    const taxes = fica + futa + suta + wc;
    const benefits = health + ret + oth;
    return { gross, taxes, benefits, fica, futa, suta, wc, health, ret, oth };
  };

  const [confirmRun, setConfirmRun] = useState(null); // id of run to confirm

  const processRun = id => {
    const run = adpRuns.find(r => r.id === id);
    if (run) setConfirmRun(run);
  };
  const confirmProcess = () => {
    if (!confirmRun) return;
    setAdpRuns(runs => runs.map(r => r.id===confirmRun.id ? {...r, status:"processed", processedAt:TODAY_STR} : r));
    setConfirmRun(null);
  };
  const totalPayroll = ftes.reduce((s,e)=>s+e.baseSalary/12,0);

  // Parse ADP CSV upload
  const handleADPFile = text => {
    setImportError("");
    try {
      const rows = parseCSV(text);
      if (!rows.length) { setImportError("No data rows found. Check the file format."); return; }
      // Validate key columns exist
      const required = ["Employee Name","Pay Date","Gross Pay","Net Pay"];
      const missing = required.filter(k => !(k in rows[0]));
      if (missing.length) { setImportError(`Missing columns: ${missing.join(", ")}. Download sample to see expected format.`); return; }
      setImportPreview(rows);
    } catch(e) { setImportError("Could not parse CSV: " + e.message); }
  };

  const commitADPImport = () => {
    // Group rows by Pay Date to create payroll run summaries
    const byDate = {};
    importPreview.forEach(row => {
      const d = row["Pay Date"] || row["Pay Period End"] || "Unknown";
      if (!byDate[d]) byDate[d] = { rows:[], gross:0, taxes:0, benefits:0, net:0, employees:new Set() };
      const g = parseFloat((row["Gross Pay"]||"0").replace(/[$,]/g,"")) || 0;
      const fedT = parseFloat((row["Fed Tax"]||"0").replace(/[$,]/g,"")) || 0;
      const stT = parseFloat((row["State Tax"]||"0").replace(/[$,]/g,"")) || 0;
      const ficaER = parseFloat((row["FICA ER"]||"0").replace(/[$,]/g,"")) || 0;
      const medER = parseFloat((row["Medicare ER"]||"0").replace(/[$,]/g,"")) || 0;
      const k401 = parseFloat((row["401k ER"]||"0").replace(/[$,]/g,"")) || 0;
      const hlth = parseFloat((row["Health ER"]||"0").replace(/[$,]/g,"")) || 0;
      const n = parseFloat((row["Net Pay"]||"0").replace(/[$,]/g,"")) || 0;
      byDate[d].gross += g;
      byDate[d].taxes += ficaER + medER;
      byDate[d].benefits += k401 + hlth;
      byDate[d].net += n;
      byDate[d].employees.add(row["Employee Name"] || row["Employee ID"]);
      byDate[d].rows.push(row);
    });

    const newRuns = Object.entries(byDate).map(([date, data]) => {
      const d = new Date(date + "T00:00:00");
      const period = d.toLocaleDateString("en-US",{month:"short",year:"numeric"});
      return {
        id: "adp_" + uid(),
        period,
        payDate: date,
        status: "processed",
        gross: Math.round(data.gross),
        taxes: Math.round(data.taxes),
        benefits: Math.round(data.benefits),
        net: Math.round(data.net),
        employees: data.employees.size,
        source: "imported"
      };
    });

    setAdpRuns(runs => [...runs, ...newRuns]);
    setImportModal(false);
    setImportPreview([]);
  };

  // Export payroll register as ADP-compatible CSV
  const exportADPCSV = () => {
    const rows = ftes.map((e, idx) => {
      const b = calcBurden(e);
      const gross = Math.round(b.gross);
      const net = Math.round(b.gross * 0.78);
      return {
        "Co Code":"ZKS", "Batch ID":"B_EXP", "Employee ID":`EMP${String(idx+1).padStart(3,"0")}`,
        "Employee Name":e.name, "Pay Period Start":"2026-03-01", "Pay Period End":"2026-03-31",
        "Pay Date":"2026-03-31", "Regular Hours":"160", "OT Hours":"0",
        "Gross Pay":gross, "Fed Tax":Math.round(gross*0.18), "State Tax":Math.round(gross*0.04),
        "FICA EE":Math.round(b.fica), "Medicare EE":Math.round(b.fica*0.19),
        "FICA ER":Math.round(b.fica), "Medicare ER":Math.round(b.fica*0.19),
        "401k ER":Math.round(b.ret), "Health ER":Math.round(b.health),
        "Other Deductions":Math.round(b.oth), "Net Pay":net,
        "Department":"Consulting", "Position":e.role
      };
    });
    downloadCSV("ziksatech_adp_payroll_mar2026.csv", rows, ADP_HEADERS);
  };

  // Download blank ADP template
  const downloadTemplate = () => downloadCSV("adp_payroll_template.csv", ADP_SAMPLE_ROWS, ADP_HEADERS);

  const handleDrop = e => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const r = new FileReader(); r.onload = ev => handleADPFile(ev.target.result); r.readAsText(file);
  };

  return (
    <div>
      <PH title="ADP Payroll" sub="ADP Workforce Now · Import payroll register CSV · Export for ADP upload">
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span className="adp-badge" style={{padding:"5px 12px",fontSize:12}}>ADP Workforce Now</span>
          <button className="btn bg" style={{fontSize:12}} onClick={downloadTemplate}>↓ Template</button>
          <button className="btn bg" style={{fontSize:12}} onClick={exportADPCSV}>↑ Export CSV</button>
          <button className="btn bp" style={{fontSize:12}} onClick={()=>setImportModal(true)}>↓ Import ADP CSV</button>
        </div>
      </PH>

      {/* How it works banner */}
      <div style={{display:"flex",gap:10,marginBottom:20,padding:"14px 18px",background:"#050e1c",border:"1px solid #1a2d45",borderRadius:10,alignItems:"flex-start"}}>
        <div style={{fontSize:18,marginTop:1}}>💡</div>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#7dd3fc",marginBottom:4}}>How to sync with ADP (until live integration)</div>
          <div style={{fontSize:12,color:"#475569",lineHeight:1.7}}>
            <b style={{color:"#94a3b8"}}>Import:</b> In ADP Workforce Now → Reports → Payroll Register → Export CSV → Upload here&nbsp;&nbsp;
            <b style={{color:"#94a3b8"}}>Export:</b> Click "Export CSV" above → Upload to ADP Workforce Now → Batch Payroll Input
          </div>
          <div style={{fontSize:11,color:"#3d5a7a",marginTop:6}}>
            ADP format: Company Code · Employee ID · Name · Pay Period · Hours · Gross Pay · Fed/State Tax · FICA ER · 401k ER · Health ER · Net Pay
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:22}}>
        {[
          {l:"Monthly Payroll (Gross)", v:fmt(totalPayroll),                                              c:"#38bdf8"},
          {l:"Employer Taxes",          v:fmt(ftes.reduce((s,e)=>s+calcBurden(e).taxes,0)),               c:"#f87171"},
          {l:"Benefits Cost",           v:fmt(ftes.reduce((s,e)=>s+calcBurden(e).benefits,0)),            c:"#f59e0b"},
          {l:"Total Monthly Burden",    v:fmt(ftes.reduce((s,e)=>{ const b=calcBurden(e); return s+b.gross+b.taxes+b.benefits; },0)), c:"#34d399"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 18px"}}><div className="th" style={{marginBottom:6}}>{k.l}</div><div className="mono" style={{fontSize:20,fontWeight:700,color:k.c}}>{k.v}</div></div>
        ))}
      </div>

      {/* Payroll Runs */}
      <div className="card" style={{marginBottom:18}}>
        <div className="section-hdr">
          Payroll Runs — 2026
          <div style={{display:"flex",gap:8}}>
            <button className="btn bg" style={{fontSize:11,padding:"5px 10px"}} onClick={()=>setShowFormat(!showFormat)}>
              {showFormat?"Hide":"View"} CSV Format
            </button>
          </div>
        </div>
        {showFormat && <div style={{padding:"0 18px 14px"}}><ImportBanner format="ADP Workforce Now Payroll Register" fields={ADP_HEADERS} onClose={()=>setShowFormat(false)}/></div>}
        <div className="tr" style={{gridTemplateColumns:"140px 110px 90px 90px 90px 90px 90px 120px",padding:"8px 18px"}}>
          {["Period","Pay Date","Employees","Gross","Er Taxes","Benefits","Net Pay","Status"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {adpRuns.map(r=>(
          <div key={r.id} className="tr" style={{gridTemplateColumns:"140px 110px 90px 90px 90px 90px 90px 120px"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r.period}</div>
              {r.source==="imported" && <div style={{fontSize:9,color:"#0284c7",marginTop:1}}>↓ imported from ADP</div>}
            </div>
            <span style={{fontSize:12,color:"#64748b"}}>{fmtDate(r.payDate)}</span>
            <span className="mono" style={{fontSize:12,color:"#94a3b8",textAlign:"center"}}>{r.employees}</span>
            <span className="mono" style={{fontSize:12,color:"#38bdf8"}}>{fmt(r.gross)}</span>
            <span className="mono" style={{fontSize:12,color:"#f87171"}}>{fmt(r.taxes)}</span>
            <span className="mono" style={{fontSize:12,color:"#f59e0b"}}>{fmt(r.benefits)}</span>
            <span className="mono" style={{fontSize:12,color:"#34d399"}}>{fmt(r.net)}</span>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <span className="bdg" style={{background:statusBg[r.status]||"#1e293b",color:statusColors[r.status]||"#94a3b8"}}>{r.status}</span>
              {r.status==="pending" && <button className="btn bs" style={{padding:"3px 8px",fontSize:11}} onClick={()=>processRun(r.id)}>Process</button>}
            </div>
          </div>
        ))}
        {adpRuns.length===0 && <div style={{padding:"32px",textAlign:"center",color:"#1e3a5f",fontSize:13}}>No payroll runs yet · Import ADP CSV to get started</div>}
      </div>

      {/* Employee breakdown */}
      <div className="card" style={{marginBottom:18}}>
        <div className="section-hdr">
          Employee Burden Breakdown
          <button className="btn bg" style={{fontSize:11,padding:"5px 10px"}} onClick={exportADPCSV}>↑ Export to ADP CSV</button>
        </div>
        <div className="tr" style={{gridTemplateColumns:"1.2fr 90px 80px 70px 70px 70px 80px 90px",padding:"8px 18px"}}>
          {["Employee","Base Salary","Monthly","Er FICA","FUTA","SUTA","Benefits","Total/mo"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {ftes.map(e=>{
          const b = calcBurden(e);
          return (
            <div key={e.id} className="tr" style={{gridTemplateColumns:"1.2fr 90px 80px 70px 70px 70px 80px 90px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{e.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{e.role}</div>
              </div>
              <span className="mono" style={{fontSize:12,color:"#38bdf8"}}>{fmt(e.baseSalary)}</span>
              <span className="mono" style={{fontSize:12,color:"#7dd3fc"}}>{fmt(b.gross)}</span>
              <span className="mono" style={{fontSize:11,color:"#64748b"}}>{fmt(b.fica)}</span>
              <span className="mono" style={{fontSize:11,color:"#64748b"}}>{fmt(b.futa)}</span>
              <span className="mono" style={{fontSize:11,color:"#64748b"}}>{fmt(b.suta)}</span>
              <span className="mono" style={{fontSize:11,color:"#f59e0b"}}>{fmt(b.benefits)}</span>
              <span className="mono" style={{fontSize:12,fontWeight:600,color:"#f87171"}}>{fmt(b.gross+b.taxes+b.benefits)}</span>
            </div>
          );
        })}
        <div className="tr" style={{gridTemplateColumns:"1.2fr 90px 80px 70px 70px 70px 80px 90px",background:"#0a1626"}}>
          <span style={{fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}}>TOTALS</span>
          <span className="mono" style={{fontSize:12,fontWeight:700,color:"#38bdf8"}}>{fmt(ftes.reduce((s,e)=>s+e.baseSalary,0))}</span>
          <span className="mono" style={{fontSize:12,fontWeight:700,color:"#7dd3fc"}}>{fmt(totalPayroll)}</span>
          <span/><span/><span/>
          <span className="mono" style={{fontSize:12,fontWeight:700,color:"#f59e0b"}}>{fmt(ftes.reduce((s,e)=>s+calcBurden(e).benefits,0))}</span>
          <span className="mono" style={{fontSize:12,fontWeight:700,color:"#f87171"}}>{fmt(ftes.reduce((s,e)=>{ const b=calcBurden(e); return s+b.gross+b.taxes+b.benefits; },0))}</span>
        </div>
      </div>

      {/* Contractor AP */}
      <div className="card">
        <div className="section-hdr">Contractor Payments (Accounts Payable)</div>
        <div className="tr" style={{gridTemplateColumns:"1.2fr 90px 80px 80px 80px 90px",padding:"8px 18px"}}>
          {["Contractor","Fixed Rate","Monthly Hrs","Monthly Pay","3rd Party","Total AP"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {roster.filter(r=>r.type==="Contractor").map(r=>{
          const moHrs = Math.round(r.util * BURDEN.hoursPerYear / 12);
          const moFixed = r.fixedRate * moHrs;
          const moTP = r.thirdPartySplit > 0 ? Math.round((r.billRate - r.fixedRate) * moHrs * r.thirdPartySplit) : 0;
          return (
            <div key={r.id} className="tr" style={{gridTemplateColumns:"1.2fr 90px 80px 80px 80px 90px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{r.role} · {r.client}</div>
              </div>
              <span className="mono" style={{fontSize:12,color:"#a78bfa"}}>${r.fixedRate}/hr</span>
              <span className="mono" style={{fontSize:12,color:"#64748b"}}>{moHrs}h</span>
              <span className="mono" style={{fontSize:12,color:"#f87171"}}>{fmt(moFixed)}</span>
              <span className="mono" style={{fontSize:12,color:"#f59e0b"}}>{moTP>0?fmt(moTP):"—"}</span>
              <span className="mono" style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{fmt(moFixed+moTP)}</span>
            </div>
          );
        })}
      </div>

      {/* Process Payroll Confirmation Modal */}
      {confirmRun && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setConfirmRun(null)}>
          <div className="modal" style={{maxWidth:460}}>
            <MH title="Confirm Payroll Processing" onClose={()=>setConfirmRun(null)}/>
            <div style={{padding:"0 4px 8px"}}>
              <div style={{background:"#0a1626",border:"1px solid #1a2d45",borderRadius:8,padding:16,marginBottom:16}}>
                <div style={{fontSize:13,color:"#cbd5e1",fontWeight:600,marginBottom:10}}>Payroll Run Details</div>
                {[
                  ["Period",    confirmRun.period],
                  ["Pay Date",  confirmRun.payDate],
                  ["Employees", `${confirmRun.employeeCount} FTEs`],
                  ["Gross Pay", `$${confirmRun.grossPay?.toLocaleString?.() ?? "—"}`],
                  ["Net Pay",   `$${confirmRun.netPay?.toLocaleString?.() ?? "—"}`],
                ].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:12,
                    padding:"5px 0",borderBottom:"1px solid #111d2d"}}>
                    <span style={{color:"#64748b"}}>{l}</span>
                    <span style={{color:"#e2e8f0",fontWeight:600}}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{background:"#1a0808",border:"1px solid #f8717144",borderRadius:6,
                padding:"10px 14px",fontSize:11,color:"#f87171",marginBottom:18}}>
                ⚠ This will mark the run as <strong>processed</strong> and lock it from further editing.
                Verify all amounts match your ADP dashboard before proceeding.
              </div>
              <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                <button className="btn bg" onClick={()=>setConfirmRun(null)}>Cancel</button>
                <button className="btn bs" onClick={confirmProcess}>✓ Confirm &amp; Process</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ADP Import Modal */}
      {importModal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setImportModal(false)}>
          <div className="modal" style={{maxWidth:680}}>
            <MH title="Import ADP Payroll CSV" onClose={()=>{setImportModal(false);setImportPreview([]);setImportError("");}}>
              <span className="adp-badge">ADP</span>
            </MH>

            <div style={{background:"#030810",border:"1px solid #1a2d45",borderRadius:9,padding:"12px 16px",marginBottom:16,fontSize:12,color:"#475569",lineHeight:1.7}}>
              <b style={{color:"#7dd3fc"}}>Where to get this file:</b> ADP Workforce Now → Reports → Standard Reports → Payroll → <b style={{color:"#94a3b8"}}>Payroll Register</b> → Export → CSV<br/>
              <b style={{color:"#7dd3fc"}}>Tip:</b> Click "↓ Template" on the main page first to see the exact expected column layout.
            </div>

            {importError && (
              <div style={{background:"#1a0808",border:"1px solid #3d1010",borderRadius:8,padding:"10px 14px",marginBottom:14,color:"#f87171",fontSize:12}}>
                ⚠ {importError}
              </div>
            )}

            {importPreview.length === 0 ? (
              <div
                onDragOver={e=>{e.preventDefault();setDragOver(true)}}
                onDragLeave={()=>setDragOver(false)}
                onDrop={handleDrop}
                style={{border:`2px dashed ${dragOver?"#0284c7":"#1a2d45"}`,borderRadius:12,padding:"40px 20px",textAlign:"center",transition:"border 0.2s",cursor:"pointer",background:dragOver?"#051628":"transparent"}}
              >
                <div style={{fontSize:32,marginBottom:10}}>📂</div>
                <div style={{fontSize:14,fontWeight:600,color:"#7dd3fc",marginBottom:6}}>Drop your ADP CSV here</div>
                <div style={{fontSize:12,color:"#3d5a7a",marginBottom:16}}>or click to browse</div>
                <button className="btn bp" onClick={()=>{ const inp=document.createElement("input"); inp.type="file"; inp.accept=".csv,.txt"; inp.onchange=e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>handleADPFile(ev.target.result); r.readAsText(f); }; inp.click(); }}>Browse File</button>
              </div>
            ) : (
              <div>
                <div style={{fontSize:12,color:"#34d399",fontWeight:600,marginBottom:10}}>
                  ✓ Parsed {importPreview.length} employee rows successfully
                </div>
                <div style={{overflowX:"auto",maxHeight:260,overflowY:"auto",marginBottom:16}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead>
                      <tr style={{borderBottom:"1px solid #1a2d45",background:"#050e1c",position:"sticky",top:0}}>
                        {["Employee Name","Pay Date","Gross Pay","FICA ER","401k ER","Health ER","Net Pay"].map(h=>(
                          <th key={h} className="th" style={{padding:"7px 10px",textAlign:"left"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.map((row,i)=>(
                        <tr key={i} style={{borderBottom:"1px solid #0a1626"}}>
                          {["Employee Name","Pay Date","Gross Pay","FICA ER","401k ER","Health ER","Net Pay"].map(h=>(
                            <td key={h} className="mono" style={{padding:"6px 10px",color:h==="Gross Pay"||h==="Net Pay"?"#38bdf8":"#94a3b8"}}>{row[h]||"—"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button className="btn bg" onClick={()=>{setImportPreview([]);setImportError("");}}>Re-upload</button>
                  <button className="btn bp" onClick={commitADPImport}><I d={ICONS.check} s={13}/>Import {importPreview.length} Records</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FRESHBOOKS CSV FORMAT ────────────────────────────────────────────────────
// FreshBooks invoice export columns (Invoices → Export)
const FB_HEADERS = ["Invoice Number","Client Name","Invoice Date","Due Date","PO Number","Invoice Total","Amount Paid","Balance Due","Currency","Status","Notes","Line Item - Description","Line Item - Quantity","Line Item - Unit Cost","Line Item - Amount"];
const FB_SAMPLE_ROWS = [
  {"Invoice Number":"FB-2605","Client Name":"AT&T","Invoice Date":"2026-03-31","Due Date":"2026-04-30","PO Number":"","Invoice Total":"100000","Amount Paid":"0","Balance Due":"100000","Currency":"USD","Status":"sent","Notes":"Net 30","Line Item - Description":"AT&T Managed Services — March 2026","Line Item - Quantity":"1","Line Item - Unit Cost":"100000","Line Item - Amount":"100000"},
  {"Invoice Number":"FB-2606","Client Name":"Client B","Invoice Date":"2026-03-31","Due Date":"2026-04-30","PO Number":"","Invoice Total":"40000","Amount Paid":"40000","Balance Due":"0","Currency":"USD","Status":"paid","Notes":"","Line Item - Description":"Client B Staff Augmentation — March 2026","Line Item - Quantity":"1","Line Item - Unit Cost":"40000","Line Item - Amount":"40000"},
];

// ─── FRESHBOOKS ───────────────────────────────────────────────────────────────
function FreshBooks({ clients, fbInvoices, setFbInvoices, tsHours, roster }) {
  const [filterStatus, setFilterStatus] = useState("all");
  const [newModal, setNewModal] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [importPreview, setImportPreview] = useState([]);
  const [importError, setImportError] = useState("");
  const [showFormat, setShowFormat] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [form, setForm] = useState({ clientId:"", date:new Date().toISOString().slice(0,10), due:"", desc:"", amount:"", status:"draft" });

  const nextId = () => {
    const nums = fbInvoices.map(i=>parseInt(i.id.replace("FB-",""))||0);
    return "FB-"+String(Math.max(2609,...nums)+1);
  };

  const saveNew = () => {
    if (!form.clientId || !form.amount) return;
    setFbInvoices(is=>[...is,{...form,id:nextId(),amount:+form.amount}]);
    setNewModal(false);
    setForm({ clientId:"", date:new Date().toISOString().slice(0,10), due:"", desc:"", amount:"", status:"draft" });
  };

  const updateStatus = (id, status) => setFbInvoices(is=>is.map(i=>i.id===id?{...i,status}:i));
  const del = (id) => setFbInvoices(is=>is.filter(i=>i.id!==id));

  const totalBilled    = fbInvoices.reduce((s,i)=>s+i.amount,0);
  const totalPaid      = fbInvoices.filter(i=>i.status==="paid").reduce((s,i)=>s+i.amount,0);
  const outstanding    = fbInvoices.filter(i=>i.status==="sent").reduce((s,i)=>s+i.amount,0);
  const totalDraft     = fbInvoices.filter(i=>i.status==="draft").reduce((s,i)=>s+i.amount,0);

  const filtered = filterStatus==="all" ? fbInvoices : fbInvoices.filter(i=>i.status===filterStatus);

  // Auto-generate from timesheet
  const genFromTimesheet = () => {
    const moIdx = 2; // March
    clients.forEach(c => {
      const cRoster = roster.filter(r => r.client === c.name || r.client.includes(c.name.split(" ")[0]));
      if (!cRoster.length) return;
      const moRev = cRoster.reduce((s,r)=>s+(tsHours[r.id]?.[moIdx]||0)*r.billRate,0);
      if (moRev > 0) {
        setFbInvoices(is=>[...is,{
          id:"FB-"+String(Math.max(2609,...is.map(i=>parseInt(i.id.replace("FB-",""))||0))+1),
          clientId:c.id, date:"2026-03-31", due:"2026-04-30", status:"draft",
          amount:moRev, desc:`${c.name} — Consulting Services March 2026 (timesheet)`
        }]);
      }
    });
  };

  // Export invoices to FreshBooks CSV format
  const exportFBCSV = () => {
    const rows = fbInvoices.map(inv => {
      const client = clients.find(c=>c.id===inv.clientId);
      const paid = inv.status==="paid" ? inv.amount : 0;
      return {
        "Invoice Number": inv.id,
        "Client Name": client?.name || "",
        "Invoice Date": inv.date,
        "Due Date": inv.due || inv.date,
        "PO Number": "",
        "Invoice Total": inv.amount,
        "Amount Paid": paid,
        "Balance Due": inv.amount - paid,
        "Currency": "USD",
        "Status": inv.status,
        "Notes": "",
        "Line Item - Description": inv.desc,
        "Line Item - Quantity": "1",
        "Line Item - Unit Cost": inv.amount,
        "Line Item - Amount": inv.amount
      };
    });
    downloadCSV("ziksatech_freshbooks_invoices.csv", rows, FB_HEADERS);
  };

  // Download blank FreshBooks template
  const downloadTemplate = () => downloadCSV("freshbooks_invoice_template.csv", FB_SAMPLE_ROWS, FB_HEADERS);

  // Parse FreshBooks CSV import
  const handleFBFile = text => {
    setImportError("");
    try {
      const rows = parseCSV(text);
      if (!rows.length) { setImportError("No data rows found."); return; }
      const required = ["Invoice Number","Client Name","Invoice Total","Status"];
      const missing = required.filter(k => !(k in rows[0]));
      if (missing.length) { setImportError(`Missing columns: ${missing.join(", ")}. Download sample to see expected format.`); return; }
      setImportPreview(rows);
    } catch(e) { setImportError("Could not parse CSV: " + e.message); }
  };

  const commitFBImport = () => {
    const mapped = importPreview.map(row => {
      // Try to match client by name
      const clientName = row["Client Name"] || "";
      const client = clients.find(c => c.name.toLowerCase() === clientName.toLowerCase()) ||
                     clients.find(c => clientName.toLowerCase().includes(c.name.toLowerCase().split(" ")[0]));
      const amount = parseFloat((row["Invoice Total"]||"0").replace(/[$,]/g,"")) || 0;
      const rawStatus = (row["Status"]||"draft").toLowerCase().trim();
      const status = ["draft","sent","paid","overdue"].includes(rawStatus) ? rawStatus : "draft";
      return {
        id: row["Invoice Number"] || "FB-" + uid(),
        clientId: client?.id || "",
        date: row["Invoice Date"] || new Date().toISOString().slice(0,10),
        due: row["Due Date"] || "",
        desc: row["Line Item - Description"] || row["Notes"] || "",
        amount,
        status,
        source: "imported"
      };
    }).filter(r => r.amount > 0);

    // Deduplicate by invoice ID
    setFbInvoices(existing => {
      const existingIds = new Set(existing.map(i=>i.id));
      const newOnes = mapped.filter(r => !existingIds.has(r.id));
      const updated = existing.map(e => { const imp = mapped.find(m=>m.id===e.id); return imp ? {...e, ...imp} : e; });
      return [...updated, ...newOnes];
    });
    setImportModal(false);
    setImportPreview([]);
  };

  const handleDrop = e => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const r = new FileReader(); r.onload = ev => handleFBFile(ev.target.result); r.readAsText(file);
  };

  return (
    <div>
      <PH title="FreshBooks Invoicing" sub="Import/export FreshBooks CSV · Full invoice lifecycle management">
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span className="fb-badge" style={{padding:"5px 12px",fontSize:12}}>FreshBooks</span>
          <button className="btn bg" style={{fontSize:12}} onClick={downloadTemplate}>↓ Template</button>
          <button className="btn bg" style={{fontSize:12}} onClick={exportFBCSV}>↑ Export CSV</button>
          <button className="btn bg" style={{fontSize:12}} onClick={()=>setImportModal(true)}>↓ Import CSV</button>
          <button className="btn bp" style={{fontSize:12}} onClick={()=>setNewModal(true)}><I d={ICONS.plus} s={13}/>New Invoice</button>
        </div>
      </PH>

      {/* How it works */}
      <div style={{display:"flex",gap:10,marginBottom:18,padding:"14px 18px",background:"#050e1c",border:"1px solid #1a2d45",borderRadius:10,alignItems:"flex-start"}}>
        <div style={{fontSize:18,marginTop:1}}>💡</div>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#7dd3fc",marginBottom:4}}>How to sync with FreshBooks (until live integration)</div>
          <div style={{fontSize:12,color:"#475569",lineHeight:1.7}}>
            <b style={{color:"#94a3b8"}}>Import:</b> FreshBooks → Invoices → ⋯ Export → CSV → Upload here to sync status (paid/sent/overdue)<br/>
            <b style={{color:"#94a3b8"}}>Export:</b> Click "↑ Export CSV" above → Import into FreshBooks → Invoices → Import
          </div>
          <div style={{fontSize:11,color:"#3d5a7a",marginTop:6}}>FreshBooks format: Invoice Number · Client Name · Invoice Date · Due Date · Invoice Total · Amount Paid · Balance Due · Status · Line Items</div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
        {[
          {l:"Total Invoiced",  v:fmt(totalBilled),  c:"#38bdf8"},
          {l:"Collected",       v:fmt(totalPaid),     c:"#34d399"},
          {l:"Outstanding",     v:fmt(outstanding),   c:"#f59e0b"},
          {l:"Draft",           v:fmt(totalDraft),    c:"#94a3b8"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 18px"}}><div className="th" style={{marginBottom:6}}>{k.l}</div><div className="mono" style={{fontSize:20,fontWeight:700,color:k.c}}>{k.v}</div></div>
        ))}
      </div>

      {/* Filter + actions bar */}
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        {["all","draft","sent","paid"].map(s=>(
          <button key={s} className="btn bg" style={{fontSize:12,padding:"6px 14px",borderColor:filterStatus===s?"#0284c7":"#1a2d45",color:filterStatus===s?"#38bdf8":"#475569"}}
            onClick={()=>setFilterStatus(s)}>
            {s.charAt(0).toUpperCase()+s.slice(1)} ({fbInvoices.filter(i=>s==="all"||i.status===s).length})
          </button>
        ))}
        <button className="btn bg" style={{fontSize:12,marginLeft:"auto"}} onClick={genFromTimesheet}>
          <I d={ICONS.ts} s={13}/>Generate from Timesheet
        </button>
        <button className="btn bg" style={{fontSize:12}} onClick={()=>setShowFormat(!showFormat)}>
          {showFormat?"Hide":"View"} CSV Format
        </button>
      </div>

      {showFormat && <ImportBanner format="FreshBooks Invoice Export" fields={FB_HEADERS} onClose={()=>setShowFormat(false)}/>}

      <div className="card">
        <div style={{padding:"10px 18px",background:"#020c1a",borderBottom:"1px solid #111d2d",display:"flex",alignItems:"center",gap:10}}>
          <span className="fb-badge">FreshBooks</span>
          <span style={{fontSize:11,color:"#3d5a7a"}}>billing@ziksatech.com · {filtered.length} invoices showing</span>
          <span style={{marginLeft:"auto",fontSize:11,color:"#3d5a7a"}}>Last export: today</span>
        </div>
        <div className="tr" style={{gridTemplateColumns:"110px 130px 1fr 100px 100px 80px 130px",padding:"8px 18px"}}>
          {["Invoice #","Client","Description","Amount","Date","Status","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {[...filtered].sort((a,b)=>b.date.localeCompare(a.date)).map(inv=>{
          const client = clients.find(c=>c.id===inv.clientId);
          return (
            <div key={inv.id} className="tr" style={{gridTemplateColumns:"110px 130px 1fr 100px 100px 80px 130px"}}>
              <div>
                <span className="mono" style={{fontSize:12,color:"#3d5a7a"}}>{inv.id}</span>
                {inv.source==="imported" && <div style={{fontSize:9,color:"#0284c7"}}>↓ from FB</div>}
              </div>
              <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{client?.name||<span style={{color:"#475569",fontStyle:"italic"}}>unmatched</span>}</span>
              <span style={{fontSize:11,color:"#475569",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{inv.desc}</span>
              <span className="mono" style={{fontSize:13,fontWeight:600,color:"#38bdf8"}}>{fmt(inv.amount)}</span>
              <span style={{fontSize:11,color:"#475569"}}>{fmtDate(inv.date)}</span>
              <span className="bdg" style={{background:statusBg[inv.status]||"#1e293b",color:statusColors[inv.status]||"#94a3b8"}}>{inv.status}</span>
              <div style={{display:"flex",gap:5}}>
                {inv.status==="draft" && <button className="btn bg" style={{padding:"3px 8px",fontSize:11}} onClick={()=>updateStatus(inv.id,"sent")}><I d={ICONS.send} s={11}/>Send</button>}
                {inv.status==="sent"  && <button className="btn bs" style={{padding:"3px 8px",fontSize:11}} onClick={()=>updateStatus(inv.id,"paid")}>✓ Paid</button>}
                <button className="btn br" style={{padding:"3px 7px"}} onClick={()=>del(inv.id)}><I d={ICONS.trash} s={11}/></button>
              </div>
            </div>
          );
        })}
        {filtered.length===0 && <div style={{padding:"32px",textAlign:"center",color:"#1e3a5f",fontSize:13}}>No invoices · Create one or import from FreshBooks CSV</div>}
      </div>

      {/* New Invoice Modal */}
      {newModal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setNewModal(false)}>
          <div className="modal">
            <MH title="New Invoice" onClose={()=>setNewModal(false)}><span className="fb-badge">FreshBooks</span></MH>
            <FF label="Client">
              <select className="inp" value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})}>
                <option value="">Select client…</option>
                {clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </FF>
            <FF label="Description"><input className="inp" value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder="AT&T Managed Services — April 2026"/></FF>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Amount ($)"><input className="inp" type="number" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} placeholder="100000"/></FF>
              <FF label="Invoice Date"><input className="inp" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></FF>
              <FF label="Due Date"><input className="inp" type="date" value={form.due} onChange={e=>setForm({...form,due:e.target.value})}/></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="draft">Draft</option><option value="sent">Send Now</option></select></FF>
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:18}}>
              <button className="btn bg" onClick={()=>setNewModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveNew}><I d={ICONS.fb} s={13}/>Create Invoice</button>
            </div>
          </div>
        </div>
      )}

      {/* FreshBooks Import Modal */}
      {importModal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setImportModal(false)}>
          <div className="modal" style={{maxWidth:700}}>
            <MH title="Import FreshBooks CSV" onClose={()=>{setImportModal(false);setImportPreview([]);setImportError("");}}>
              <span className="fb-badge">FreshBooks</span>
            </MH>

            <div style={{background:"#030810",border:"1px solid #1a2d45",borderRadius:9,padding:"12px 16px",marginBottom:16,fontSize:12,color:"#475569",lineHeight:1.7}}>
              <b style={{color:"#7dd3fc"}}>Where to get this file:</b> FreshBooks → Invoices → top-right menu (⋯) → <b style={{color:"#94a3b8"}}>Export Invoices</b> → CSV<br/>
              <b style={{color:"#7dd3fc"}}>What it does:</b> Syncs invoice statuses (paid/sent/overdue) from FreshBooks into your Ops Center. Duplicate invoice numbers are updated, not duplicated.
            </div>

            {importError && (
              <div style={{background:"#1a0808",border:"1px solid #3d1010",borderRadius:8,padding:"10px 14px",marginBottom:14,color:"#f87171",fontSize:12}}>
                ⚠ {importError}
              </div>
            )}

            {importPreview.length === 0 ? (
              <div
                onDragOver={e=>{e.preventDefault();setDragOver(true)}}
                onDragLeave={()=>setDragOver(false)}
                onDrop={handleDrop}
                style={{border:`2px dashed ${dragOver?"#0075dd":"#1a2d45"}`,borderRadius:12,padding:"40px 20px",textAlign:"center",transition:"border 0.2s",cursor:"pointer",background:dragOver?"#020a1a":"transparent"}}
              >
                <div style={{fontSize:32,marginBottom:10}}>📄</div>
                <div style={{fontSize:14,fontWeight:600,color:"#7dd3fc",marginBottom:6}}>Drop your FreshBooks CSV here</div>
                <div style={{fontSize:12,color:"#3d5a7a",marginBottom:16}}>or click to browse · .csv files only</div>
                <button className="btn bp" onClick={()=>{ const inp=document.createElement("input"); inp.type="file"; inp.accept=".csv,.txt"; inp.onchange=e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>handleFBFile(ev.target.result); r.readAsText(f); }; inp.click(); }}>Browse File</button>
              </div>
            ) : (
              <div>
                <div style={{fontSize:12,color:"#34d399",fontWeight:600,marginBottom:10}}>
                  ✓ Parsed {importPreview.length} invoice rows
                </div>
                <div style={{overflowX:"auto",maxHeight:260,overflowY:"auto",marginBottom:16}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead>
                      <tr style={{borderBottom:"1px solid #1a2d45",background:"#050e1c",position:"sticky",top:0}}>
                        {["Invoice Number","Client Name","Invoice Date","Invoice Total","Amount Paid","Status"].map(h=>(
                          <th key={h} className="th" style={{padding:"7px 10px",textAlign:"left"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.map((row,i)=>(
                        <tr key={i} style={{borderBottom:"1px solid #0a1626"}}>
                          {["Invoice Number","Client Name","Invoice Date","Invoice Total","Amount Paid","Status"].map(h=>(
                            <td key={h} className="mono" style={{padding:"6px 10px",
                              color:h==="Invoice Total"?"#38bdf8":h==="Amount Paid"?"#34d399":h==="Status"?statusColors[(row[h]||"").toLowerCase()]||"#94a3b8":"#94a3b8"
                            }}>{row[h]||"—"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button className="btn bg" onClick={()=>{setImportPreview([]);setImportError("");}}>Re-upload</button>
                  <button className="btn bp" onClick={commitFBImport}><I d={ICONS.check} s={13}/>Import {importPreview.length} Invoices</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* GL Export tab */}
      {!newModal&&!importModal&&(
        <div>
          {/* Tab switcher for GL */}
          <div style={{display:"flex",gap:4,marginBottom:16,background:"#060d1c",borderRadius:8,padding:3,border:"1px solid #1a2d45",width:"fit-content"}}>
            {[["invoices","Invoices"],["gl","GL Export"]].map(([v,l])=>(
              <button key={v} onClick={()=>setFilterStatus(v==="gl"?"gl":filterStatus==="gl"?"all":filterStatus)}
                style={{padding:"5px 14px",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,
                  background:(v==="gl"&&filterStatus==="gl")||(v==="invoices"&&filterStatus!=="gl")?"#0369a1":"transparent",
                  color:(v==="gl"&&filterStatus==="gl")||(v==="invoices"&&filterStatus!=="gl")?"#fff":"#475569"}}>
                {l}
              </button>
            ))}
          </div>
          {filterStatus==="gl"&&<FreshBooksGL fbInvoices={fbInvoices} clients={clients}/>}
        </div>
      )}
    </div>
  );
}

// ─── FRESHBOOKS GL EXPORT ─────────────────────────────────────────────────────
// GL account codes used by Ziksatech
const GL_ACCOUNTS = [
  { code:"4000", name:"Consulting Revenue — AT&T",         type:"Revenue",  keywords:["att","at&t"] },
  { code:"4010", name:"Consulting Revenue — Naxon",        type:"Revenue",  keywords:["naxon"] },
  { code:"4020", name:"Consulting Revenue — Other Clients",type:"Revenue",  keywords:[] },
  { code:"5000", name:"Cost of Services — FTE Salaries",   type:"COGS",     keywords:["salary","payroll"] },
  { code:"5010", name:"Cost of Services — Contractor Pay", type:"COGS",     keywords:["contractor","1099"] },
  { code:"6000", name:"Accounts Receivable",               type:"Asset",    keywords:[] },
  { code:"6010", name:"Cash & Checking",                   type:"Asset",    keywords:["payment","deposit"] },
  { code:"7000", name:"Office & Admin Expenses",           type:"Expense",  keywords:["office","admin"] },
  { code:"7010", name:"Travel & Meals",                    type:"Expense",  keywords:["travel","meal"] },
  { code:"7020", name:"Software & Subscriptions",          type:"Expense",  keywords:["software","subscription","saas"] },
  { code:"7030", name:"Professional Fees",                 type:"Expense",  keywords:["legal","accounting","cpa"] },
];

function guessGLCode(inv, clients) {
  const client = clients.find(c=>c.id===inv.clientId);
  const name = (client?.name||"").toLowerCase();
  const desc = (inv.desc||"").toLowerCase();
  for (const acc of GL_ACCOUNTS) {
    if (acc.type==="Revenue" && acc.keywords.some(k=>name.includes(k)||desc.includes(k))) return acc.code;
  }
  return "4020"; // default Other Revenue
}

function FreshBooksGL({ fbInvoices, clients }) {
  const [period, setPeriod]     = useState("2026-03");
  const [glMap,  setGlMap]      = useState({});
  const [selInv, setSelInv]     = useState(null);

  const periods = ["2025-12","2026-01","2026-02","2026-03"];

  const periodInvoices = fbInvoices.filter(inv => {
    const d = inv.date||"";
    return d.startsWith(period);
  });

  // Build journal entries for each invoice
  const journalEntries = periodInvoices.map(inv => {
    const gl = glMap[inv.id] || guessGLCode(inv, clients);
    const glAcc = GL_ACCOUNTS.find(a=>a.code===gl)||GL_ACCOUNTS[0];
    const client = clients.find(c=>c.id===inv.clientId);
    const paid = inv.status==="paid";
    return {
      inv,
      client,
      glAcc,
      gl,
      // DR Accounts Receivable / CR Revenue on invoice
      drAccount: paid ? "6010" : "6000",
      crAccount: gl,
      drName: paid ? "Cash & Checking" : "Accounts Receivable",
      crName: glAcc.name,
      amount: inv.amount,
      memo: `${inv.id} — ${client?.name||"Unknown"} — ${inv.desc||"Consulting Services"}`,
      postDate: inv.date,
    };
  });

  const totalDebit  = journalEntries.reduce((s,e)=>s+e.amount,0);
  const totalCredit = journalEntries.reduce((s,e)=>s+e.amount,0);

  const exportGLCSV = () => {
    const headers = ["Date","Reference","Memo","Account Code","Account Name","Type","Debit","Credit"];
    const rows = journalEntries.flatMap(e => [
      // Debit entry
      { "Date":e.postDate, "Reference":e.inv.id, "Memo":e.memo, "Account Code":e.drAccount, "Account Name":e.drName, "Type":"DR", "Debit":e.amount.toFixed(2), "Credit":"" },
      // Credit entry
      { "Date":e.postDate, "Reference":e.inv.id, "Memo":e.memo, "Account Code":e.crAccount, "Account Name":e.crName, "Type":"CR", "Debit":"", "Credit":e.amount.toFixed(2) },
    ]);
    downloadCSV(`ziksatech_gl_${period}.csv`, rows, headers);
  };

  const exportTBCSV = () => {
    const byCode = {};
    for (const e of journalEntries) {
      if (!byCode[e.drAccount]) byCode[e.drAccount]={ code:e.drAccount, name:e.drName, debits:0, credits:0 };
      byCode[e.drAccount].debits += e.amount;
      if (!byCode[e.crAccount]) byCode[e.crAccount]={ code:e.crAccount, name:e.crName, debits:0, credits:0 };
      byCode[e.crAccount].credits += e.amount;
    }
    const rows = Object.values(byCode).map(r=>({
      "Account Code":r.code, "Account Name":r.name,
      "Total Debits":r.debits.toFixed(2), "Total Credits":r.credits.toFixed(2),
      "Net Balance":(r.debits-r.credits).toFixed(2)
    }));
    downloadCSV(`ziksatech_trial_balance_${period}.csv`, rows, ["Account Code","Account Name","Total Debits","Total Credits","Net Balance"]);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:0}}>
      {/* Header controls */}
      <div style={{display:"flex",gap:12,marginBottom:18,flexWrap:"wrap",alignItems:"center"}}>
        <div>
          <div className="lbl" style={{marginBottom:4}}>Period</div>
          <div style={{display:"flex",gap:4}}>
            {periods.map(p=>(
              <button key={p} className="btn bg" style={{fontSize:11,borderColor:period===p?"#0284c7":"#1a2d45",color:period===p?"#38bdf8":"#475569"}}
                onClick={()=>setPeriod(p)}>{p}</button>
            ))}
          </div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button className="btn bg" style={{fontSize:11}} onClick={exportTBCSV}>⬇ Trial Balance CSV</button>
          <button className="btn bp" style={{fontSize:11}} onClick={exportGLCSV}>⬇ Journal Entries CSV</button>
        </div>
      </div>

      {/* Summary KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16}}>
        {[
          { l:"Invoices in Period",  v:periodInvoices.length,   c:"#38bdf8" },
          { l:"Total to Post",       v:fmt(totalDebit),          c:"#a78bfa" },
          { l:"Revenue Accounts",    v:journalEntries.filter(e=>GL_ACCOUNTS.find(a=>a.code===e.crAccount)?.type==="Revenue").length, c:"#34d399" },
          { l:"Paid / AR",           v:`${periodInvoices.filter(i=>i.status==="paid").length} / ${periodInvoices.filter(i=>i.status!=="paid").length}`, c:"#f59e0b" },
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"10px 14px",textAlign:"center"}}>
            <div style={{fontSize:18,fontWeight:800,color:k.c,fontFamily:"monospace"}}>{k.v}</div>
            <div style={{fontSize:10,color:"#475569",marginTop:2}}>{k.l}</div>
          </div>
        ))}
      </div>

      {/* GL Mapping controls */}
      <div className="card" style={{padding:"16px 18px",marginBottom:14}}>
        <div className="section-hdr">GL Account Mapping</div>
        <div style={{fontSize:11,color:"#3d5a7a",marginBottom:10}}>Auto-mapped based on client name. Override any invoice below.</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {GL_ACCOUNTS.filter(a=>a.type==="Revenue").map(a=>(
            <div key={a.code} style={{padding:"5px 10px",borderRadius:6,background:"#070c18",border:"1px solid #1a2d45",fontSize:10}}>
              <span style={{color:"#38bdf8",fontFamily:"monospace"}}>{a.code}</span>
              <span style={{color:"#475569",marginLeft:6}}>{a.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Journal entry table */}
      <div className="card">
        <div style={{padding:"10px 18px",background:"#060d1c",borderBottom:"2px solid #1a2d45",display:"grid",gridTemplateColumns:"80px 70px 1fr 100px 130px 90px 80px",gap:8}}>
          {["Date","Invoice","Memo","DR Account","CR Account","Amount","GL Code"].map(h=><span key={h} className="th" style={{fontSize:10}}>{h}</span>)}
        </div>
        {journalEntries.length===0&&(
          <div style={{padding:"24px",textAlign:"center",fontSize:12,color:"#1e3a5f"}}>No invoices in {period}. Select a different period.</div>
        )}
        {journalEntries.map((e,i)=>{
          const isSel = selInv===e.inv.id;
          return (
            <div key={i}>
              <div onClick={()=>setSelInv(isSel?null:e.inv.id)}
                style={{display:"grid",gridTemplateColumns:"80px 70px 1fr 100px 130px 90px 80px",gap:8,padding:"9px 18px",
                  borderBottom:"1px solid #070b14",cursor:"pointer",background:isSel?"#0a1a2e":i%2===0?"transparent":"#06090f"}}>
                <span style={{fontSize:11,color:"#475569",fontFamily:"monospace"}}>{e.postDate?.slice(5)||""}</span>
                <span style={{fontSize:11,color:"#38bdf8",fontFamily:"monospace"}}>{e.inv.id}</span>
                <span style={{fontSize:11,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.client?.name||"—"}</span>
                <div style={{fontSize:10}}>
                  <div style={{color:"#34d399"}}>DR {e.drAccount}</div>
                  <div style={{color:"#1e3a5f",fontSize:9}}>{e.drName.slice(0,18)}</div>
                </div>
                <div style={{fontSize:10}}>
                  <div style={{color:"#a78bfa"}}>CR {e.crAccount}</div>
                  <div style={{color:"#1e3a5f",fontSize:9}}>{e.crName.slice(0,18)}</div>
                </div>
                <span style={{fontSize:12,fontFamily:"monospace",fontWeight:700,color:"#38bdf8"}}>{fmt(e.amount)}</span>
                {/* GL override select */}
                <select className="inp" style={{fontSize:10,padding:"2px 4px"}}
                  value={glMap[e.inv.id]||guessGLCode(e.inv,clients)}
                  onChange={ev=>{ev.stopPropagation();setGlMap(m=>({...m,[e.inv.id]:ev.target.value}));}}
                  onClick={ev=>ev.stopPropagation()}>
                  {GL_ACCOUNTS.filter(a=>a.type==="Revenue").map(a=>(
                    <option key={a.code} value={a.code}>{a.code}</option>
                  ))}
                </select>
              </div>
              {isSel&&(
                <div style={{padding:"10px 18px 14px",background:"#070c18",borderBottom:"2px solid #0369a1",fontSize:11}}>
                  <div style={{color:"#3d5a7a",marginBottom:6,fontWeight:600}}>Journal Entry Detail</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div style={{background:"#060d1c",borderRadius:8,padding:"10px 12px",border:"1px solid #1a2d45"}}>
                      <div style={{color:"#34d399",fontWeight:700,marginBottom:4}}>DEBIT</div>
                      <div style={{color:"#e2e8f0"}}>{e.drAccount} — {e.drName}</div>
                      <div style={{color:"#38bdf8",fontFamily:"monospace",fontSize:14,fontWeight:800,marginTop:4}}>{fmt(e.amount)}</div>
                    </div>
                    <div style={{background:"#060d1c",borderRadius:8,padding:"10px 12px",border:"1px solid #1a2d45"}}>
                      <div style={{color:"#a78bfa",fontWeight:700,marginBottom:4}}>CREDIT</div>
                      <div style={{color:"#e2e8f0"}}>{e.crAccount} — {e.crName}</div>
                      <div style={{color:"#38bdf8",fontFamily:"monospace",fontSize:14,fontWeight:800,marginTop:4}}>{fmt(e.amount)}</div>
                    </div>
                  </div>
                  <div style={{marginTop:8,color:"#3d5a7a",fontSize:10}}>Memo: {e.memo}</div>
                </div>
              )}
            </div>
          );
        })}
        {/* Trial balance footer */}
        {journalEntries.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"80px 70px 1fr 100px 130px 90px 80px",gap:8,padding:"10px 18px",background:"#060d1c",borderTop:"3px solid #0369a1"}}>
            <span style={{fontSize:11,fontWeight:800,color:"#e2e8f0",gridColumn:"1/5"}}>PERIOD TOTAL</span>
            <span/>
            <span style={{fontSize:13,fontFamily:"monospace",fontWeight:800,color:"#38bdf8"}}>{fmt(totalDebit)}</span>
            <span/>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SHARED UI ────────────────────────────────────────────────────────────────
function PH({ title, sub, children }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24}}>
      <div>
        <h1 style={{fontSize:24,fontWeight:800,color:"#e2e8f0",letterSpacing:"-0.03em"}}>{title}</h1>
        {sub && <p style={{fontSize:12,color:"#3d5a7a",marginTop:3}}>{sub}</p>}
      </div>
      {children && <div style={{display:"flex",alignItems:"center",gap:8}}>{children}</div>}
    </div>
  );
}
function MH({ title, onClose, children }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <h2 style={{fontSize:17,fontWeight:700,color:"#e2e8f0"}}>{title}</h2>
        {children}
      </div>
      <button className="btn bg" style={{padding:"5px 8px"}} onClick={onClose}><I d={ICONS.x} s={14}/></button>
    </div>
  );
}
function FF({ label, children }) {
  return (
    <div style={{marginBottom:13}}>
      <label className="lbl">{label}</label>
      {children}
    </div>
  );
}

// ─── FINANCE MODULE ────────────────────────────────────────────────────────────
function FinanceModule({ roster, clients, tsHours, finInvoices, setFinInvoices, finPayments, setFinPayments, finExpenses, setFinExpenses, addAudit }) {
  const [sub, setSub] = useState("overview");
  const subTabs = [
    { id:"overview",   label:"Overview" },
    { id:"invoices",   label:"Invoices" },
    { id:"payments",   label:"Payments" },
    { id:"aging",      label:"A/R Aging" },
    { id:"expenses",   label:"Expenses" },
    { id:"waterfall",  label:"Margin Waterfall" },
  ];

  const props = { roster, clients, tsHours, finInvoices, setFinInvoices, finPayments, setFinPayments, finExpenses, setFinExpenses, addAudit };

  return (
    <div>
      <PH title="Finance" sub="Phase 2 — Invoices · Payments · A/R Aging · Expenses · Margin Waterfall"/>

      {/* Sub-nav */}
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {subTabs.map(t => (
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 16px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>

      {sub==="overview"  && <FinOverview  {...props}/>}
      {sub==="invoices"  && <FinInvoices  {...props}/>}
      {sub==="payments"  && <FinPayments  {...props}/>}
      {sub==="aging"     && <FinAging     {...props}/>}
      {sub==="expenses"  && <FinExpenses  {...props}/>}
      {sub==="waterfall" && <FinWaterfall {...props}/>}
    </div>
  );
}

// ── Finance helpers ────────────────────────────────────────────────────────────
const invTotal     = inv => inv.lines.reduce((s,l)=>s+l.amount,0);
const invPaid      = (inv, payments) => payments.filter(p=>p.invoiceId===inv.id).reduce((s,p)=>s+p.amount,0);
const invBalance   = (inv, payments) => invTotal(inv) - invPaid(inv, payments);
const daysOverdue  = (inv) => {
  const due = new Date(inv.dueDate); const today = new Date();
  return Math.max(0, Math.floor((today - due) / 86400000));
};
const agingBucket  = (inv) => {
  const d = daysOverdue(inv);
  if (d === 0) return "current";
  if (d <= 30)  return "0-30";
  if (d <= 60)  return "31-60";
  if (d <= 90)  return "61-90";
  return "90+";
};

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
function FinOverview({ roster, clients, finInvoices, finPayments, finExpenses }) {
  const totalBilled    = finInvoices.reduce((s,i)=>s+invTotal(i),0);
  const totalCollected = finPayments.reduce((s,p)=>s+p.amount,0);
  const outstanding    = finInvoices.filter(i=>["sent","overdue"].includes(i.status)).reduce((s,i)=>s+invBalance(i,finPayments),0);
  const overdue        = finInvoices.filter(i=>i.status==="overdue").reduce((s,i)=>s+invBalance(i,finPayments),0);
  const totalExpenses  = finExpenses.filter(e=>e.status==="approved").reduce((s,e)=>s+e.amount,0);
  const pendingExp     = finExpenses.filter(e=>e.status==="pending").reduce((s,e)=>s+e.amount,0);

  // Monthly revenue from invoices (by issue date month)
  const monthlyRev = Array(12).fill(0);
  const monthlyCol = Array(12).fill(0);
  finInvoices.forEach(inv => {
    const mo = new Date(inv.issueDate).getMonth();
    monthlyRev[mo] += invTotal(inv);
  });
  finPayments.forEach(p => {
    const mo = new Date(p.date).getMonth();
    monthlyCol[mo] += p.amount;
  });

  // Gross margin from roster
  const rData = roster.map(r => ({ ...r, ...calcRoster(r) }));
  const annualRev   = rData.reduce((s,r)=>s+r.rev,0);
  const annualCost  = rData.reduce((s,r)=>s+r.totalCost,0);
  const grossMargin = annualRev > 0 ? (annualRev - annualCost) / annualRev : 0;

  // Recent activity
  const recentPays = [...finPayments].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,4);

  return (
    <div>
      {/* KPI row 1 */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:12}}>
        {[
          {l:"Total Billed (YTD)",    v:fmt(totalBilled),    c:"#38bdf8", sub:`${finInvoices.length} invoices`},
          {l:"Collected (YTD)",       v:fmt(totalCollected), c:"#34d399", sub:`${finPayments.length} payments`},
          {l:"Outstanding A/R",       v:fmt(outstanding),    c:"#f59e0b", sub:"sent + overdue"},
          {l:"Overdue",               v:fmt(overdue),        c:"#f87171", sub:`${finInvoices.filter(i=>i.status==="overdue").length} invoices`},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 18px"}}>
            <div className="th" style={{marginBottom:6}}>{k.l}</div>
            <div className="mono" style={{fontSize:22,fontWeight:700,color:k.c}}>{k.v}</div>
            <div style={{fontSize:11,color:"#3d5a7a",marginTop:4}}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* KPI row 2 */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
        {[
          {l:"Gross Margin %",         v:pct(grossMargin),                            c:"#a78bfa", sub:"bill − cost / bill"},
          {l:"Expenses (Approved)",    v:fmt(totalExpenses),                           c:"#f87171", sub:`${finExpenses.filter(e=>e.status==="approved").length} claims`},
          {l:"Expenses Pending",       v:fmt(pendingExp),                              c:"#f59e0b", sub:`${finExpenses.filter(e=>e.status==="pending").length} awaiting approval`},
          {l:"Collection Rate",        v:totalBilled>0?pct(totalCollected/totalBilled):"—", c:"#34d399", sub:"paid / invoiced"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 18px"}}>
            <div className="th" style={{marginBottom:6}}>{k.l}</div>
            <div className="mono" style={{fontSize:22,fontWeight:700,color:k.c}}>{k.v}</div>
            <div style={{fontSize:11,color:"#3d5a7a",marginTop:4}}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Monthly revenue chart (bar-like) */}
      <div className="card" style={{marginBottom:18,padding:"18px 18px 14px"}}>
        <div className="section-hdr" style={{padding:"0 0 14px",border:"none"}}>Monthly Revenue vs Collections — 2026</div>
        <div style={{display:"flex",alignItems:"flex-end",gap:6,height:120}}>
          {MONTHS.map((mo,i)=>{
            const rev = monthlyRev[i]; const col = monthlyCol[i];
            const maxVal = Math.max(...monthlyRev, 1);
            return (
              <div key={mo} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                <div style={{width:"100%",display:"flex",gap:2,alignItems:"flex-end",height:90}}>
                  <div style={{flex:1,background:"#0369a1",borderRadius:"3px 3px 0 0",height:`${Math.max(2,(rev/maxVal)*90)}px`,opacity:0.9}} title={`Billed: ${fmt(rev)}`}/>
                  <div style={{flex:1,background:"#34d399",borderRadius:"3px 3px 0 0",height:`${Math.max(2,(col/maxVal)*90)}px`,opacity:0.9}} title={`Collected: ${fmt(col)}`}/>
                </div>
                <div style={{fontSize:9,color:"#3d5a7a"}}>{mo}</div>
              </div>
            );
          })}
        </div>
        <div style={{display:"flex",gap:16,marginTop:10,justifyContent:"flex-end"}}>
          <div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:12,height:10,background:"#0369a1",borderRadius:2}}/><span style={{fontSize:11,color:"#64748b"}}>Billed</span></div>
          <div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:12,height:10,background:"#34d399",borderRadius:2}}/><span style={{fontSize:11,color:"#64748b"}}>Collected</span></div>
        </div>
      </div>

      {/* Recent payments + invoice status split */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div className="card">
          <div className="section-hdr">Recent Payments</div>
          {recentPays.length === 0 && <div style={{padding:"20px",textAlign:"center",color:"#1e3a5f",fontSize:13}}>No payments yet</div>}
          {recentPays.map(p=>{
            const inv = finInvoices.find(i=>i.id===p.invoiceId);
            const cl  = clients.find(c=>c.id===p.clientId);
            return (
              <div key={p.id} className="tr" style={{gridTemplateColumns:"1fr 90px 70px"}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cl?.name||"—"}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{inv?.id} · {fmtDate(p.date)} · {p.method}</div>
                </div>
                <span className="mono" style={{fontSize:13,fontWeight:600,color:"#34d399"}}>{fmt(p.amount)}</span>
                <span className="bdg" style={{background:"#021f14",color:"#34d399"}}>paid</span>
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="section-hdr">Invoice Status Breakdown</div>
          {[
            {s:"paid",    label:"Paid",    c:"#34d399", bg:"#021f14"},
            {s:"sent",    label:"Sent / Outstanding", c:"#f59e0b", bg:"#1a1005"},
            {s:"overdue", label:"Overdue", c:"#f87171", bg:"#1a0808"},
            {s:"draft",   label:"Draft",   c:"#64748b", bg:"#0a1626"},
          ].map(({s,label,c,bg})=>{
            const invs = finInvoices.filter(i=>i.status===s);
            const total = invs.reduce((sum,i)=>sum+invTotal(i),0);
            return (
              <div key={s} className="tr" style={{gridTemplateColumns:"1fr 80px 80px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="bdg" style={{background:bg,color:c}}>{label}</span>
                </div>
                <span style={{fontSize:12,color:"#64748b",textAlign:"right"}}>{invs.length} inv</span>
                <span className="mono" style={{fontSize:13,fontWeight:600,color:c,textAlign:"right"}}>{fmt(total)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── INVOICES ──────────────────────────────────────────────────────────────────
function FinInvoices({ clients, finInvoices, setFinInvoices, finPayments, setFinPayments, addAudit }) {
  const [filter, setFilter]   = useState("all");
  const [selected, setSelected] = useState(null);
  const [newModal, setNewModal] = useState(false);
  const [payModal, setPayModal] = useState(null); // invoiceId being paid
  const [payForm, setPayForm]   = useState({ amount:"", date: new Date().toISOString().slice(0,10), method:"ACH", ref:"", notes:"" });
  const [selAR, setSelAR]       = useState(new Set());

  const toggleAR = (id) => setSelAR(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const bulkSendAR = () => {
    if (!selAR.size) return;
    const sendable = finInvoices.filter(i => selAR.has(i.id) && i.status==="draft");
    if (!sendable.length) { alert("Select draft invoices to mark as sent."); return; }
    setFinInvoices(is => is.map(i => selAR.has(i.id) && i.status==="draft" ? {...i,status:"sent"} : i));
    addAudit && addAudit("Finance","Bulk Send AR","Finance",`Marked ${sendable.length} invoices as sent`);
    setSelAR(new Set());
  };
  const bulkDeleteAR = () => {
    if (!selAR.size) return;
    const deletable = finInvoices.filter(i => selAR.has(i.id) && i.status==="draft");
    if (!deletable.length) { alert("Only draft invoices can be deleted."); return; }
    if (!window.confirm(`Delete ${deletable.length} draft invoice(s)?`)) return;
    const ids = new Set(deletable.map(i=>i.id));
    setFinInvoices(is => is.filter(i => !ids.has(i.id)));
    addAudit && addAudit("Finance","Bulk Delete AR","Finance",`Deleted ${deletable.length} draft invoices`);
    setSelAR(new Set());
  };

  const newInvForm = () => ({
    id:"INV-"+String(finInvoices.length+9).padStart(3,"0"),
    clientId:"", projectName:"", period:"", issueDate:new Date().toISOString().slice(0,10),
    dueDate:"", status:"draft", paymentTerms:"Net 30", lines:[], notes:""
  });
  const [form, setForm] = useState(newInvForm());

  const filtered = filter==="all" ? finInvoices : finInvoices.filter(i=>i.status===filter);
  const selInv   = finInvoices.find(i=>i.id===selected);

  const updateStatus = (id, status) => setFinInvoices(is=>is.map(i=>i.id===id?{...i,status}:i));
  const addLine = () => setForm(f=>({...f,lines:[...f.lines,{id:"l"+uid(),desc:"",qty:1,rate:0,amount:0}]}));
  const updateLine = (idx,field,val) => setForm(f=>({...f,lines:f.lines.map((l,i)=>i===idx?{...l,[field]:+val||val,amount:field==="qty"?(+val)*(l.rate):(l.qty)*(+val||0)}:l)}));
  const removeLine = (idx) => setForm(f=>({...f,lines:f.lines.filter((_,i)=>i!==idx)}));

  const saveInvoice = () => {
    setFinInvoices(is=>[...is,{...form}]);
    addAudit&&addAudit("Finance","New AR Invoice","Finance",`Created invoice ${form.number||""}`,{amount:form.lines?.reduce((s,l)=>s+l.amount,0)||0});
    setNewModal(false); setForm(newInvForm());
  };

  const recordPayment = () => {
    if(!payForm.amount||!payModal) return;
    const inv = finInvoices.find(i=>i.id===payModal);
    const newPay = { id:"pay"+uid(), invoiceId:payModal, clientId:inv.clientId, ...payForm, amount:+payForm.amount };
    setFinPayments(ps=>[...ps,newPay]);
    // Auto-mark as paid if fully paid
    const alreadyPaid = invPaid(inv,finPayments);
    const totalAmt = invTotal(inv);
    if(alreadyPaid + +payForm.amount >= totalAmt) updateStatus(payModal,"paid");
    setPayModal(null);
    setPayForm({ amount:"", date:new Date().toISOString().slice(0,10), method:"ACH", ref:"", notes:"" });
  };

  const [copiedId, setCopiedId] = useState(null);
  const copyPortalLink = (invId) => {
    const url = `${window.location.origin}${window.location.pathname}?portal=invoice&id=${invId}`;
    navigator.clipboard.writeText(url).catch(()=>{});
    setCopiedId(invId);
    setTimeout(()=>setCopiedId(null), 2000);
    addAudit&&addAudit("Finance","Invoice Link Copied","Finance",`Portal link copied for invoice ${invId}`);
  };

  const statusColor = {paid:"#34d399",sent:"#f59e0b",overdue:"#f87171",draft:"#64748b"};
  const statusBg2   = {paid:"#021f14",sent:"#1a1005",overdue:"#1a0808",draft:"#0a1626"};

  return (
    <div style={{display:"grid",gridTemplateColumns:selInv?"1fr 380px":"1fr",gap:16}}>
      <div>
        {/* Toolbar */}
        <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
          {["all","draft","sent","overdue","paid"].map(s=>(
            <button key={s} className="btn bg" style={{fontSize:12,padding:"6px 14px",borderColor:filter===s?"#0284c7":"#1a2d45",color:filter===s?"#38bdf8":"#475569"}}
              onClick={()=>setFilter(s)}>
              {s.charAt(0).toUpperCase()+s.slice(1)} ({finInvoices.filter(i=>s==="all"||i.status===s).length})
            </button>
          ))}
          <div style={{display:"flex",gap:6,marginLeft:"auto",alignItems:"center"}}>
            {selAR.size>0&&(<>
              <button className="btn bg" style={{fontSize:11}} onClick={bulkSendAR}>📤 Send {selAR.size}</button>
              <button className="btn br" style={{fontSize:11}} onClick={bulkDeleteAR}>🗑 Delete {selAR.size}</button>
            </>)}
            <button className="btn bp" style={{fontSize:12}} onClick={()=>setNewModal(true)}><I d={ICONS.plus} s={13}/>New Invoice</button>
          </div>
        </div>

        <div className="card" style={{overflowX:"auto"}}>
          <div className="tr" style={{gridTemplateColumns:"28px 110px 1fr 120px 110px 90px 90px 100px 100px",padding:"8px 18px",minWidth:900}}>
            <input type="checkbox" checked={selAR.size===filtered.length&&filtered.length>0} onChange={()=>setSelAR(s=>s.size===filtered.length?new Set():new Set(filtered.map(i=>i.id)))} style={{accentColor:"#0369a1",cursor:"pointer"}}/>
            {["Invoice","Client / Project","Period","Issue Date","Total","Balance","Status","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(inv=>{
            const cl   = clients.find(c=>c.id===inv.clientId);
            const tot  = invTotal(inv);
            const bal  = invBalance(inv,finPayments);
            const od   = daysOverdue(inv);
            return (
              <div key={inv.id} className="tr"
                style={{gridTemplateColumns:"28px 110px 1fr 120px 110px 90px 90px 100px 100px",minWidth:900,cursor:"pointer",background:selAR.has(inv.id)?"#0a1a2e":selected===inv.id?"#061526":undefined}}
                onClick={()=>setSelected(selected===inv.id?null:inv.id)}>
                <input type="checkbox" checked={selAR.has(inv.id)} onChange={()=>toggleAR(inv.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"#0369a1",cursor:"pointer"}}/>
                <span className="mono" style={{fontSize:11,color:"#3d5a7a"}}>{inv.id}</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cl?.name||"—"}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{inv.projectName}</div>
                </div>
                <span style={{fontSize:11,color:"#64748b"}}>{inv.period}</span>
                <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(inv.issueDate)}</span>
                <span className="mono" style={{fontSize:12,fontWeight:600,color:"#38bdf8"}}>{fmt(tot)}</span>
                <span className="mono" style={{fontSize:12,color:bal>0?"#f87171":"#34d399"}}>{bal>0?fmt(bal):"✓ Paid"}</span>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span className="bdg" style={{background:statusBg2[inv.status]||"#0a1626",color:statusColor[inv.status]||"#94a3b8"}}>{inv.status}</span>
                  {od>0&&inv.status!=="paid"&&<span style={{fontSize:9,color:"#f87171"}}>+{od}d</span>}
                </div>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  {inv.status==="draft" && <button className="btn bg" style={{padding:"3px 7px",fontSize:11}} onClick={()=>updateStatus(inv.id,"sent")}>Send</button>}
                  {["sent","overdue","partial"].includes(inv.status) && bal>0 &&
                    <button className="btn bs" style={{padding:"3px 7px",fontSize:11}} onClick={()=>setPayModal(inv.id)}>+ Record Payment</button>}
                  {inv.status==="paid" &&
                    <button className="btn bg" style={{padding:"3px 7px",fontSize:11}} onClick={()=>setPayModal(inv.id)}>View Payments</button>}
                  {inv.status==="sent" && daysOverdue(inv)>0 &&
                    <button className="btn br" style={{padding:"3px 6px",fontSize:10}} onClick={()=>updateStatus(inv.id,"overdue")}>Flag</button>}
                  {["sent","overdue","partial"].includes(inv.status)&&(
                    <button className="btn bg" style={{padding:"3px 7px",fontSize:10,color:copiedId===inv.id?"#34d399":"#7dd3fc"}}
                      onClick={e=>{e.stopPropagation();copyPortalLink(inv.id);}}>
                      {copiedId===inv.id?"✓ Copied":"⛓ Link"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length===0&&<div style={{padding:"32px",textAlign:"center",color:"#1e3a5f",fontSize:13}}>No invoices in this filter</div>}
        </div>
      </div>

      {/* Invoice Detail Panel */}
      {selInv && (
        <div className="card" style={{padding:0,height:"fit-content",position:"sticky",top:0}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #111d2d",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{selInv.id}</div>
              <div style={{fontSize:11,color:"#3d5a7a"}}>{selInv.period}</div>
            </div>
            <div style={{display:"flex",gap:6}}>
              <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
              {selInv&&["sent","overdue","partial"].includes(selInv.status)&&(
                <button className="btn bg" style={{padding:"4px 8px",fontSize:11,color:copiedId===selInv.id?"#34d399":"#7dd3fc"}}
                  onClick={()=>copyPortalLink(selInv.id)}>
                  {copiedId===selInv.id?"✓ Copied":"⛓ Copy client link"}
                </button>
              )}
            </div>
          </div>
          <div style={{padding:"16px 18px"}}>
            <div style={{marginBottom:12}}>
              <div className="th" style={{marginBottom:4}}>Client</div>
              <div style={{fontSize:13,color:"#cbd5e1",fontWeight:600}}>{clients.find(c=>c.id===selInv.clientId)?.name||"—"}</div>
              <div style={{fontSize:11,color:"#3d5a7a"}}>{selInv.projectName}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[["Issue Date",fmtDate(selInv.issueDate)],["Due Date",fmtDate(selInv.dueDate)],["Terms",selInv.paymentTerms],["Status",selInv.status.toUpperCase()]].map(([l,v])=>(
                <div key={l}><div className="th" style={{marginBottom:2}}>{l}</div><div style={{fontSize:12,color:"#94a3b8"}}>{v}</div></div>
              ))}
            </div>

            {/* Line items */}
            <div className="th" style={{marginBottom:8}}>Line Items</div>
            <div style={{background:"#060d1c",borderRadius:8,overflow:"hidden",marginBottom:14}}>
              {selInv.lines.map((l,i)=>(
                <div key={l.id} style={{padding:"8px 12px",borderBottom:i<selInv.lines.length-1?"1px solid #111d2d":"none"}}>
                  <div style={{fontSize:12,color:"#94a3b8",marginBottom:2}}>{l.desc}</div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#475569"}}>
                    <span>{l.qty} × ${l.rate}/hr</span>
                    <span className="mono" style={{color:"#38bdf8",fontWeight:600}}>{fmt(l.amount)}</span>
                  </div>
                </div>
              ))}
              <div style={{padding:"10px 12px",background:"#0a1626",display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>TOTAL</span>
                <span className="mono" style={{fontSize:14,fontWeight:800,color:"#38bdf8"}}>{fmt(invTotal(selInv))}</span>
              </div>
            </div>

            {/* Payment history */}
            {finPayments.filter(p=>p.invoiceId===selInv.id).length > 0 && (
              <div style={{marginBottom:14}}>
                <div className="th" style={{marginBottom:8}}>Payments Received</div>
                {finPayments.filter(p=>p.invoiceId===selInv.id).map(p=>(
                  <div key={p.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #0a1626"}}>
                    <div>
                      <div style={{fontSize:12,color:"#94a3b8"}}>{fmtDate(p.date)} · {p.method}</div>
                      <div style={{fontSize:10,color:"#3d5a7a"}}>{p.ref}</div>
                    </div>
                    <span className="mono" style={{fontSize:13,fontWeight:600,color:"#34d399"}}>{fmt(p.amount)}</span>
                  </div>
                ))}
                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}>
                  <span style={{fontSize:12,fontWeight:700,color:"#94a3b8"}}>Balance Due</span>
                  <span className="mono" style={{fontSize:13,fontWeight:700,color:invBalance(selInv,finPayments)>0?"#f87171":"#34d399"}}>
                    {invBalance(selInv,finPayments)>0?fmt(invBalance(selInv,finPayments)):"Fully Paid"}
                  </span>
                </div>
              </div>
            )}

            {selInv.notes && <div style={{fontSize:11,color:"#3d5a7a",fontStyle:"italic",borderTop:"1px solid #111d2d",paddingTop:10}}>{selInv.notes}</div>}
          </div>
        </div>
      )}

      {/* New Invoice Modal */}
      {newModal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setNewModal(false)}>
          <div className="modal" style={{maxWidth:640}}>
            <MH title="New Invoice" onClose={()=>setNewModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Client"><select className="inp" value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})}>
                <option value="">Select…</option>{clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Project Name"><input className="inp" value={form.projectName} onChange={e=>setForm({...form,projectName:e.target.value})} placeholder="AT&T Managed Services"/></FF>
              <FF label="Billing Period"><input className="inp" value={form.period} onChange={e=>setForm({...form,period:e.target.value})} placeholder="Apr 2026"/></FF>
              <FF label="Payment Terms"><select className="inp" value={form.paymentTerms} onChange={e=>setForm({...form,paymentTerms:e.target.value})}>
                {["Net 15","Net 30","Net 45","Net 60","Due on Receipt"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Issue Date"><input className="inp" type="date" value={form.issueDate} onChange={e=>setForm({...form,issueDate:e.target.value})}/></FF>
              <FF label="Due Date"><input className="inp" type="date" value={form.dueDate} onChange={e=>setForm({...form,dueDate:e.target.value})}/></FF>
            </div>
            <div style={{marginTop:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <span className="th">Line Items</span>
                <button className="btn bg" style={{fontSize:11,padding:"4px 10px"}} onClick={addLine}><I d={ICONS.plus} s={11}/>Add Line</button>
              </div>
              {form.lines.map((l,idx)=>(
                <div key={l.id} style={{display:"grid",gridTemplateColumns:"1fr 60px 80px 80px 30px",gap:8,marginBottom:6,alignItems:"center"}}>
                  <input className="inp" value={l.desc} onChange={e=>updateLine(idx,"desc",e.target.value)} placeholder="Description" style={{fontSize:12}}/>
                  <input className="inp" type="number" value={l.qty} onChange={e=>updateLine(idx,"qty",e.target.value)} placeholder="Qty" style={{fontSize:12}}/>
                  <input className="inp" type="number" value={l.rate} onChange={e=>updateLine(idx,"rate",e.target.value)} placeholder="Rate" style={{fontSize:12}}/>
                  <span className="mono" style={{fontSize:12,color:"#38bdf8",textAlign:"right"}}>{fmt(l.qty*l.rate)}</span>
                  <button className="btn br" style={{padding:"3px 5px"}} onClick={()=>removeLine(idx)}>✕</button>
                </div>
              ))}
              {form.lines.length>0&&<div style={{textAlign:"right",marginTop:8,fontSize:14,fontWeight:700,color:"#38bdf8"}} className="mono">
                Total: {fmt(form.lines.reduce((s,l)=>s+l.qty*l.rate,0))}
              </div>}
            </div>
            <FF label="Notes"><textarea className="inp" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} rows={2} placeholder="PO number, payment instructions…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setNewModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveInvoice}><I d={ICONS.check} s={13}/>Save Invoice</button>
            </div>
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {payModal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setPayModal(null)}>
          <div className="modal" style={{maxWidth:460}}>
            <MH title="Record Payment" onClose={()=>setPayModal(null)}/>
            {(() => {
              const inv = finInvoices.find(i=>i.id===payModal);
              const cl  = clients.find(c=>c.id===inv?.clientId);
              const bal = inv ? invBalance(inv,finPayments) : 0;
              return (
                <div>
                  <div style={{background:"#060d1c",borderRadius:8,padding:"10px 14px",marginBottom:14}}>
                    <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{inv?.id} · {cl?.name}</div>
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                      <span style={{fontSize:12,color:"#64748b"}}>Total: {fmt(invTotal(inv||{lines:[]}))} · Balance: </span>
                      <span className="mono" style={{fontSize:13,fontWeight:700,color:"#f59e0b"}}>{fmt(bal)}</span>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <FF label="Amount ($)"><input className="inp" type="number" value={payForm.amount} onChange={e=>setPayForm({...payForm,amount:e.target.value})} placeholder={String(bal)}/></FF>
                    <FF label="Payment Date"><input className="inp" type="date" value={payForm.date} onChange={e=>setPayForm({...payForm,date:e.target.value})}/></FF>
                    <FF label="Method"><select className="inp" value={payForm.method} onChange={e=>setPayForm({...payForm,method:e.target.value})}>
                      {["ACH","Wire","Check","Credit Card","Internal","Other"].map(m=><option key={m}>{m}</option>)}
                    </select></FF>
                    <FF label="Reference #"><input className="inp" value={payForm.ref} onChange={e=>setPayForm({...payForm,ref:e.target.value})} placeholder="ACH-ATT-0411"/></FF>
                  </div>
                  <FF label="Notes"><input className="inp" value={payForm.notes} onChange={e=>setPayForm({...payForm,notes:e.target.value})} placeholder="Full payment, partial, etc."/></FF>
                  <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
                    <button className="btn bg" onClick={()=>setPayModal(null)}>Cancel</button>
                    <button className="btn bs" onClick={recordPayment}><I d={ICONS.check} s={13}/>Record Payment</button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── PAYMENTS ──────────────────────────────────────────────────────────────────
function FinPayments({ clients, finInvoices, finPayments, setFinPayments }) {
  const sorted = [...finPayments].sort((a,b)=>b.date.localeCompare(a.date));
  const totalCollected = finPayments.reduce((s,p)=>s+p.amount,0);
  const methodTotals = {};
  finPayments.forEach(p=>{ methodTotals[p.method]=(methodTotals[p.method]||0)+p.amount; });

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
        <div className="card" style={{padding:"14px 18px"}}>
          <div className="th" style={{marginBottom:6}}>Total Collected</div>
          <div className="mono" style={{fontSize:22,fontWeight:700,color:"#34d399"}}>{fmt(totalCollected)}</div>
          <div style={{fontSize:11,color:"#3d5a7a",marginTop:4}}>{finPayments.length} payments recorded</div>
        </div>
        {Object.entries(methodTotals).slice(0,3).map(([method,amt])=>(
          <div key={method} className="card" style={{padding:"14px 18px"}}>
            <div className="th" style={{marginBottom:6}}>{method}</div>
            <div className="mono" style={{fontSize:22,fontWeight:700,color:"#7dd3fc"}}>{fmt(amt)}</div>
            <div style={{fontSize:11,color:"#3d5a7a",marginTop:4}}>{finPayments.filter(p=>p.method===method).length} payments</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="section-hdr">Payment Ledger</div>
        <div className="tr" style={{gridTemplateColumns:"100px 130px 1fr 110px 80px 90px 130px",padding:"8px 18px"}}>
          {["Date","Invoice","Client","Amount","Method","Reference","Notes"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {sorted.map(p=>{
          const inv = finInvoices.find(i=>i.id===p.invoiceId);
          const cl  = clients.find(c=>c.id===p.clientId);
          return (
            <div key={p.id} className="tr" style={{gridTemplateColumns:"100px 130px 1fr 110px 80px 90px 130px"}}>
              <span style={{fontSize:12,color:"#64748b"}}>{fmtDate(p.date)}</span>
              <span className="mono" style={{fontSize:11,color:"#3d5a7a"}}>{p.invoiceId}</span>
              <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cl?.name||"—"}</span>
              <span className="mono" style={{fontSize:13,fontWeight:700,color:"#34d399"}}>{fmt(p.amount)}</span>
              <span className="bdg" style={{background:"#060d1c",color:"#7dd3fc"}}>{p.method}</span>
              <span style={{fontSize:11,color:"#475569"}}>{p.ref||"—"}</span>
              <span style={{fontSize:11,color:"#3d5a7a"}}>{p.notes||"—"}</span>
            </div>
          );
        })}
        {sorted.length===0&&<div style={{padding:"32px",textAlign:"center",color:"#1e3a5f",fontSize:13}}>No payments recorded yet</div>}
      </div>
    </div>
  );
}

// ── A/R AGING ─────────────────────────────────────────────────────────────────
function FinAging({ clients, finInvoices, finPayments }) {
  const openInvoices = finInvoices.filter(i=>["sent","overdue"].includes(i.status) && invBalance(i,finPayments)>0);

  const buckets = { "current":[], "0-30":[], "31-60":[], "61-90":[], "90+":[] };
  openInvoices.forEach(inv => {
    const b = agingBucket(inv);
    buckets[b].push(inv);
  });

  const bucketColors = { "current":"#34d399", "0-30":"#f59e0b", "31-60":"#fb923c", "61-90":"#f87171", "90+":"#dc2626" };
  const bucketBg    = { "current":"#021f14",  "0-30":"#1a1005",  "31-60":"#1a0d05", "61-90":"#1a0808",  "90+":"#180404" };
  const bucketLabel = { "current":"Current", "0-30":"1–30 Days", "31-60":"31–60 Days", "61-60":"61–90 Days", "90+":"90+ Days" };

  const totalAR = openInvoices.reduce((s,i)=>s+invBalance(i,finPayments),0);

  // Client aging rollup
  const clientAging = {};
  openInvoices.forEach(inv => {
    const cl = clients.find(c=>c.id===inv.clientId);
    const key = cl?.name||"Unknown";
    if(!clientAging[key]) clientAging[key]={name:key,"current":0,"0-30":0,"31-60":0,"61-90":0,"90+":0,total:0};
    const bal = invBalance(inv,finPayments);
    clientAging[key][agingBucket(inv)] += bal;
    clientAging[key].total += bal;
  });

  const exportAging = () => {
    const header = ["Invoice","Client","Issue Date","Due Date","Amount","Balance","Bucket"];
    const rows = openInvoices.map(inv => {
      const cl = clients.find(c=>c.id===inv.clientId);
      return [inv.id, cl?.name||"Unknown", inv.issueDate, inv.dueDate,
        invTotal(inv).toFixed(2), invBalance(inv,finPayments).toFixed(2), agingBucket(inv)];
    });
    const summary = [
      [], ["=== CLIENT SUMMARY ==="],
      ["Client","Current","1-30 Days","31-60 Days","61-90 Days","90+ Days","Total"],
      ...Object.values(clientAging).map(r =>
        [r.name, r["current"].toFixed(2), r["0-30"].toFixed(2), r["31-60"].toFixed(2), r["61-90"].toFixed(2), r["90+"].toFixed(2), r.total.toFixed(2)]
      ),
    ];
    downloadCSV([header, ...rows, ...summary], `ar-aging-${TODAY_STR}.csv`);
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        <button className="btn bg" style={{fontSize:11}} onClick={exportAging}>
          ⬇ Export Aging CSV
        </button>
      </div>
      {/* Aging summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:20}}>
        {Object.entries(buckets).map(([bucket,invs])=>{
          const total = invs.reduce((s,i)=>s+invBalance(i,finPayments),0);
          return (
            <div key={bucket} className="card" style={{padding:"14px 16px",borderTop:`3px solid ${bucketColors[bucket]}`}}>
              <div className="th" style={{marginBottom:6,color:bucketColors[bucket]}}>{bucketLabel[bucket]}</div>
              <div className="mono" style={{fontSize:20,fontWeight:700,color:bucketColors[bucket]}}>{fmt(total)}</div>
              <div style={{fontSize:11,color:"#3d5a7a",marginTop:4}}>{invs.length} invoice{invs.length!==1?"s":""}</div>
              {total>0&&<div style={{marginTop:8,height:4,background:"#0a1626",borderRadius:2}}>
                <div style={{height:4,borderRadius:2,background:bucketColors[bucket],width:`${totalAR>0?(total/totalAR)*100:0}%`}}/>
              </div>}
            </div>
          );
        })}
      </div>

      {/* Client aging table */}
      <div className="card" style={{marginBottom:18,overflowX:"auto"}}>
        <div className="section-hdr">A/R Aging by Client</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{borderBottom:"1px solid #111d2d"}}>
              {["Client","Current","1–30 Days","31–60 Days","61–90 Days","90+ Days","Total Outstanding"].map(h=>(
                <th key={h} className="th" style={{padding:"8px 14px",textAlign:h==="Client"?"left":"right"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.values(clientAging).sort((a,b)=>b.total-a.total).map((row,i)=>(
              <tr key={row.name} style={{borderBottom:"1px solid #0a1626",background:i%2===0?"#070b14":"transparent"}}>
                <td style={{padding:"10px 14px",fontWeight:600,color:"#cbd5e1"}}>{row.name}</td>
                {["current","0-30","31-60","61-90","90+"].map(b=>(
                  <td key={b} className="mono" style={{padding:"10px 14px",textAlign:"right",color:row[b]>0?bucketColors[b]:"#1e3a5f"}}>
                    {row[b]>0?fmt(row[b]):"—"}
                  </td>
                ))}
                <td className="mono" style={{padding:"10px 14px",textAlign:"right",fontWeight:700,color:"#38bdf8"}}>{fmt(row.total)}</td>
              </tr>
            ))}
            <tr style={{borderTop:"2px solid #1a2d45",background:"#0a1626"}}>
              <td style={{padding:"10px 14px",fontWeight:800,color:"#3d5a7a",fontSize:11,textTransform:"uppercase",letterSpacing:"0.07em"}}>TOTAL</td>
              {["current","0-30","31-60","61-90","90+"].map(b=>{
                const t=Object.values(clientAging).reduce((s,r)=>s+r[b],0);
                return <td key={b} className="mono" style={{padding:"10px 14px",textAlign:"right",fontWeight:700,color:t>0?bucketColors[b]:"#1e3a5f"}}>{t>0?fmt(t):"—"}</td>;
              })}
              <td className="mono" style={{padding:"10px 14px",textAlign:"right",fontWeight:800,fontSize:13,color:"#38bdf8"}}>{fmt(totalAR)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Invoice detail list */}
      <div className="card">
        <div className="section-hdr">Open Invoices Detail</div>
        <div className="tr" style={{gridTemplateColumns:"100px 1fr 110px 90px 80px 90px 90px",padding:"8px 18px"}}>
          {["Invoice","Client / Project","Issue Date","Due Date","Bucket","Total","Balance"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {openInvoices.sort((a,b)=>daysOverdue(b)-daysOverdue(a)).map(inv=>{
          const cl  = clients.find(c=>c.id===inv.clientId);
          const b   = agingBucket(inv);
          const bal = invBalance(inv,finPayments);
          return (
            <div key={inv.id} className="tr" style={{gridTemplateColumns:"100px 1fr 110px 90px 80px 90px 90px"}}>
              <span className="mono" style={{fontSize:11,color:"#3d5a7a"}}>{inv.id}</span>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cl?.name||"—"}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{inv.projectName}</div>
              </div>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(inv.issueDate)}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(inv.dueDate)}</span>
              <span className="bdg" style={{background:bucketBg[b],color:bucketColors[b]}}>{bucketLabel[b]}</span>
              <span className="mono" style={{fontSize:12,color:"#38bdf8"}}>{fmt(invTotal(inv))}</span>
              <span className="mono" style={{fontSize:13,fontWeight:700,color:bucketColors[b]}}>{fmt(bal)}</span>
            </div>
          );
        })}
        {openInvoices.length===0&&<div style={{padding:"32px",textAlign:"center",color:"#34d399",fontSize:13}}>✓ No open A/R — all invoices current</div>}
      </div>
    </div>
  );
}

// ── EXPENSES ──────────────────────────────────────────────────────────────────
function FinExpenses({ roster, clients, finExpenses, setFinExpenses }) {
  const [filter, setFilter] = useState("all");
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState({ consultantId:"", clientId:"", category:"Travel", date:new Date().toISOString().slice(0,10), amount:"", desc:"", reimbursable:true, receipt:false });

  const filtered = filter==="all" ? finExpenses : finExpenses.filter(e=>e.status===filter);
  const cats = ["Travel","Meals","Software","Training","Equipment","Marketing","Other"];
  const catColors = { Travel:"#38bdf8", Meals:"#f59e0b", Software:"#a78bfa", Training:"#34d399", Equipment:"#fb923c", Marketing:"#f87171", Other:"#64748b" };

  const updateStatus = (id, status) => setFinExpenses(es=>es.map(e=>e.id===id?{...e,status}:e));
  const saveExp = () => {
    setFinExpenses(es=>[...es,{...form, id:"exp"+uid(), amount:+form.amount, status:"pending"}]);
    setModal(false);
    setForm({ consultantId:"", clientId:"", category:"Travel", date:new Date().toISOString().slice(0,10), amount:"", desc:"", reimbursable:true, receipt:false });
  };

  const totalApproved = finExpenses.filter(e=>e.status==="approved").reduce((s,e)=>s+e.amount,0);
  const totalPending  = finExpenses.filter(e=>e.status==="pending").reduce((s,e)=>s+e.amount,0);
  const reimbursable  = finExpenses.filter(e=>e.status==="approved"&&e.reimbursable).reduce((s,e)=>s+e.amount,0);
  const passThrough   = finExpenses.filter(e=>e.status==="approved"&&!e.reimbursable).reduce((s,e)=>s+e.amount,0);

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
        {[
          {l:"Approved Expenses",    v:fmt(totalApproved), c:"#34d399"},
          {l:"Pending Approval",     v:fmt(totalPending),  c:"#f59e0b"},
          {l:"Reimbursable (to pay)",v:fmt(reimbursable),  c:"#f87171"},
          {l:"Pass-Through (bill)",  v:fmt(passThrough),   c:"#38bdf8"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 18px"}}>
            <div className="th" style={{marginBottom:6}}>{k.l}</div>
            <div className="mono" style={{fontSize:22,fontWeight:700,color:k.c}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center"}}>
        {["all","pending","approved","rejected"].map(s=>(
          <button key={s} className="btn bg" style={{fontSize:12,padding:"6px 14px",borderColor:filter===s?"#0284c7":"#1a2d45",color:filter===s?"#38bdf8":"#475569"}}
            onClick={()=>setFilter(s)}>
            {s.charAt(0).toUpperCase()+s.slice(1)} ({finExpenses.filter(e=>s==="all"||e.status===s).length})
          </button>
        ))}
        <button className="btn bp" style={{marginLeft:"auto",fontSize:12}} onClick={()=>setModal(true)}><I d={ICONS.plus} s={13}/>Submit Expense</button>
      </div>

      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"90px 130px 130px 80px 90px 1fr 80px 80px 100px",padding:"8px 18px"}}>
          {["Date","Consultant","Client","Category","Amount","Description","Reimb.","Receipt","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {filtered.map(exp=>{
          const consultant = roster.find(r=>r.id===exp.consultantId);
          const client     = clients.find(c=>c.id===exp.clientId);
          const statusC    = {approved:"#34d399",pending:"#f59e0b",rejected:"#f87171"};
          const statusBg3  = {approved:"#021f14",pending:"#1a1005",rejected:"#1a0808"};
          return (
            <div key={exp.id} className="tr" style={{gridTemplateColumns:"90px 130px 130px 80px 90px 1fr 80px 80px 100px"}}>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(exp.date)}</span>
              <span style={{fontSize:12,color:"#94a3b8"}}>{consultant?.name||"—"}</span>
              <span style={{fontSize:12,color:"#64748b"}}>{client?.name||"—"}</span>
              <span className="bdg" style={{background:"#060d1c",color:catColors[exp.category]||"#64748b",fontSize:10}}>{exp.category}</span>
              <span className="mono" style={{fontSize:13,fontWeight:600,color:"#f59e0b"}}>{fmt(exp.amount)}</span>
              <span style={{fontSize:11,color:"#475569",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{exp.desc}</span>
              <span style={{fontSize:11,color:exp.reimbursable?"#f87171":"#38bdf8",textAlign:"center"}}>{exp.reimbursable?"Reimb.":"Pass-Thru"}</span>
              <span style={{fontSize:11,color:exp.receipt?"#34d399":"#f87171",textAlign:"center"}}>{exp.receipt?"✓":"Missing"}</span>
              <div style={{display:"flex",gap:4}}>
                {exp.status==="pending"&&<>
                  <button className="btn bs" style={{padding:"3px 6px",fontSize:10}} onClick={()=>updateStatus(exp.id,"approved")}>✓</button>
                  <button className="btn br" style={{padding:"3px 6px",fontSize:10}} onClick={()=>updateStatus(exp.id,"rejected")}>✗</button>
                </>}
                {exp.status!=="pending"&&<span className="bdg" style={{background:statusBg3[exp.status],color:statusC[exp.status]}}>{exp.status}</span>}
              </div>
            </div>
          );
        })}
        {filtered.length===0&&<div style={{padding:"32px",textAlign:"center",color:"#1e3a5f",fontSize:13}}>No expenses in this filter</div>}
      </div>

      {modal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:520}}>
            <MH title="Submit Expense" onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Consultant"><select className="inp" value={form.consultantId} onChange={e=>setForm({...form,consultantId:e.target.value})}>
                <option value="">Select…</option>{roster.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></FF>
              <FF label="Client"><select className="inp" value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})}>
                <option value="">Select…</option>{clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Category"><select className="inp" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}>
                {cats.map(c=><option key={c}>{c}</option>)}
              </select></FF>
              <FF label="Date"><input className="inp" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></FF>
              <FF label="Amount ($)"><input className="inp" type="number" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} placeholder="250"/></FF>
              <FF label="Type">
                <div style={{display:"flex",gap:10,alignItems:"center",height:40}}>
                  <label style={{display:"flex",gap:6,alignItems:"center",cursor:"pointer",fontSize:13,color:"#94a3b8"}}>
                    <input type="radio" checked={form.reimbursable} onChange={()=>setForm({...form,reimbursable:true})}/> Reimbursable
                  </label>
                  <label style={{display:"flex",gap:6,alignItems:"center",cursor:"pointer",fontSize:13,color:"#94a3b8"}}>
                    <input type="radio" checked={!form.reimbursable} onChange={()=>setForm({...form,reimbursable:false})}/> Pass-Through
                  </label>
                </div>
              </FF>
            </div>
            <FF label="Description"><input className="inp" value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder="Flight DFW→NYC for AT&T onsite"/></FF>
            <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer",fontSize:13,color:"#94a3b8",marginTop:10}}>
              <input type="checkbox" checked={form.receipt} onChange={e=>setForm({...form,receipt:e.target.checked})}/>
              Receipt attached / available
            </label>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveExp}><I d={ICONS.check} s={13}/>Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MARGIN WATERFALL ──────────────────────────────────────────────────────────
function FinWaterfall({ roster, clients, tsHours, finInvoices, finPayments }) {
  const [view, setView] = useState("consultant"); // consultant | client | project

  const calcRosterFin = (r) => {
    const hrs = MONTHS.reduce((s,_,i)=>s+(tsHours[r.id]?.[i]||0),0);
    const billRev   = hrs * r.billRate;
    const costRate  = r.type==="FTE"
      ? r.baseSalary + (r.baseSalary * (BURDEN.fica+BURDEN.futa+BURDEN.suta+BURDEN.wc)) + BURDEN.health + (r.baseSalary*BURDEN.retire) + (r.baseSalary*BURDEN.other)
      : r.fixedRate * hrs + (r.thirdPartySplit * (r.billRate - r.fixedRate) * hrs);
    const revShare  = r.revShare > 0 ? billRev * r.revShare : 0;
    const coGross   = billRev - costRate - revShare;
    const grossMargin = billRev > 0 ? coGross / billRev : 0;
    return { billRev, costRate, revShare, coGross, grossMargin, hrs };
  };

  // By consultant
  const consultantRows = roster.map(r => ({ ...r, ...calcRosterFin(r) })).filter(r=>r.billRev>0).sort((a,b)=>b.coGross-a.coGross);

  // By client (group roster by client)
  const clientMap = {};
  clients.forEach(c=>{ clientMap[c.id]={name:c.name,billRev:0,costRate:0,coGross:0,consultants:0}; });
  roster.forEach(r=>{
    const fin = calcRosterFin(r);
    const cl = clients.find(c=>c.name===r.client||r.client.includes(c.name.split(" ")[0]));
    if(cl&&clientMap[cl.id]){
      clientMap[cl.id].billRev   += fin.billRev;
      clientMap[cl.id].costRate  += fin.costRate;
      clientMap[cl.id].coGross   += fin.coGross;
      clientMap[cl.id].consultants++;
    }
  });
  const clientRows = Object.values(clientMap).filter(c=>c.billRev>0).sort((a,b)=>b.coGross-a.coGross);

  const totalBill  = consultantRows.reduce((s,r)=>s+r.billRev,0);
  const totalCost  = consultantRows.reduce((s,r)=>s+r.costRate,0);
  const totalShare = consultantRows.reduce((s,r)=>s+r.revShare,0);
  const totalGross = consultantRows.reduce((s,r)=>s+r.coGross,0);
  const netMargin  = totalBill > 0 ? totalGross / totalBill : 0;

  // Waterfall visual
  const waterfallSteps = [
    { label:"Billed Revenue",     value:totalBill,        color:"#38bdf8",  pct:1 },
    { label:"Less: Direct Costs", value:-totalCost,       color:"#f87171",  pct:totalCost/totalBill },
    { label:"Less: Rev Share",    value:-totalShare,      color:"#f59e0b",  pct:totalShare/totalBill },
    { label:"Gross Profit",       value:totalGross,       color:"#34d399",  pct:totalGross/totalBill },
  ];

  return (
    <div>
      {/* Waterfall chart */}
      <div className="card" style={{padding:"20px 22px",marginBottom:20}}>
        <div className="section-hdr" style={{padding:"0 0 16px",border:"none"}}>Margin Waterfall — Annual 2026</div>
        <div style={{display:"flex",gap:0,alignItems:"flex-end",height:160,marginBottom:16}}>
          {waterfallSteps.map((step,i)=>(
            <div key={step.label} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <div className="mono" style={{fontSize:12,fontWeight:700,color:step.color}}>{fmt(Math.abs(step.value))}</div>
              <div style={{width:"70%",background:step.color,borderRadius:"4px 4px 0 0",height:`${Math.max(8,Math.abs(step.pct)*140)}px`,opacity:0.9,position:"relative"}}>
                {i<waterfallSteps.length-1&&<div style={{position:"absolute",right:-16,top:"50%",transform:"translateY(-50%)",color:"#3d5a7a",fontSize:14}}>→</div>}
              </div>
              <div style={{fontSize:10,color:"#475569",textAlign:"center",maxWidth:90,lineHeight:1.3}}>{step.label}</div>
            </div>
          ))}
        </div>
        <div style={{borderTop:"1px solid #111d2d",paddingTop:14,display:"flex",gap:24,justifyContent:"center"}}>
          <div style={{textAlign:"center"}}><div className="th" style={{marginBottom:4}}>Gross Margin</div><div className="mono" style={{fontSize:20,fontWeight:700,color:"#34d399"}}>{pct(netMargin)}</div></div>
          <div style={{textAlign:"center"}}><div className="th" style={{marginBottom:4}}>Total Gross Profit</div><div className="mono" style={{fontSize:20,fontWeight:700,color:"#34d399"}}>{fmt(totalGross)}</div></div>
          <div style={{textAlign:"center"}}><div className="th" style={{marginBottom:4}}>Cost Ratio</div><div className="mono" style={{fontSize:20,fontWeight:700,color:"#f87171"}}>{pct(totalBill>0?totalCost/totalBill:0)}</div></div>
          <div style={{textAlign:"center"}}><div className="th" style={{marginBottom:4}}>Billable Hours</div><div className="mono" style={{fontSize:20,fontWeight:700,color:"#38bdf8"}}>{consultantRows.reduce((s,r)=>s+r.hrs,0).toLocaleString()}</div></div>
        </div>
      </div>

      {/* View toggle */}
      <div style={{display:"flex",gap:4,marginBottom:14}}>
        {[["consultant","By Consultant"],["client","By Client"]].map(([id,label])=>(
          <button key={id} className="btn bg" style={{fontSize:12,padding:"6px 14px",borderColor:view===id?"#0284c7":"#1a2d45",color:view===id?"#38bdf8":"#475569"}}
            onClick={()=>setView(id)}>{label}</button>
        ))}
      </div>

      {/* By Consultant table */}
      {view==="consultant" && (
        <div className="card" style={{overflowX:"auto"}}>
          <div className="tr" style={{gridTemplateColumns:"1.2fr 80px 70px 100px 100px 90px 90px 100px 80px",padding:"8px 18px"}}>
            {["Consultant","Type","Hours","Bill Revenue","Direct Cost","Rev Share","Gross Profit","Margin %","Margin Bar"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {consultantRows.map(r=>(
            <div key={r.id} className="tr" style={{gridTemplateColumns:"1.2fr 80px 70px 100px 100px 90px 90px 100px 80px",alignItems:"center"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{r.role}</div>
              </div>
              <span className="bdg" style={{background:r.type==="FTE"?"#0c2340":"#1a1a2e",color:r.type==="FTE"?"#38bdf8":"#a78bfa"}}>{r.type}</span>
              <span className="mono" style={{fontSize:12,color:"#64748b"}}>{r.hrs.toLocaleString()}</span>
              <span className="mono" style={{fontSize:12,color:"#38bdf8"}}>{fmt(r.billRev)}</span>
              <span className="mono" style={{fontSize:12,color:"#f87171"}}>{fmt(r.costRate)}</span>
              <span className="mono" style={{fontSize:12,color:"#f59e0b"}}>{r.revShare>0?fmt(r.revShare):"—"}</span>
              <span className="mono" style={{fontSize:13,fontWeight:700,color:r.coGross>0?"#34d399":"#f87171"}}>{fmt(r.coGross)}</span>
              <span className="mono" style={{fontSize:12,color:r.grossMargin>0.3?"#34d399":r.grossMargin>0.1?"#f59e0b":"#f87171"}}>{pct(r.grossMargin)}</span>
              <div style={{height:8,background:"#0a1626",borderRadius:4,overflow:"hidden"}}>
                <div style={{height:8,borderRadius:4,background:r.grossMargin>0.3?"#34d399":r.grossMargin>0.1?"#f59e0b":"#f87171",width:`${Math.max(0,Math.min(100,r.grossMargin*100))}%`}}/>
              </div>
            </div>
          ))}
          <div className="tr" style={{gridTemplateColumns:"1.2fr 80px 70px 100px 100px 90px 90px 100px 80px",background:"#0a1626"}}>
            <span style={{fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}}>TOTAL</span>
            <span/><span className="mono" style={{fontSize:11,color:"#64748b"}}>{consultantRows.reduce((s,r)=>s+r.hrs,0).toLocaleString()}</span>
            <span className="mono" style={{fontSize:12,fontWeight:700,color:"#38bdf8"}}>{fmt(totalBill)}</span>
            <span className="mono" style={{fontSize:12,fontWeight:700,color:"#f87171"}}>{fmt(totalCost)}</span>
            <span className="mono" style={{fontSize:12,fontWeight:700,color:"#f59e0b"}}>{fmt(totalShare)}</span>
            <span className="mono" style={{fontSize:13,fontWeight:800,color:"#34d399"}}>{fmt(totalGross)}</span>
            <span className="mono" style={{fontSize:13,fontWeight:800,color:"#34d399"}}>{pct(netMargin)}</span>
            <span/>
          </div>
        </div>
      )}

      {/* By Client table */}
      {view==="client" && (
        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"1.4fr 80px 110px 110px 110px 90px 100px",padding:"8px 18px"}}>
            {["Client","Consultants","Bill Revenue","Direct Cost","Gross Profit","Margin %","Margin Bar"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {clientRows.map(r=>(
            <div key={r.name} className="tr" style={{gridTemplateColumns:"1.4fr 80px 110px 110px 110px 90px 100px",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r.name}</span>
              <span className="mono" style={{fontSize:12,color:"#64748b",textAlign:"center"}}>{r.consultants}</span>
              <span className="mono" style={{fontSize:12,color:"#38bdf8"}}>{fmt(r.billRev)}</span>
              <span className="mono" style={{fontSize:12,color:"#f87171"}}>{fmt(r.costRate)}</span>
              <span className="mono" style={{fontSize:13,fontWeight:700,color:r.coGross>0?"#34d399":"#f87171"}}>{fmt(r.coGross)}</span>
              <span className="mono" style={{fontSize:12,color:r.billRev>0&&r.coGross/r.billRev>0.3?"#34d399":r.billRev>0&&r.coGross/r.billRev>0.1?"#f59e0b":"#f87171"}}>
                {r.billRev>0?pct(r.coGross/r.billRev):"—"}
              </span>
              <div style={{height:8,background:"#0a1626",borderRadius:4,overflow:"hidden"}}>
                <div style={{height:8,borderRadius:4,background:"#34d399",width:`${r.billRev>0?Math.max(0,Math.min(100,(r.coGross/r.billRev)*100)):0}%`}}/>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECRUITING MODULE — Phase 4
// ═══════════════════════════════════════════════════════════════════════════════
function RecruitingModule({ candidates, setCandidates, submissions, setSubmissions, interviews, setInterviews, offers, setOffers, clients, roster, addAudit }) {
  const [sub, setSub] = useState("overview");
  const tabs = [
    { id:"overview",    label:"Overview" },
    { id:"candidates",  label:"Candidates" },
    { id:"submissions", label:"Submissions" },
    { id:"interviews",  label:"Interviews" },
    { id:"offers",      label:"Offers" },
  ];
  const props = { candidates, setCandidates, submissions, setSubmissions, interviews, setInterviews, offers, setOffers, clients, roster, addAudit };
  return (
    <div>
      <PH title="Recruiting" sub="Candidates · Submissions · Interviews · Offers"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 16px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {sub==="overview"    && <RecOverview    {...props}/>}
      {sub==="candidates"  && <RecCandidates  {...props}/>}
      {sub==="submissions" && <RecSubmissions {...props}/>}
      {sub==="interviews"  && <RecInterviews  {...props}/>}
      {sub==="offers"      && <RecOffers      {...props}/>}
    </div>
  );
}

function RecOverview({ candidates, submissions, interviews, offers, clients }) {
  const active    = candidates.filter(c=>c.status==="active").length;
  const placed    = candidates.filter(c=>c.status==="placed").length;
  const totalSubs = submissions.length;
  const scheduled = interviews.filter(i=>i.status==="scheduled").length;
  const pendOff   = offers.filter(o=>o.status==="pending").length;
  const accepted  = offers.filter(o=>o.status==="accepted").length;

  // pipeline funnel counts
  const funnel = [
    { stage:"Active Candidates", count:active,    color:"#38bdf8" },
    { stage:"Submitted",         count:totalSubs, color:"#7dd3fc" },
    { stage:"Interviews",        count:interviews.length, color:"#a78bfa" },
    { stage:"Offers Pending",    count:pendOff,   color:"#f59e0b" },
    { stage:"Placed",            count:placed,    color:"#34d399" },
  ];
  const maxFunnel = Math.max(...funnel.map(f=>f.count), 1);

  // recent activity
  const recentInts = [...interviews].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,4);

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:18}}>
        {[
          {l:"Active Candidates",  v:active,          c:"#38bdf8"},
          {l:"Total Submissions",  v:totalSubs,       c:"#7dd3fc"},
          {l:"Interviews",         v:interviews.length,c:"#a78bfa"},
          {l:"Pending Offers",     v:pendOff,         c:"#f59e0b"},
          {l:"Accepted Offers",    v:accepted,        c:"#34d399"},
          {l:"Placed",             v:placed,          c:"#34d399"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:26,fontWeight:800,color:k.c}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        {/* Funnel */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div className="section-hdr" style={{padding:"0 0 14px",border:"none"}}>Recruiting Funnel</div>
          {funnel.map(f=>(
            <div key={f.stage} style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:12,color:"#64748b"}}>{f.stage}</span>
                <span style={{fontSize:13,fontWeight:700,color:f.color}}>{f.count}</span>
              </div>
              <div style={{height:8,background:"#0a1626",borderRadius:4}}>
                <div style={{height:8,borderRadius:4,background:f.color,width:`${(f.count/maxFunnel)*100}%`,transition:"width 0.4s"}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Upcoming interviews */}
        <div className="card">
          <div className="section-hdr">Upcoming & Recent Interviews</div>
          {recentInts.map(int=>{
            const cand = candidates.find(c=>c.id===int.candidateId);
            const statusC = {completed:"#34d399", scheduled:"#f59e0b", cancelled:"#f87171"};
            return (
              <div key={int.id} className="tr" style={{gridTemplateColumns:"1fr 90px 80px"}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cand?.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>Round {int.round} · {int.type} · {fmtDate(int.date)}</div>
                  {int.feedback && <div style={{fontSize:10,color:"#475569",marginTop:2}}>{int.feedback.slice(0,60)}…</div>}
                </div>
                {int.rating>0 && <div style={{display:"flex",gap:1}}>{"★".repeat(int.rating).split("").map((s,i)=><span key={i} style={{color:"#f59e0b",fontSize:12}}>{s}</span>)}</div>}
                <span className="bdg" style={{background:"#060d1c",color:statusC[int.status]||"#64748b"}}>{int.status}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent offers */}
      <div className="card">
        <div className="section-hdr">Active Offers</div>
        <div className="tr" style={{gridTemplateColumns:"1fr 1fr 90px 100px 80px",padding:"8px 18px"}}>
          {["Candidate","Client / Project","Bill Rate","Start Date","Status"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {offers.map(o=>{
          const cand = candidates.find(c=>c.id===o.candidateId);
          const cl   = clients.find(c=>c.id===o.clientId);
          const sc   = {pending:"#f59e0b",accepted:"#34d399",declined:"#f87171"};
          return (
            <div key={o.id} className="tr" style={{gridTemplateColumns:"1fr 1fr 90px 100px 80px"}}>
              <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cand?.name}</span>
              <div><div style={{fontSize:12,color:"#94a3b8"}}>{cl?.name}</div><div style={{fontSize:10,color:"#3d5a7a"}}>{o.projectName}</div></div>
              <span className="mono" style={{color:"#38bdf8",fontSize:13,fontWeight:600}}>${o.billRate}/hr</span>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(o.startDate)}</span>
              <span className="bdg" style={{background:"#060d1c",color:sc[o.status]||"#64748b"}}>{o.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CandPipelineKanban({ candidates, setCandidates, submissions, interviews, offers }) {
  const STAGES = [
    { id:"new",        label:"New",         color:"#64748b" },
    { id:"screening",  label:"Screening",   color:"#38bdf8" },
    { id:"submitted",  label:"Submitted",   color:"#a78bfa" },
    { id:"interview",  label:"Interviewing",color:"#f59e0b" },
    { id:"offer",      label:"Offer",       color:"#10b981" },
    { id:"placed",     label:"Placed ✓",    color:"#34d399" },
    { id:"rejected",   label:"Rejected",    color:"#f87171" },
  ];
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const moveTo = (cid, stage) => setCandidates(cs => cs.map(c => c.id===cid ? {...c, status:stage} : c));

  const candsByStage = stage => candidates.filter(c => {
    if (stage==="new")       return !c.status || c.status==="active";
    if (stage==="screening") return c.status==="screening";
    if (stage==="submitted") return c.status==="submitted";
    if (stage==="interview") return c.status==="interviewing";
    if (stage==="offer")     return c.status==="offer";
    if (stage==="placed")    return c.status==="placed";
    if (stage==="rejected")  return c.status==="rejected";
    return false;
  });

  return (
    <div style={{overflowX:"auto",paddingBottom:8}}>
      <div style={{display:"flex",gap:10,minWidth:900}}>
        {STAGES.map(st => {
          const cards = candsByStage(st.id);
          const isOver = dragOver===st.id;
          return (
            <div key={st.id} style={{flex:"0 0 160px",background:isOver?"#0c1f35":"#070c18",
              border:`1px solid ${isOver?st.color+"88":"#1a2d45"}`,borderRadius:10,padding:"10px 8px",
              transition:"all 0.15s",minHeight:200}}
              onDragOver={e=>{e.preventDefault();setDragOver(st.id);}}
              onDragLeave={()=>setDragOver(null)}
              onDrop={e=>{e.preventDefault();if(dragId)moveTo(dragId,st.id==="new"?"active":st.id==="interview"?"interviewing":st.id);setDragId(null);setDragOver(null);}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <span style={{fontSize:11,fontWeight:700,color:st.color}}>{st.label}</span>
                <span style={{fontSize:10,color:"#3d5a7a",fontFamily:"'DM Mono',monospace"}}>{cards.length}</span>
              </div>
              {cards.map(cand => {
                const hasOffer = offers.some(o=>o.candidateId===cand.id&&o.status==="pending");
                const numIntvw = interviews.filter(i=>i.candidateId===cand.id).length;
                return (
                  <div key={cand.id} draggable
                    onDragStart={()=>setDragId(cand.id)}
                    onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                    style={{background:"#0b1422",border:`1px solid ${st.color}22`,borderLeft:`3px solid ${st.color}`,
                      borderRadius:7,padding:"8px 10px",marginBottom:7,cursor:"grab",
                      opacity:dragId===cand.id?0.4:1,transition:"opacity 0.1s",userSelect:"none"}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginBottom:3,lineHeight:1.3}}>{cand.name}</div>
                    <div style={{fontSize:10,color:"#3d5a7a",marginBottom:4}}>{cand.role||cand.title||"—"}</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                      {cand.rate&&<span style={{fontSize:9,background:"#0a1626",color:"#38bdf8",borderRadius:3,padding:"1px 4px"}}>${cand.rate}/hr</span>}
                      {numIntvw>0&&<span style={{fontSize:9,background:"#1a1005",color:"#f59e0b",borderRadius:3,padding:"1px 4px"}}>{numIntvw} intvw</span>}
                      {hasOffer&&<span style={{fontSize:9,background:"#021f14",color:"#34d399",borderRadius:3,padding:"1px 4px"}}>offer out</span>}
                    </div>
                  </div>
                );
              })}
              {cards.length===0&&<div style={{fontSize:10,color:"#1e3a5f",textAlign:"center",padding:"16px 0",borderRadius:6,border:"1px dashed #1a2d45",marginTop:4}}>Drop here</div>}
            </div>
          );
        })}
      </div>
      <div style={{marginTop:10,fontSize:10,color:"#1e3a5f"}}>💡 Drag cards between columns to update candidate status</div>
    </div>
  );
}

function RecCandidates({ candidates, setCandidates, submissions, interviews, offers, addAudit }) {
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState(null);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter]   = useState("all");
  const [selected, setSelected] = useState(null);
  const [selCands, setSelCands] = useState(new Set());

  const toggleCandRow = (id) => setSelCands(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const bulkDeleteCands = () => {
    if (!selCands.size) return;
    const names = candidates.filter(c=>selCands.has(c.id)).map(c=>c.name).join(", ");
    if (!window.confirm(`Permanently delete ${selCands.size} candidate(s)?\n\n${names}`)) return;
    setCandidates(cs => cs.filter(c => !selCands.has(c.id)));
    addAudit && addAudit("Recruiting","Bulk Delete Candidates","Recruiting",`Deleted ${selCands.size} candidates: ${names}`);
    setSelCands(new Set());
    setSelected(null);
  };

  const empty = { name:"",role:"",email:"",phone:"",source:"Referral",visa:"H-1B",skills:"",status:"active",notes:"",linkedIn:"",resumeName:null,resumeData:null };
  const open = (c=null) => { setEditing(c?.id||null); setForm(c?{...c}:{...empty}); setModal(true); };
  const save = () => {
    if(editing) setCandidates(cs=>cs.map(c=>c.id===editing?{...form}:c));
    else { setCandidates(cs=>[...cs,{...form,id:"cand"+uid()}]); addAudit&&addAudit("Recruiting","New Candidate","Recruiting",`Added ${form.name} for ${form.role}`); }
    setModal(false);
  };
  const del = id => { setCandidates(cs=>cs.filter(c=>c.id!==id)); setSelected(null); };

  const statusColors = { active:"#38bdf8", placed:"#34d399", withdrawn:"#64748b", inactive:"#f87171" };
  const visaColors   = { "H-1B":"#f59e0b","GC":"#34d399","USC":"#38bdf8","OPT":"#f87171","EAD":"#fb923c","TN":"#a78bfa" };
  const filtered = filter==="all" ? candidates : candidates.filter(c=>c.status===filter);
  const selCand  = candidates.find(c=>c.id===selected);

  return (
    <div style={{display:"grid",gridTemplateColumns:selCand?"1fr 340px":"1fr",gap:16}}>
      <div>
        {/* View toggle */}
        <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center"}}>
          <div style={{display:"flex",gap:2,background:"#060d1c",borderRadius:8,padding:2,border:"1px solid #1a2d45"}}>
            {[{id:"pipeline",label:"🗂 Pipeline"},{id:"list",label:"☰ List"}].map(v=>(
              <button key={v.id} onClick={()=>setFilter(v.id==="pipeline"?"__pipeline__":filter==="__pipeline__"?"all":filter)}
                style={{padding:"4px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,
                  background:filter==="__pipeline__"===( v.id==="pipeline" )?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
                  color:filter==="__pipeline__"===( v.id==="pipeline" )?"#fff":"#475569",transition:"all 0.15s"}}>
                {v.label}
              </button>
            ))}
          </div>
          {filter!=="__pipeline__"&&["all","active","placed","withdrawn"].map(s=>(
            <button key={s} className="btn bg" style={{fontSize:11,padding:"4px 10px",borderColor:filter===s?"#0284c7":"#1a2d45",color:filter===s?"#38bdf8":"#475569"}}
              onClick={()=>setFilter(s)}>
              {s.charAt(0).toUpperCase()+s.slice(1)} ({candidates.filter(c=>s==="all"||c.status===s).length})
            </button>
          ))}
          <div style={{display:"flex",gap:8,marginLeft:"auto"}}>
            {selCands.size>0&&<button className="btn br" style={{fontSize:11}} onClick={bulkDeleteCands}>🗑 Delete {selCands.size} selected</button>}
            <button className="btn bp" style={{fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>Add Candidate</button>
          </div>
        </div>
        {filter==="__pipeline__"&&<CandPipelineKanban candidates={candidates} setCandidates={setCandidates} submissions={submissions} interviews={interviews} offers={offers}/>}
        <div className="card" style={{overflowX:"auto"}}>
          <div className="tr" style={{gridTemplateColumns:"28px 1.4fr 1fr 80px 90px 80px 90px",padding:"8px 18px",minWidth:720}}>
            <input type="checkbox" checked={selCands.size===filtered.length&&filtered.length>0} onChange={()=>setSelCands(s=>s.size===filtered.length?new Set():new Set(filtered.map(c=>c.id)))} style={{accentColor:"#0369a1",cursor:"pointer"}}/>
            {["Name / Role","Skills","Visa","Source","Status","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(c=>{
            const cSubs = submissions.filter(s=>s.candidateId===c.id).length;
            const cInts = interviews.filter(i=>i.candidateId===c.id).length;
            return (
              <div key={c.id} className="tr" style={{gridTemplateColumns:"28px 1.4fr 1fr 80px 90px 80px 90px",minWidth:720,cursor:"pointer",background:selCands.has(c.id)?"#0a1a2e":selected===c.id?"#061526":undefined}} onClick={()=>setSelected(selected===c.id?null:c.id)}>
                <input type="checkbox" checked={selCands.has(c.id)} onChange={()=>toggleCandRow(c.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"#0369a1",cursor:"pointer"}}/>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{c.role}</div>
                  <div style={{fontSize:10,color:"#1e3a5f",marginTop:2}}>{cSubs} sub · {cInts} int</div>
                </div>
                <div style={{fontSize:11,color:"#475569",lineHeight:1.4}}>{c.skills?.split(",").slice(0,3).map(s=>s.trim()).join(" · ")}</div>
                <span className="bdg" style={{background:"#0a1626",color:visaColors[c.visa]||"#64748b"}}>{c.visa}</span>
                <span style={{fontSize:11,color:"#475569"}}>{c.source}</span>
                <span className="bdg" style={{background:"#060d1c",color:statusColors[c.status]||"#64748b"}}>{c.status}</span>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  <button className="btn bg" style={{padding:"3px 7px",fontSize:11}} onClick={()=>open(c)}><I d={ICONS.edit} s={11}/></button>
                  <button className="btn br"  style={{padding:"3px 7px",fontSize:11}} onClick={()=>del(c.id)}><I d={ICONS.trash} s={11}/></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selCand && (
        <div className="card" style={{padding:0,height:"fit-content",position:"sticky",top:0}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #111d2d",display:"flex",justifyContent:"space-between"}}>
            <div><div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{selCand.name}</div><div style={{fontSize:11,color:"#3d5a7a"}}>{selCand.role}</div></div>
            <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
          </div>
          <div style={{padding:"16px 18px"}}>
            {[["Email",selCand.email],["Phone",selCand.phone],["Source",selCand.source],["Visa",selCand.visa]].map(([l,v])=>(
              <div key={l} style={{marginBottom:10}}><div className="th" style={{marginBottom:2}}>{l}</div><div style={{fontSize:12,color:"#94a3b8"}}>{v||"—"}</div></div>
            ))}
            <div style={{marginBottom:10}}><div className="th" style={{marginBottom:4}}>Skills</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                {selCand.skills?.split(",").map(s=>s.trim()).filter(Boolean).map(s=>(
                  <span key={s} className="bdg" style={{background:"#0c2340",color:"#7dd3fc"}}>{s}</span>
                ))}
              </div>
            </div>
            {selCand.notes && <div style={{marginBottom:10}}><div className="th" style={{marginBottom:2}}>Notes</div><div style={{fontSize:11,color:"#64748b",lineHeight:1.5}}>{selCand.notes}</div></div>}
            {selCand.resumeName && (
              <div style={{marginBottom:10}}>
                <div className="th" style={{marginBottom:4}}>Resume</div>
                <a href={selCand.resumeData} download={selCand.resumeName}
                  style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:11,color:"#38bdf8",textDecoration:"none",
                    padding:"5px 10px",background:"#070c18",border:"1px solid #1a3a5c",borderRadius:6}}>
                  📎 {selCand.resumeName} ↓
                </a>
              </div>
            )}
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button className="btn bg" style={{flex:1,justifyContent:"center",fontSize:12}} onClick={()=>open(selCand)}>Edit</button>
              <select className="inp" style={{flex:1,fontSize:12}} value={selCand.status} onChange={e=>{ setCandidates(cs=>cs.map(c=>c.id===selCand.id?{...c,status:e.target.value}:c)); }}>
                {["active","placed","withdrawn","inactive"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:540}}>
            <MH title={editing?"Edit Candidate":"Add Candidate"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Full Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Arjun Reddy"/></FF>
              <FF label="Role"><input className="inp" value={form.role} onChange={e=>setForm({...form,role:e.target.value})} placeholder="SAP BRIM Consultant"/></FF>
              <FF label="Email"><input className="inp" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></FF>
              <FF label="Phone"><input className="inp" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></FF>
              <FF label="Visa Status"><select className="inp" value={form.visa} onChange={e=>setForm({...form,visa:e.target.value})}>
                {["H-1B","GC","USC","OPT","EAD","TN","Other"].map(v=><option key={v}>{v}</option>)}
              </select></FF>
              <FF label="Source"><select className="inp" value={form.source} onChange={e=>setForm({...form,source:e.target.value})}>
                {["Referral","LinkedIn","Job Board","Network","Agency","Other"].map(s=><option key={s}>{s}</option>)}
              </select></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
                {["active","placed","withdrawn","inactive"].map(s=><option key={s}>{s}</option>)}
              </select></FF>
            </div>
            <FF label="Skills (comma-separated)"><input className="inp" value={form.skills} onChange={e=>setForm({...form,skills:e.target.value})} placeholder="SAP BRIM, IS-U, ABAP"/></FF>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></FF>
            <div>
              <div className="lbl" style={{marginBottom:4}}>Resume / Document</div>
              {form.resumeName ? (
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"#070c18",border:"1px solid #1a3a5c",borderRadius:6}}>
                  <span style={{fontSize:12,color:"#38bdf8"}}>📎 {form.resumeName}</span>
                  <button className="btn br" style={{fontSize:10,padding:"2px 6px",marginLeft:"auto"}} onClick={()=>setForm({...form,resumeName:null,resumeData:null})}>Remove</button>
                </div>
              ) : (
                <label style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"#070c18",border:"1px dashed #1a3a5c",borderRadius:6,cursor:"pointer"}}>
                  <span style={{fontSize:12,color:"#475569"}}>📎 Click to attach resume / PDF / doc</span>
                  <input type="file" accept=".pdf,.doc,.docx,.txt" style={{display:"none"}} onChange={e=>{
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = ev => setForm(f=>({...f, resumeName:file.name, resumeData:ev.target.result}));
                    reader.readAsDataURL(file);
                    e.target.value = "";
                  }}/>
                </label>
              )}
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RecSubmissions({ candidates, clients, submissions, setSubmissions, interviews }) {
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState({ candidateId:"", clientId:"", projectName:"", submitDate:new Date().toISOString().slice(0,10), reqId:"", notes:"" });

  const save = () => {
    setSubmissions(ss=>[...ss,{...form,id:"sub"+uid()}]);
    setModal(false);
    setForm({ candidateId:"", clientId:"", projectName:"", submitDate:new Date().toISOString().slice(0,10), reqId:"", notes:"" });
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:14}}>
        <button className="btn bp" style={{fontSize:12}} onClick={()=>setModal(true)}><I d={ICONS.plus} s={13}/>New Submission</button>
      </div>
      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1fr 1fr 1fr 100px 90px 1fr",padding:"8px 18px"}}>
          {["Candidate","Client","Project","Submitted","Req ID","Notes"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {submissions.map(s=>{
          const cand = candidates.find(c=>c.id===s.candidateId);
          const cl   = clients.find(c=>c.id===s.clientId);
          const ints = interviews.filter(i=>i.submissionId===s.id).length;
          return (
            <div key={s.id} className="tr" style={{gridTemplateColumns:"1fr 1fr 1fr 100px 90px 1fr"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cand?.name||"—"}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{cand?.role}</div>
              </div>
              <span style={{fontSize:12,color:"#94a3b8"}}>{cl?.name||"—"}</span>
              <span style={{fontSize:12,color:"#64748b"}}>{s.projectName}</span>
              <span style={{fontSize:11,color:"#475569"}}>{fmtDate(s.submitDate)}</span>
              <span className="mono" style={{fontSize:10,color:"#3d5a7a"}}>{s.reqId}</span>
              <div>
                <div style={{fontSize:11,color:"#3d5a7a",marginBottom:2}}>{s.notes?.slice(0,60)}</div>
                {ints>0&&<span className="bdg" style={{background:"#0c2340",color:"#7dd3fc"}}>{ints} interview{ints>1?"s":""}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:500}}>
            <MH title="New Submission" onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Candidate"><select className="inp" value={form.candidateId} onChange={e=>setForm({...form,candidateId:e.target.value})}>
                <option value="">Select…</option>{candidates.filter(c=>c.status==="active").map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Client"><select className="inp" value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})}>
                <option value="">Select…</option>{clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Project Name"><input className="inp" value={form.projectName} onChange={e=>setForm({...form,projectName:e.target.value})}/></FF>
              <FF label="Req / JO ID"><input className="inp" value={form.reqId} onChange={e=>setForm({...form,reqId:e.target.value})} placeholder="AT&T-REQ-004"/></FF>
              <FF label="Submit Date"><input className="inp" type="date" value={form.submitDate} onChange={e=>setForm({...form,submitDate:e.target.value})}/></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Rate submitted, notes for client…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RecInterviews({ candidates, clients, submissions, interviews, setInterviews }) {
  const [modal, setModal] = useState(false);
  const [fbModal, setFbModal] = useState(null); // interview id for feedback
  const [fbText, setFbText]   = useState("");
  const [fbRating, setFbRating] = useState(0);
  const [form, setForm] = useState({ candidateId:"", submissionId:"", round:1, type:"Technical", date:"", time:"09:00 AM", interviewer:"", status:"scheduled", feedback:"", rating:0 });

  const save = () => { setInterviews(is=>[...is,{...form,id:"int"+uid(),round:+form.round,rating:+form.rating}]); setModal(false); };
  const saveFb = () => {
    setInterviews(is=>is.map(i=>i.id===fbModal?{...i,feedback:fbText,rating:fbRating,status:"completed"}:i));
    setFbModal(null); setFbText(""); setFbRating(0);
  };
  const statusC = { scheduled:"#f59e0b", completed:"#34d399", cancelled:"#f87171" };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:14}}>
        <button className="btn bp" style={{fontSize:12}} onClick={()=>setModal(true)}><I d={ICONS.plus} s={13}/>Schedule Interview</button>
      </div>
      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1fr 80px 90px 100px 110px 1fr 70px 80px",padding:"8px 18px"}}>
          {["Candidate","Round","Type","Date","Interviewer","Feedback","Rating","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {[...interviews].sort((a,b)=>b.date.localeCompare(a.date)).map(int=>{
          const cand = candidates.find(c=>c.id===int.candidateId);
          return (
            <div key={int.id} className="tr" style={{gridTemplateColumns:"1fr 80px 90px 100px 110px 1fr 70px 80px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cand?.name||"—"}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{int.time}</div>
              </div>
              <span className="bdg" style={{background:"#0c2340",color:"#7dd3fc"}}>Rd {int.round}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{int.type}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(int.date)}</span>
              <span style={{fontSize:11,color:"#475569"}}>{int.interviewer}</span>
              <span style={{fontSize:11,color:"#3d5a7a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{int.feedback||"—"}</span>
              <div style={{display:"flex",gap:1}}>
                {int.rating>0 ? "★".repeat(int.rating).split("").map((s,i)=><span key={i} style={{color:"#f59e0b",fontSize:11}}>{s}</span>) : <span style={{color:"#1e3a5f",fontSize:11}}>—</span>}
              </div>
              <div style={{display:"flex",gap:4}}>
                <span className="bdg" style={{background:"#060d1c",color:statusC[int.status]||"#64748b"}}>{int.status}</span>
                {int.status==="scheduled"&&<button className="btn bs" style={{padding:"2px 6px",fontSize:10}} onClick={()=>{setFbModal(int.id);setFbText(int.feedback||"");setFbRating(int.rating||0);}}>+ FB</button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Feedback Modal */}
      {fbModal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setFbModal(null)}>
          <div className="modal" style={{maxWidth:440}}>
            <MH title="Add Interview Feedback" onClose={()=>setFbModal(null)}/>
            <FF label="Feedback Notes">
              <textarea className="inp" rows={4} value={fbText} onChange={e=>setFbText(e.target.value)} placeholder="Technical assessment, cultural fit, recommendation…"/>
            </FF>
            <FF label="Rating">
              <div style={{display:"flex",gap:8,marginTop:4}}>
                {[1,2,3,4,5].map(n=>(
                  <button key={n} onClick={()=>setFbRating(n)} style={{background:"none",border:"none",cursor:"pointer",fontSize:24,color:n<=fbRating?"#f59e0b":"#1e3a5f",transition:"color 0.15s"}}>★</button>
                ))}
                <span style={{fontSize:12,color:"#64748b",alignSelf:"center",marginLeft:4}}>{fbRating}/5</span>
              </div>
            </FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setFbModal(null)}>Cancel</button>
              <button className="btn bs" onClick={saveFb}><I d={ICONS.check} s={13}/>Save Feedback</button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {modal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:500}}>
            <MH title="Schedule Interview" onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Candidate"><select className="inp" value={form.candidateId} onChange={e=>setForm({...form,candidateId:e.target.value})}>
                <option value="">Select…</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Submission"><select className="inp" value={form.submissionId} onChange={e=>setForm({...form,submissionId:e.target.value})}>
                <option value="">Select…</option>{submissions.filter(s=>s.candidateId===form.candidateId).map(s=><option key={s.id} value={s.id}>{s.projectName}</option>)}
              </select></FF>
              <FF label="Round"><input className="inp" type="number" min={1} max={5} value={form.round} onChange={e=>setForm({...form,round:e.target.value})}/></FF>
              <FF label="Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
                {["Technical","Manager","HR","Client","Panel","Reference"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Date"><input className="inp" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></FF>
              <FF label="Time"><input className="inp" value={form.time} onChange={e=>setForm({...form,time:e.target.value})} placeholder="10:00 AM"/></FF>
              <FF label="Interviewer"><input className="inp" value={form.interviewer} onChange={e=>setForm({...form,interviewer:e.target.value})} placeholder="AT&T Tech Lead"/></FF>
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Schedule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RecOffers({ candidates, clients, offers, setOffers }) {
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState({ candidateId:"", clientId:"", projectName:"", billRate:"", startDate:"", endDate:"", status:"pending", terms:"W2", notes:"" });

  const save = () => { setOffers(os=>[...os,{...form,id:"off"+uid(),billRate:+form.billRate}]); setModal(false); };
  const updateStatus = (id, status) => setOffers(os=>os.map(o=>o.id===id?{...o,status}:o));
  const sc = { pending:"#f59e0b",accepted:"#34d399",declined:"#f87171",withdrawn:"#64748b" };
  const sb = { pending:"#1a1005",accepted:"#021f14",declined:"#1a0808",withdrawn:"#0a1626" };

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:18}}>
        {["pending","accepted","declined","withdrawn"].map(s=>{
          const cnt = offers.filter(o=>o.status===s);
          const ttl = cnt.reduce((sum,o)=>sum+o.billRate*1920,0);
          return (
            <div key={s} className="card" style={{padding:"12px 16px",borderTop:`3px solid ${sc[s]}`}}>
              <div className="th" style={{color:sc[s],marginBottom:4}}>{s.charAt(0).toUpperCase()+s.slice(1)}</div>
              <div style={{fontSize:22,fontWeight:700,color:sc[s]}}>{cnt.length}</div>
              {ttl>0&&<div style={{fontSize:11,color:"#3d5a7a",marginTop:4}}>{fmt(ttl)} est. annual rev</div>}
            </div>
          );
        })}
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:14}}>
        <button className="btn bp" style={{fontSize:12}} onClick={()=>setModal(true)}><I d={ICONS.plus} s={13}/>Create Offer</button>
      </div>
      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1fr 1fr 1fr 90px 100px 100px 80px 100px",padding:"8px 18px"}}>
          {["Candidate","Client","Project","Rate","Start","End","Terms","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {offers.map(o=>{
          const cand = candidates.find(c=>c.id===o.candidateId);
          const cl   = clients.find(c=>c.id===o.clientId);
          return (
            <div key={o.id} className="tr" style={{gridTemplateColumns:"1fr 1fr 1fr 90px 100px 100px 80px 100px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{cand?.name||"—"}</div>
                {o.notes&&<div style={{fontSize:10,color:"#3d5a7a"}}>{o.notes.slice(0,40)}</div>}
              </div>
              <span style={{fontSize:12,color:"#94a3b8"}}>{cl?.name||"—"}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{o.projectName}</span>
              <span className="mono" style={{color:"#38bdf8",fontWeight:700}}>${o.billRate}/hr</span>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(o.startDate)}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(o.endDate)}</span>
              <span className="bdg" style={{background:"#060d1c",color:"#7dd3fc"}}>{o.terms}</span>
              <div style={{display:"flex",gap:4}}>
                <span className="bdg" style={{background:sb[o.status],color:sc[o.status]}}>{o.status}</span>
                {o.status==="pending"&&<>
                  <button className="btn bs" style={{padding:"2px 5px",fontSize:10}} onClick={()=>updateStatus(o.id,"accepted")}>✓</button>
                  <button className="btn br" style={{padding:"2px 5px",fontSize:10}} onClick={()=>updateStatus(o.id,"declined")}>✗</button>
                </>}
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:540}}>
            <MH title="Create Offer" onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Candidate"><select className="inp" value={form.candidateId} onChange={e=>setForm({...form,candidateId:e.target.value})}>
                <option value="">Select…</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Client"><select className="inp" value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})}>
                <option value="">Select…</option>{clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Project Name"><input className="inp" value={form.projectName} onChange={e=>setForm({...form,projectName:e.target.value})}/></FF>
              <FF label="Bill Rate ($/hr)"><input className="inp" type="number" value={form.billRate} onChange={e=>setForm({...form,billRate:e.target.value})}/></FF>
              <FF label="Start Date"><input className="inp" type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})}/></FF>
              <FF label="End Date"><input className="inp" type="date" value={form.endDate} onChange={e=>setForm({...form,endDate:e.target.value})}/></FF>
              <FF label="Employment Terms"><select className="inp" value={form.terms} onChange={e=>setForm({...form,terms:e.target.value})}>
                {["W2","C2C","1099","W2/C2C"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Deadline, conditions, counter-offer…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Create Offer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLIANCE MODULE — Phase 5
// ═══════════════════════════════════════════════════════════════════════════════
function ComplianceModule({ workAuth, setWorkAuth, compDocs, setCompDocs, roster, addAudit }) {
  const [sub, setSub] = useState("dashboard");
  const tabs = [
    { id:"dashboard", label:"Compliance Dashboard" },
    { id:"workauth",  label:"Work Authorization" },
    { id:"documents", label:"Documents" },
  ];
  const props = { workAuth, setWorkAuth, compDocs, setCompDocs, roster };
  return (
    <div>
      <PH title="Compliance" sub="Work Auth · Visa Tracking · Document Expiry Alerts"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 16px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {sub==="dashboard" && <CompDashboard {...props}/>}
      {sub==="workauth"  && <CompWorkAuth  {...props}/>}
      {sub==="documents" && <CompDocuments {...props}/>}
    </div>
  );
}

const daysUntil = (dateStr) => {
  const d = new Date(dateStr+"T00:00:00");
  const today = new Date("2026-03-11T00:00:00");
  return Math.floor((d - today) / 86400000);
};
const urgencyLevel = (days) => {
  if (days < 0)   return { label:"EXPIRED",  color:"#dc2626", bg:"#180404" };
  if (days <= 30) return { label:"URGENT",   color:"#f87171", bg:"#1a0808" };
  if (days <= 60) return { label:"WARNING",  color:"#f59e0b", bg:"#1a1005" };
  if (days <= 90) return { label:"EXPIRING", color:"#fb923c", bg:"#1a0d05" };
  return              { label:"CURRENT",  color:"#34d399", bg:"#021f14" };
};

function CompDashboard({ workAuth, compDocs, roster }) {
  const today = new Date();

  // Roll up status per consultant
  const consultantStatus = roster.map(r => {
    const wa   = workAuth.find(w=>w.consultantId===r.id);
    const docs  = compDocs.filter(d=>d.consultantId===r.id);
    const waDays  = wa   ? daysUntil(wa.expiryDate)   : 9999;
    const docDays = docs.length ? Math.min(...docs.map(d=>daysUntil(d.expiryDate))) : 9999;
    const minDays = Math.min(waDays, docDays);
    const urg = urgencyLevel(minDays);
    return { ...r, urg, minDays, wa, urgentDocs: docs.filter(d=>daysUntil(d.expiryDate)<=60) };
  });

  const expired  = consultantStatus.filter(c=>c.minDays<0).length;
  const urgent   = consultantStatus.filter(c=>c.minDays>=0&&c.minDays<=30).length;
  const warning  = consultantStatus.filter(c=>c.minDays>30&&c.minDays<=60).length;
  const expiring = consultantStatus.filter(c=>c.minDays>60&&c.minDays<=90).length;
  const current  = consultantStatus.filter(c=>c.minDays>90).length;

  // All items expiring within 90 days
  const allAlerts = [
    ...workAuth.map(w=>({ name:w.name, type:"Work Auth: "+w.type, expiry:w.expiryDate, days:daysUntil(w.expiryDate), notes:w.notes })),
    ...compDocs.map(d=>({ name:d.name, type:"Doc: "+d.docType, expiry:d.expiryDate, days:daysUntil(d.expiryDate), notes:d.notes })),
  ].filter(a=>a.days<=90).sort((a,b)=>a.days-b.days);

  return (
    <div>
      {/* Status overview */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:20}}>
        {[
          { label:"Expired",  count:expired,  color:"#dc2626", bg:"#180404" },
          { label:"Urgent (≤30d)", count:urgent, color:"#f87171", bg:"#1a0808" },
          { label:"Warning (≤60d)", count:warning,  color:"#f59e0b", bg:"#1a1005" },
          { label:"Expiring (≤90d)", count:expiring, color:"#fb923c", bg:"#1a0d05" },
          { label:"Current",  count:current,  color:"#34d399", bg:"#021f14" },
        ].map(s=>(
          <div key={s.label} className="card" style={{padding:"14px 16px",borderTop:`3px solid ${s.color}`}}>
            <div className="th" style={{color:s.color,marginBottom:4}}>{s.label}</div>
            <div style={{fontSize:28,fontWeight:800,color:s.color}}>{s.count}</div>
            <div style={{fontSize:10,color:"#3d5a7a",marginTop:2}}>consultant{s.count!==1?"s":""}</div>
          </div>
        ))}
      </div>

      {/* Alert queue */}
      {allAlerts.length > 0 && (
        <div className="card" style={{marginBottom:18}}>
          <div className="section-hdr" style={{color:"#f87171"}}>
            ⚠ Action Required — Expiring Within 90 Days ({allAlerts.length} items)
          </div>
          <div className="tr" style={{gridTemplateColumns:"1fr 1.2fr 100px 80px 1fr",padding:"8px 18px"}}>
            {["Consultant","Type","Expires","Days","Notes / Action"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {allAlerts.map((a,i)=>{
            const urg = urgencyLevel(a.days);
            return (
              <div key={i} className="tr" style={{gridTemplateColumns:"1fr 1.2fr 100px 80px 1fr",background:i%2===0?"#070b14":"transparent"}}>
                <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{a.name}</span>
                <span style={{fontSize:11,color:"#94a3b8"}}>{a.type}</span>
                <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(a.expiry)}</span>
                <span className="bdg" style={{background:urg.bg,color:urg.color}}>
                  {a.days<0?`${Math.abs(a.days)}d PAST`:`${a.days}d`}
                </span>
                <span style={{fontSize:11,color:"#3d5a7a",lineHeight:1.4}}>{a.notes?.slice(0,80)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Consultant heatmap */}
      <div className="card">
        <div className="section-hdr">Compliance Status — All Consultants</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,padding:16}}>
          {consultantStatus.map(c=>{
            const urg = c.urg;
            return (
              <div key={c.id} style={{background:urg.bg,border:`1px solid ${urg.color}33`,borderRadius:10,padding:"12px 14px"}}>
                <div style={{fontSize:12,fontWeight:700,color:urg.color,marginBottom:4}}>
                  <span style={{marginRight:6}}>
                    {c.minDays<0?"🔴":c.minDays<=30?"🔴":c.minDays<=60?"🟡":c.minDays<=90?"🟠":"🟢"}
                  </span>
                  {c.name.split(" ")[0]}
                </div>
                <div style={{fontSize:9,color:"#475569",marginBottom:4}}>{c.role}</div>
                <div style={{fontSize:10,color:urg.color,fontWeight:600}}>
                  {c.minDays<0?"EXPIRED":c.minDays<=90?`${c.minDays}d left`:"Current"}
                </div>
                {c.wa && <div style={{fontSize:9,color:"#3d5a7a",marginTop:3}}>{c.wa.type}</div>}
                {c.urgentDocs.length>0&&<div style={{fontSize:9,color:"#f87171",marginTop:2}}>{c.urgentDocs.length} doc{c.urgentDocs.length>1?"s":""} expiring</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CompWorkAuth({ workAuth, setWorkAuth, roster, addAudit }) {
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState(null);
  const [editing, setEditing] = useState(null);

  const empty = { consultantId:"", name:"", type:"H-1B", status:"active", startDate:"", expiryDate:"", petitionNo:"", attorney:"", notes:"" };
  const open = (w=null) => {
    setEditing(w?.id||null);
    setForm(w?{...w}:{...empty});
    setModal(true);
  };
  const save = () => {
    if(editing) { setWorkAuth(ws=>ws.map(w=>w.id===editing?{...form}:w)); addAudit&&addAudit("Compliance","Update Work Auth","Compliance",`Updated ${form.visaType} for ${form.name||form.memberId}`,{expiry:form.expiry}); }
    else { setWorkAuth(ws=>[...ws,{...form,id:"wa"+uid()}]); addAudit&&addAudit("Compliance","New Work Auth","Compliance",`Added ${form.visaType} — expiry ${form.expiry}`); }
    setModal(false);
  };

  const visaColors = { "H-1B":"#f59e0b","GC":"#34d399","USC":"#38bdf8","OPT":"#f87171","EAD":"#fb923c","TN":"#a78bfa" };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:14}}>
        <button className="btn bp" style={{fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>Add Work Auth</button>
      </div>
      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1.2fr 80px 80px 110px 110px 1fr 1fr 90px",padding:"8px 18px"}}>
          {["Consultant","Type","Status","Start","Expiry","Days Left","Petition / Notes","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {workAuth.map(w=>{
          const days = daysUntil(w.expiryDate);
          const urg  = urgencyLevel(days);
          return (
            <div key={w.id} className="tr" style={{gridTemplateColumns:"1.2fr 80px 80px 110px 110px 1fr 1fr 90px"}}>
              <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{w.name}</span>
              <span className="bdg" style={{background:"#0a1626",color:visaColors[w.type]||"#64748b"}}>{w.type}</span>
              <span className="bdg" style={{background:urg.bg,color:urg.color}}>{urg.label}</span>
              <span style={{fontSize:11,color:"#475569"}}>{fmtDate(w.startDate)}</span>
              <span style={{fontSize:11,color:days<=60?"#f87171":"#64748b"}}>{fmtDate(w.expiryDate)}</span>
              <div>
                <span className="mono" style={{fontSize:12,fontWeight:700,color:urg.color}}>
                  {days<0?`${Math.abs(days)}d EXPIRED`:`${days} days`}
                </span>
                <div style={{height:4,background:"#0a1626",borderRadius:2,marginTop:4,width:80}}>
                  <div style={{height:4,borderRadius:2,background:urg.color,width:`${Math.max(0,Math.min(100,(days/365)*100))}%`}}/>
                </div>
              </div>
              <div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{w.petitionNo}</div>
                <div style={{fontSize:10,color:"#1e3a5f",marginTop:2}}>{w.notes?.slice(0,60)}</div>
              </div>
              <button className="btn bg" style={{padding:"3px 8px",fontSize:11}} onClick={()=>open(w)}><I d={ICONS.edit} s={11}/>Edit</button>
            </div>
          );
        })}
      </div>

      {modal && form && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:540}}>
            <MH title={editing?"Edit Work Authorization":"Add Work Authorization"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Consultant"><select className="inp" value={form.consultantId} onChange={e=>{ const r=roster.find(r=>r.id===e.target.value); setForm({...form,consultantId:e.target.value,name:r?.name||form.name}); }}>
                <option value="">Select…</option>{roster.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></FF>
              <FF label="Auth Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
                {["H-1B","GC","USC","OPT","EAD","TN","L-1","Other"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Start Date"><input className="inp" type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})}/></FF>
              <FF label="Expiry Date"><input className="inp" type="date" value={form.expiryDate} onChange={e=>setForm({...form,expiryDate:e.target.value})}/></FF>
              <FF label="Petition / File No."><input className="inp" value={form.petitionNo} onChange={e=>setForm({...form,petitionNo:e.target.value})}/></FF>
              <FF label="Attorney"><input className="inp" value={form.attorney} onChange={e=>setForm({...form,attorney:e.target.value})} placeholder="Law firm name"/></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Renewal status, action items…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompDocuments({ compDocs, setCompDocs, roster, addAudit }) {
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState({ consultantId:"", name:"", docType:"I-9", issueDate:"", expiryDate:"", status:"current", fileName:"", notes:"" });
  const [filter, setFilter] = useState("all");

  const save = () => {
    setCompDocs(ds=>[...ds,{...form,id:"doc"+uid()}]);
    setModal(false);
    setForm({ consultantId:"", name:"", docType:"I-9", issueDate:"", expiryDate:"", status:"current", fileName:"", notes:"" });
  };
  const updateStatus = (id, status) => setCompDocs(ds=>ds.map(d=>d.id===id?{...d,status}:d));

  const filtered = filter==="all" ? compDocs : compDocs.filter(d=>{
    const days = daysUntil(d.expiryDate);
    if(filter==="urgent")   return days>=0&&days<=30;
    if(filter==="warning")  return days>30&&days<=60;
    if(filter==="expiring") return days>60&&days<=90;
    if(filter==="current")  return days>90;
    return true;
  });

  const docTypeColors = { "I-9":"#38bdf8","NDA":"#a78bfa","H-1B Petition":"#f59e0b","AT&T Badge":"#34d399","Client B NDA":"#7dd3fc","I-9 (OPT EAD)":"#fb923c" };

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center"}}>
        {[["all","All"],["urgent","Urgent (≤30d)"],["warning","Warning (≤60d)"],["expiring","Expiring (≤90d)"],["current","Current"]].map(([v,l])=>(
          <button key={v} className="btn bg" style={{fontSize:11,padding:"5px 10px",borderColor:filter===v?"#0284c7":"#1a2d45",color:filter===v?"#38bdf8":"#475569"}}
            onClick={()=>setFilter(v)}>{l}</button>
        ))}
        <button className="btn bp" style={{marginLeft:"auto",fontSize:12}} onClick={()=>setModal(true)}><I d={ICONS.plus} s={13}/>Add Document</button>
      </div>

      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"1.2fr 1.2fr 110px 110px 80px 1fr 80px",padding:"8px 18px"}}>
          {["Consultant","Document Type","Issued","Expires","Days","Notes","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {filtered.sort((a,b)=>daysUntil(a.expiryDate)-daysUntil(b.expiryDate)).map(d=>{
          const days = daysUntil(d.expiryDate);
          const urg  = urgencyLevel(days);
          return (
            <div key={d.id} className="tr" style={{gridTemplateColumns:"1.2fr 1.2fr 110px 110px 80px 1fr 80px"}}>
              <span style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{d.name}</span>
              <span className="bdg" style={{background:"#0a1626",color:docTypeColors[d.docType]||"#7dd3fc",fontSize:10}}>{d.docType}</span>
              <span style={{fontSize:11,color:"#475569"}}>{fmtDate(d.issueDate)}</span>
              <span style={{fontSize:11,color:days<=60?"#f87171":"#64748b"}}>{fmtDate(d.expiryDate)}</span>
              <span className="bdg" style={{background:urg.bg,color:urg.color,fontSize:10}}>
                {days<0?`${Math.abs(days)}d past`:`${days}d`}
              </span>
              <span style={{fontSize:11,color:"#3d5a7a",lineHeight:1.4}}>{d.notes?.slice(0,70)||"—"}</span>
              <div style={{display:"flex",gap:4}}>
                {d.fileName?
                  <span className="bdg" style={{background:"#021f14",color:"#34d399",fontSize:9}}>✓ Filed</span>:
                  <span className="bdg" style={{background:"#1a0808",color:"#f87171",fontSize:9}}>Missing</span>
                }
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:500}}>
            <MH title="Add Document" onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Consultant"><select className="inp" value={form.consultantId} onChange={e=>{ const r=roster.find(r=>r.id===e.target.value); setForm({...form,consultantId:e.target.value,name:r?.name||""}); }}>
                <option value="">Select…</option>{roster.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></FF>
              <FF label="Document Type"><select className="inp" value={form.docType} onChange={e=>setForm({...form,docType:e.target.value})}>
                {["I-9","H-1B Petition","I-94","Offer Letter","NDA","Client Badge","Insurance Cert","W-9","Other"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Issue Date"><input className="inp" type="date" value={form.issueDate} onChange={e=>setForm({...form,issueDate:e.target.value})}/></FF>
              <FF label="Expiry Date"><input className="inp" type="date" value={form.expiryDate} onChange={e=>setForm({...form,expiryDate:e.target.value})}/></FF>
              <FF label="File Name / Ref"><input className="inp" value={form.fileName} onChange={e=>setForm({...form,fileName:e.target.value})} placeholder="i9_name.pdf"/></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Action items, renewal status…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTIVE DASHBOARD UPGRADE — Phase 6
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SALES CRM — Phase 3
// Accounts · Contacts · Deals · Pipeline · Activities · Forecasting
// ═══════════════════════════════════════════════════════════════════════════════

const STAGE_ORDER  = ["prospecting","qualified","proposal","negotiation","closed-won","closed-lost"];
const STAGE_COLORS = { prospecting:"#475569", qualified:"#7dd3fc", proposal:"#a78bfa", negotiation:"#f59e0b", "closed-won":"#34d399", "closed-lost":"#f87171" };
const STAGE_BG     = { prospecting:"#0a1626", qualified:"#0c2340", proposal:"#1a1a2e", negotiation:"#1a1005", "closed-won":"#021f14", "closed-lost":"#1a0808" };
const TYPE_COLORS  = { new:"#38bdf8", expansion:"#a78bfa", renewal:"#f59e0b", partner:"#34d399" };
const ACT_ICONS    = { email:"✉", call:"📞", meeting:"📅", note:"📝", task:"☑" };
const HEALTH_COL   = { green:"#34d399", amber:"#f59e0b", red:"#f87171" };
const ACCT_TYPE_C  = { customer:"#34d399", prospect:"#38bdf8", partner:"#a78bfa", "at-risk":"#f87171" };

function SalesCRM({ crmAccounts, setCrmAccounts, crmContacts, setCrmContacts, crmDeals, setCrmDeals, crmActivities, setCrmActivities, clients, addAudit }) {
  const [sub, setSub] = useState("overview");
  const tabs = [
    { id:"overview",    label:"Pipeline Overview" },
    { id:"accounts",    label:"Accounts" },
    { id:"deals",       label:"Deals" },
    { id:"activities",  label:"Activities" },
    { id:"forecast",    label:"Forecast" },
  ];
  const props = { crmAccounts, setCrmAccounts, crmContacts, setCrmContacts, crmDeals, setCrmDeals, crmActivities, setCrmActivities, clients };
  return (
    <div>
      <PH title="Sales CRM" sub="Accounts · Deals · Pipeline · Activities · Forecast"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {sub==="overview"   && <CRMOverview   {...props}/>}
      {sub==="accounts"   && <CRMAccounts   {...props}/>}
      {sub==="deals"      && <CRMDeals      {...props}/>}
      {sub==="activities" && <CRMActivities {...props}/>}
      {sub==="forecast"   && <CRMForecast   {...props}/>}
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────────
function CRMOverview({ crmAccounts, crmDeals, crmActivities, setCrmActivities }) {
  const open      = crmDeals.filter(d=>!["closed-won","closed-lost"].includes(d.stage));
  const won       = crmDeals.filter(d=>d.stage==="closed-won");
  const pipeline  = open.reduce((s,d)=>s+d.value,0);
  const weighted  = open.reduce((s,d)=>s+d.value*(d.probability/100),0);
  const wonVal    = won.reduce((s,d)=>s+d.value,0);
  const overdueActs = crmActivities.filter(a=>!a.completed && a.date <TODAY_STR).length;

  // Kanban columns
  const activeStages = ["prospecting","qualified","proposal","negotiation"];

  // Upcoming tasks (next 14 days, not complete)
  const upcoming = [...crmActivities]
    .filter(a=>!a.completed && a.date >=TODAY_STR && a.date <= new Date(Date.now()+14*86400000).toISOString().slice(0,10))
    .sort((a,b)=>a.date.localeCompare(b.date));

  const toggleDone = id => setCrmActivities(as=>as.map(a=>a.id===id?{...a,completed:!a.completed}:a));

  return (
    <div>
      {/* KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Open Pipeline",    v:fmt(pipeline),     sub:`${open.length} deals`,         c:"#38bdf8"},
          {l:"Weighted Pipeline",v:fmt(weighted),     sub:"probability-adjusted",          c:"#7dd3fc"},
          {l:"Closed Won (YTD)", v:fmt(wonVal),       sub:`${won.length} deals`,           c:"#34d399"},
          {l:"Accounts",         v:crmAccounts.length,sub:`${crmAccounts.filter(a=>a.type==="prospect").length} prospects`, c:"#a78bfa"},
          {l:"Overdue Actions",  v:overdueActs,       sub:"need attention",                c:overdueActs>0?"#f87171":"#34d399"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"14px 16px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:22,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
            <div style={{fontSize:10,color:"#2d4a63",marginTop:3}}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Kanban pipeline board */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20}}>
        {activeStages.map(stage=>{
          const deals = crmDeals.filter(d=>d.stage===stage);
          const total = deals.reduce((s,d)=>s+d.value,0);
          return (
            <div key={stage} style={{background:"#070c18",border:"1px solid #1a2d45",borderRadius:12,padding:"12px 14px",minHeight:180}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <span className="bdg" style={{background:STAGE_BG[stage],color:STAGE_COLORS[stage],fontSize:11,textTransform:"capitalize"}}>{stage}</span>
                <span style={{fontSize:11,color:"#3d5a7a",fontFamily:"'DM Mono',monospace"}}>{fmt(total)}</span>
              </div>
              {deals.map(d=>{
                const acc = crmAccounts.find(a=>a.id===d.accountId);
                return (
                  <div key={d.id} style={{background:"#0b1422",border:`1px solid ${STAGE_COLORS[d.stage]}22`,borderLeft:`3px solid ${STAGE_COLORS[d.stage]}`,borderRadius:8,padding:"10px 12px",marginBottom:8}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginBottom:3,lineHeight:1.3}}>{d.name}</div>
                    <div style={{fontSize:10,color:"#3d5a7a",marginBottom:6}}>{acc?.name}</div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:12,fontWeight:700,color:STAGE_COLORS[d.stage],fontFamily:"'DM Mono',monospace"}}>{fmt(d.value)}</span>
                      <span className="bdg" style={{background:"#060d1c",color:"#64748b",fontSize:9}}>{d.probability}%</span>
                    </div>
                    <div style={{fontSize:10,color:"#1e3a5f",marginTop:4}}>⟶ {d.nextStep?.slice(0,50)}</div>
                  </div>
                );
              })}
              {deals.length===0&&<div style={{fontSize:11,color:"#1e3a5f",textAlign:"center",padding:"20px 0"}}>No deals</div>}
            </div>
          );
        })}
      </div>

      {/* Upcoming actions + account health */}
      <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:16}}>
        <div className="card">
          <div className="section-hdr">Upcoming Actions — Next 14 Days</div>
          {upcoming.length===0 && <div style={{padding:20,color:"#3d5a7a",fontSize:12,textAlign:"center"}}>No upcoming tasks</div>}
          {upcoming.map(a=>{
            const acc = crmAccounts.find(ac=>ac.id===a.accountId);
            const deal = crmDeals.find(d=>d.id===a.dealId);
            return (
              <div key={a.id} className="tr" style={{gridTemplateColumns:"28px 1fr 90px 80px"}}>
                <button onClick={()=>toggleDone(a.id)}
                  style={{width:20,height:20,borderRadius:"50%",background:a.completed?"#034d2f":"#0a1626",border:`2px solid ${a.completed?"#34d399":"#1e3a5f"}`,cursor:"pointer",flexShrink:0,fontSize:10,color:"#34d399",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {a.completed?"✓":""}
                </button>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{a.subject}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{ACT_ICONS[a.type]} {a.type} · {acc?.name} · {deal?.name?.slice(0,30)}</div>
                </div>
                <span style={{fontSize:11,color:"#64748b"}}>{fmtDate(a.date)}</span>
                <span className="bdg" style={{background:STAGE_BG[deal?.stage||"prospecting"],color:STAGE_COLORS[deal?.stage||"prospecting"],fontSize:9,textTransform:"capitalize"}}>{deal?.stage||"—"}</span>
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="section-hdr">Account Health</div>
          {crmAccounts.filter(a=>["customer","at-risk"].includes(a.type)).map(a=>(
            <div key={a.id} className="tr" style={{gridTemplateColumns:"1fr 70px auto"}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{a.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{a.industry}</div>
              </div>
              <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{fmt(a.annualRevPotential)}</span>
              <span className="bdg" style={{background:"#060d1c",color:HEALTH_COL[a.health]||"#64748b"}}>{a.health}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Accounts ──────────────────────────────────────────────────────────────────
function CRMAccounts({ crmAccounts, setCrmAccounts, crmContacts, setCrmContacts, crmDeals, crmActivities }) {
  const [modal, setModal]     = useState(false);
  const [conModal, setConModal] = useState(false);
  const [form, setForm]       = useState(null);
  const [conForm, setConForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editingCon, setEditingCon] = useState(null);
  const [selected, setSelected] = useState(null);
  const [typeFilter, setTypeFilter] = useState("all");

  const emptyAcc = { name:"", industry:"", type:"prospect", website:"", phone:"", address:"", annualRevPotential:0, owner:"Manju", health:"green", notes:"" };
  const emptyCon = { accountId:"", name:"", title:"", email:"", phone:"", linkedIn:"", isPrimary:false, notes:"" };

  const openAcc = (a=null) => { setEditing(a?.id||null); setForm(a?{...a}:{...emptyAcc}); setModal(true); };
  const saveAcc = () => {
    if(editing) setCrmAccounts(as=>as.map(a=>a.id===editing?{...form,annualRevPotential:+form.annualRevPotential}:a));
    else setCrmAccounts(as=>[...as,{...form,id:"acc"+uid(),annualRevPotential:+form.annualRevPotential}]);
    setModal(false);
  };
  const openCon = (c=null, accountId=null) => {
    setEditingCon(c?.id||null);
    setConForm(c?{...c}:{...emptyCon, accountId: accountId||selected||""});
    setConModal(true);
  };
  const saveCon = () => {
    if(editingCon) setCrmContacts(cs=>cs.map(c=>c.id===editingCon?{...conForm}:c));
    else setCrmContacts(cs=>[...cs,{...conForm,id:"con"+uid()}]);
    setConModal(false);
  };

  const filtered = typeFilter==="all" ? crmAccounts : crmAccounts.filter(a=>a.type===typeFilter);
  const selAcc   = crmAccounts.find(a=>a.id===selected);
  const selCons  = crmContacts.filter(c=>c.accountId===selected);
  const selDeals = crmDeals.filter(d=>d.accountId===selected);
  const selActs  = [...crmActivities].filter(a=>a.accountId===selected).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);

  return (
    <div style={{display:"grid",gridTemplateColumns:selAcc?"3fr 2fr":"1fr",gap:16}}>
      <div>
        <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
          {["all","customer","prospect","partner","at-risk"].map(t=>(
            <button key={t} className="btn bg" style={{fontSize:11,padding:"5px 11px",
              borderColor:typeFilter===t?"#0284c7":"#1a2d45",color:typeFilter===t?"#38bdf8":"#475569"}}
              onClick={()=>setTypeFilter(t)}>
              {t==="all"?"All":t.charAt(0).toUpperCase()+t.slice(1)} ({crmAccounts.filter(a=>t==="all"||a.type===t).length})
            </button>
          ))}
          <button className="btn bp" style={{marginLeft:"auto",fontSize:12}} onClick={()=>openAcc()}><I d={ICONS.plus} s={13}/>Add Account</button>
        </div>

        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"1.6fr 100px 100px 110px 80px 70px",padding:"8px 18px"}}>
            {["Account","Industry","Type","Rev Potential","Health","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(a=>{
            const openDeals = crmDeals.filter(d=>d.accountId===a.id&&!["closed-won","closed-lost"].includes(d.stage)).length;
            const pendingActs = crmActivities.filter(ac=>ac.accountId===a.id&&!ac.completed).length;
            return (
              <div key={a.id} className="tr"
                style={{gridTemplateColumns:"1.6fr 100px 100px 110px 80px 70px",cursor:"pointer",
                  background:selected===a.id?"#0a1a2e":undefined}}
                onClick={()=>setSelected(selected===a.id?null:a.id)}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{a.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a",marginTop:1}}>{a.address}</div>
                  <div style={{display:"flex",gap:6,marginTop:3}}>
                    {openDeals>0&&<span className="bdg" style={{background:"#0c2340",color:"#7dd3fc",fontSize:9}}>{openDeals} deal{openDeals>1?"s":""}</span>}
                    {pendingActs>0&&<span className="bdg" style={{background:"#1a1005",color:"#f59e0b",fontSize:9}}>{pendingActs} action{pendingActs>1?"s":""}</span>}
                  </div>
                </div>
                <span style={{fontSize:11,color:"#64748b"}}>{a.industry}</span>
                <span className="bdg" style={{background:"#060d1c",color:ACCT_TYPE_C[a.type]||"#64748b",textTransform:"capitalize"}}>{a.type}</span>
                <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{fmt(a.annualRevPotential)}</span>
                <span className="bdg" style={{background:"#060d1c",color:HEALTH_COL[a.health]||"#64748b"}}>{a.health}</span>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  <button className="btn bg" style={{padding:"3px 7px",fontSize:10}} onClick={()=>openAcc(a)}><I d={ICONS.edit} s={11}/></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Account detail panel */}
      {selAcc && (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {/* Header */}
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:"#e2e8f0"}}>{selAcc.name}</div>
                <div style={{fontSize:11,color:"#3d5a7a"}}>{selAcc.industry} · {selAcc.address}</div>
              </div>
              <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              {[["Type",selAcc.type],["Health",selAcc.health],["Owner",selAcc.owner],["Rev Potential",fmt(selAcc.annualRevPotential)]].map(([l,v])=>(
                <div key={l}><div className="lbl">{l}</div><div style={{fontSize:12,color:"#94a3b8"}}>{v}</div></div>
              ))}
            </div>
            {selAcc.notes&&<div style={{fontSize:11,color:"#475569",lineHeight:1.5,borderTop:"1px solid #111d2d",paddingTop:10}}>{selAcc.notes}</div>}
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button className="btn bg" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>openAcc(selAcc)}>Edit Account</button>
              <button className="btn bp" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>openCon(null,selected)}>+ Contact</button>
            </div>
          </div>

          {/* Contacts */}
          <div className="card">
            <div className="section-hdr" style={{fontSize:12}}>Contacts ({selCons.length})</div>
            {selCons.map(c=>(
              <div key={c.id} className="tr" style={{gridTemplateColumns:"1fr auto",padding:"10px 16px"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",display:"flex",alignItems:"center",gap:6}}>
                    {c.name}
                    {c.isPrimary&&<span className="bdg" style={{background:"#0c2340",color:"#38bdf8",fontSize:8}}>PRIMARY</span>}
                  </div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{c.title}</div>
                  <div style={{fontSize:10,color:"#1e3a5f",marginTop:2}}>{c.email}</div>
                </div>
                <button className="btn bg" style={{padding:"2px 7px",fontSize:10}} onClick={()=>openCon(c)}>Edit</button>
              </div>
            ))}
            {selCons.length===0&&<div style={{padding:"14px 16px",fontSize:11,color:"#1e3a5f"}}>No contacts yet</div>}
          </div>

          {/* Open deals */}
          {selDeals.length>0&&(
            <div className="card">
              <div className="section-hdr" style={{fontSize:12}}>Deals ({selDeals.length})</div>
              {selDeals.map(d=>(
                <div key={d.id} style={{padding:"10px 16px",borderBottom:"1px solid #111d2d"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <span style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{d.name}</span>
                    <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:STAGE_COLORS[d.stage]}}>{fmt(d.value)}</span>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <span className="bdg" style={{background:STAGE_BG[d.stage],color:STAGE_COLORS[d.stage],fontSize:9,textTransform:"capitalize"}}>{d.stage}</span>
                    <span className="bdg" style={{background:"#060d1c",color:"#64748b",fontSize:9}}>{d.probability}% · {fmtDate(d.closeDate)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent activity */}
          {selActs.length>0&&(
            <div className="card">
              <div className="section-hdr" style={{fontSize:12}}>Recent Activity</div>
              {selActs.map(a=>(
                <div key={a.id} style={{padding:"9px 16px",borderBottom:"1px solid #0d1a2a"}}>
                  <div style={{fontSize:11,fontWeight:600,color:a.completed?"#3d5a7a":"#94a3b8"}}>{ACT_ICONS[a.type]} {a.subject}</div>
                  <div style={{fontSize:10,color:"#1e3a5f",marginTop:2}}>{fmtDate(a.date)} · {a.notes?.slice(0,60)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Account modal */}
      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:560}}>
            <MH title={editing?"Edit Account":"Add Account"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Account Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Verizon"/></FF>
              <FF label="Industry"><input className="inp" value={form.industry} onChange={e=>setForm({...form,industry:e.target.value})} placeholder="Telecom"/></FF>
              <FF label="Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
                {["prospect","customer","partner","at-risk"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Health"><select className="inp" value={form.health} onChange={e=>setForm({...form,health:e.target.value})}>
                {["green","amber","red"].map(h=><option key={h}>{h}</option>)}
              </select></FF>
              <FF label="Rev Potential ($/yr)"><input className="inp" type="number" value={form.annualRevPotential} onChange={e=>setForm({...form,annualRevPotential:e.target.value})}/></FF>
              <FF label="Website"><input className="inp" value={form.website} onChange={e=>setForm({...form,website:e.target.value})} placeholder="company.com"/></FF>
              <FF label="Phone"><input className="inp" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></FF>
              <FF label="Location"><input className="inp" value={form.address} onChange={e=>setForm({...form,address:e.target.value})} placeholder="Dallas, TX"/></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={3} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Strategic notes, relationship context…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveAcc}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Contact modal */}
      {conModal&&conForm&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setConModal(false)}>
          <div className="modal" style={{maxWidth:480}}>
            <MH title={editingCon?"Edit Contact":"Add Contact"} onClose={()=>setConModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Account"><select className="inp" value={conForm.accountId} onChange={e=>setConForm({...conForm,accountId:e.target.value})}>
                <option value="">Select…</option>{crmAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select></FF>
              <FF label="Name"><input className="inp" value={conForm.name} onChange={e=>setConForm({...conForm,name:e.target.value})} placeholder="James Wright"/></FF>
              <FF label="Title"><input className="inp" value={conForm.title} onChange={e=>setConForm({...conForm,title:e.target.value})} placeholder="VP SAP Delivery"/></FF>
              <FF label="Email"><input className="inp" type="email" value={conForm.email} onChange={e=>setConForm({...conForm,email:e.target.value})}/></FF>
              <FF label="Phone"><input className="inp" value={conForm.phone} onChange={e=>setConForm({...conForm,phone:e.target.value})}/></FF>
              <FF label="Is Primary?"><select className="inp" value={conForm.isPrimary} onChange={e=>setConForm({...conForm,isPrimary:e.target.value==="true"})}>
                <option value="false">No</option><option value="true">Yes — Primary</option>
              </select></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={conForm.notes} onChange={e=>setConForm({...conForm,notes:e.target.value})}/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setConModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveCon}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Deals ─────────────────────────────────────────────────────────────────────
function CRMDeals({ crmAccounts, crmContacts, crmDeals, setCrmDeals, crmActivities, setCrmActivities, addAudit }) {
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(null);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [stageFilter, setStageFilter] = useState("open");
  const [actModal, setActModal] = useState(false);
  const [actForm, setActForm]   = useState(null);

  const emptyDeal = { accountId:"", name:"", stage:"prospecting", value:"", closeDate:"", owner:"Manju", probability:25, type:"new", notes:"", nextStep:"" };
  const emptyAct  = { dealId:"", accountId:"", contactId:"", type:"email", date:new Date().toISOString().slice(0,10), subject:"", notes:"", completed:false };

  const openDeal = (d=null) => { setEditing(d?.id||null); setForm(d?{...d,value:String(d.value),probability:String(d.probability)}:{...emptyDeal}); setModal(true); };
  const saveDeal = () => {
    const d = {...form, value:+form.value, probability:+form.probability};
    if(editing) setCrmDeals(ds=>ds.map(x=>x.id===editing?d:x));
    else { setCrmDeals(ds=>[...ds,{...d,id:"deal"+uid()}]); addAudit&&addAudit("CRM","New Deal","CRM Deals",`Created deal: ${d.name}`,{value:d.value,stage:d.stage}); }
    setModal(false);
  };
  const openAct = (dealId, accountId) => {
    setActForm({...emptyAct, dealId, accountId});
    setActModal(true);
  };
  const saveAct = () => {
    setCrmActivities(as=>[...as,{...actForm,id:"act"+uid()}]);
    setActModal(false);
  };
  const advanceStage = (id) => {
    setCrmDeals(ds=>ds.map(d=>{
      if(d.id!==id) return d;
      const idx = STAGE_ORDER.indexOf(d.stage);
      const next = STAGE_ORDER[Math.min(idx+1, STAGE_ORDER.length-1)];
      const probs = { prospecting:15, qualified:30, proposal:55, negotiation:75, "closed-won":100, "closed-lost":0 };
      return {...d, stage:next, probability:probs[next]};
    }));
  };

  const filtered = stageFilter==="open"
    ? crmDeals.filter(d=>!["closed-won","closed-lost"].includes(d.stage))
    : stageFilter==="won" ? crmDeals.filter(d=>d.stage==="closed-won")
    : stageFilter==="lost" ? crmDeals.filter(d=>d.stage==="closed-lost")
    : crmDeals;

  const selDeal   = crmDeals.find(d=>d.id===selected);
  const selAcc    = selDeal ? crmAccounts.find(a=>a.id===selDeal.accountId) : null;
  const selDealActs = selected ? [...crmActivities].filter(a=>a.dealId===selected).sort((a,b)=>b.date.localeCompare(a.date)) : [];

  return (
    <div style={{display:"grid",gridTemplateColumns:selDeal?"3fr 2fr":"1fr",gap:16}}>
      <div>
        <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center"}}>
          {[["open","Open"],["won","Won"],["lost","Lost"],["all","All"]].map(([v,l])=>(
            <button key={v} className="btn bg" style={{fontSize:11,padding:"5px 11px",
              borderColor:stageFilter===v?"#0284c7":"#1a2d45",color:stageFilter===v?"#38bdf8":"#475569"}}
              onClick={()=>setStageFilter(v)}>{l}</button>
          ))}
          <button className="btn bp" style={{marginLeft:"auto",fontSize:12}} onClick={()=>openDeal()}><I d={ICONS.plus} s={13}/>New Deal</button>
        </div>

        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"2fr 1.2fr 80px 100px 90px 90px 100px",padding:"8px 18px"}}>
            {["Deal / Account","Stage","Type","Value","Probability","Close Date","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(d=>{
            const acc = crmAccounts.find(a=>a.id===d.accountId);
            return (
              <div key={d.id} className="tr"
                style={{gridTemplateColumns:"2fr 1.2fr 80px 100px 90px 90px 100px",cursor:"pointer",
                  background:selected===d.id?"#0a1a2e":undefined}}
                onClick={()=>setSelected(selected===d.id?null:d.id)}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{d.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{acc?.name}</div>
                  {d.nextStep&&<div style={{fontSize:10,color:"#1e3a5f",marginTop:2}}>⟶ {d.nextStep.slice(0,50)}</div>}
                </div>
                <span className="bdg" style={{background:STAGE_BG[d.stage],color:STAGE_COLORS[d.stage],textTransform:"capitalize",fontSize:10}}>{d.stage}</span>
                <span className="bdg" style={{background:"#060d1c",color:TYPE_COLORS[d.type]||"#64748b",fontSize:10}}>{d.type}</span>
                <span style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:STAGE_COLORS[d.stage]}}>{fmt(d.value)}</span>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#94a3b8"}}>{d.probability}%</div>
                  <div style={{height:4,background:"#0a1626",borderRadius:2,marginTop:3,width:55}}>
                    <div style={{height:4,borderRadius:2,background:STAGE_COLORS[d.stage],width:`${d.probability}%`}}/>
                  </div>
                </div>
                <span style={{fontSize:11,color:"#475569"}}>{fmtDate(d.closeDate)}</span>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  <button className="btn bg" style={{padding:"3px 7px",fontSize:10}} onClick={()=>openDeal(d)}><I d={ICONS.edit} s={11}/></button>
                  {!["closed-won","closed-lost"].includes(d.stage)&&
                    <button className="btn bs" style={{padding:"3px 6px",fontSize:10}} title="Advance stage" onClick={()=>advanceStage(d.id)}>▶</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Deal detail panel */}
      {selDeal&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="card" style={{padding:"16px 18px"}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",lineHeight:1.3}}>{selDeal.name}</div>
                <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>{selAcc?.name} · {selAcc?.industry}</div>
              </div>
              <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
            </div>

            {/* Stage progress bar */}
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",gap:2,marginBottom:6}}>
                {["prospecting","qualified","proposal","negotiation","closed-won"].map(s=>{
                  const idx = STAGE_ORDER.indexOf(s);
                  const cur = STAGE_ORDER.indexOf(selDeal.stage);
                  const past = idx <= cur;
                  return <div key={s} style={{flex:1,height:5,borderRadius:2,background:past?STAGE_COLORS[s]:"#1a2d45",transition:"background 0.3s"}}/>;
                })}
              </div>
              <div style={{fontSize:10,color:STAGE_COLORS[selDeal.stage],fontWeight:700,textTransform:"capitalize"}}>{selDeal.stage}</div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              {[["Value",fmt(selDeal.value)],["Probability",selDeal.probability+"%"],["Close",fmtDate(selDeal.closeDate)],["Type",selDeal.type]].map(([l,v])=>(
                <div key={l}><div className="lbl">{l}</div><div style={{fontSize:12,color:"#94a3b8"}}>{v}</div></div>
              ))}
            </div>
            {selDeal.notes&&<div style={{fontSize:11,color:"#475569",lineHeight:1.5,borderTop:"1px solid #111d2d",paddingTop:10,marginBottom:10}}>{selDeal.notes}</div>}
            {selDeal.nextStep&&<div style={{background:"#0c1e10",border:"1px solid #1a3d20",borderRadius:8,padding:"8px 12px",fontSize:11,color:"#86efac"}}>⟶ Next: {selDeal.nextStep}</div>}

            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button className="btn bg" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>openDeal(selDeal)}>Edit</button>
              <button className="btn bp" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>openAct(selDeal.id, selDeal.accountId)}>+ Activity</button>
              {!["closed-won","closed-lost"].includes(selDeal.stage)&&
                <button className="btn bs" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>advanceStage(selDeal.id)}>▶ Advance</button>}
            </div>
            <div style={{display:"flex",gap:8,marginTop:8}}>
              <button className="btn bs" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>setCrmDeals(ds=>ds.map(d=>d.id===selDeal.id?{...d,stage:"closed-won",probability:100}:d))}>✓ Won</button>
              <button className="btn br" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>setCrmDeals(ds=>ds.map(d=>d.id===selDeal.id?{...d,stage:"closed-lost",probability:0}:d))}>✗ Lost</button>
            </div>
          </div>

          {/* Activity timeline */}
          <div className="card">
            <div className="section-hdr" style={{fontSize:12}}>Activity Timeline ({selDealActs.length})</div>
            {selDealActs.map(a=>(
              <div key={a.id} style={{padding:"10px 16px",borderBottom:"1px solid #0d1a2a",opacity:a.completed?0.5:1}}>
                <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                  <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{ACT_ICONS[a.type]}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:600,color:a.completed?"#3d5a7a":"#cbd5e1"}}>{a.subject}</div>
                    <div style={{fontSize:10,color:"#1e3a5f",marginTop:2}}>{fmtDate(a.date)}</div>
                    {a.notes&&<div style={{fontSize:10,color:"#475569",marginTop:3,lineHeight:1.4}}>{a.notes}</div>}
                  </div>
                  <span className="bdg" style={{background:a.completed?"#021f14":"#1a1005",color:a.completed?"#34d399":"#f59e0b",fontSize:9}}>{a.completed?"Done":"Open"}</span>
                </div>
              </div>
            ))}
            {selDealActs.length===0&&<div style={{padding:"14px 16px",fontSize:11,color:"#1e3a5f"}}>No activities yet — log a call, email, or meeting.</div>}
          </div>
        </div>
      )}

      {/* Deal modal */}
      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:560}}>
            <MH title={editing?"Edit Deal":"New Deal"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Account"><select className="inp" value={form.accountId} onChange={e=>setForm({...form,accountId:e.target.value})}>
                <option value="">Select account…</option>{crmAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select></FF>
              <FF label="Deal Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Verizon BRIM Phase 1"/></FF>
              <FF label="Stage"><select className="inp" value={form.stage} onChange={e=>setForm({...form,stage:e.target.value})}>
                {STAGE_ORDER.map(s=><option key={s} value={s}>{s}</option>)}
              </select></FF>
              <FF label="Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
                {["new","expansion","renewal","partner"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Value ($)"><input className="inp" type="number" value={form.value} onChange={e=>setForm({...form,value:e.target.value})}/></FF>
              <FF label="Probability (%)"><input className="inp" type="number" min={0} max={100} value={form.probability} onChange={e=>setForm({...form,probability:e.target.value})}/></FF>
              <FF label="Expected Close"><input className="inp" type="date" value={form.closeDate} onChange={e=>setForm({...form,closeDate:e.target.value})}/></FF>
              <FF label="Owner"><input className="inp" value={form.owner} onChange={e=>setForm({...form,owner:e.target.value})}/></FF>
            </div>
            <FF label="Next Step"><input className="inp" value={form.nextStep} onChange={e=>setForm({...form,nextStep:e.target.value})} placeholder="Send proposal by Mar 25…"/></FF>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Deal context, risks, history…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveDeal}><I d={ICONS.check} s={13}/>Save Deal</button>
            </div>
          </div>
        </div>
      )}

      {/* Activity modal */}
      {actModal&&actForm&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setActModal(false)}>
          <div className="modal" style={{maxWidth:480}}>
            <MH title="Log Activity" onClose={()=>setActModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Type"><select className="inp" value={actForm.type} onChange={e=>setActForm({...actForm,type:e.target.value})}>
                {["email","call","meeting","note","task"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Contact"><select className="inp" value={actForm.contactId} onChange={e=>setActForm({...actForm,contactId:e.target.value})}>
                <option value="">Select…</option>
                {crmContacts.filter(c=>c.accountId===actForm.accountId).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Date"><input className="inp" type="date" value={actForm.date} onChange={e=>setActForm({...actForm,date:e.target.value})}/></FF>
              <FF label="Status"><select className="inp" value={actForm.completed} onChange={e=>setActForm({...actForm,completed:e.target.value==="true"})}>
                <option value="false">Open / Upcoming</option><option value="true">Completed</option>
              </select></FF>
            </div>
            <FF label="Subject"><input className="inp" value={actForm.subject} onChange={e=>setActForm({...actForm,subject:e.target.value})} placeholder="SOW review call with James Wright"/></FF>
            <FF label="Notes"><textarea className="inp" rows={2} value={actForm.notes} onChange={e=>setActForm({...actForm,notes:e.target.value})} placeholder="What was discussed, next steps…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setActModal(false)}>Cancel</button>
              <button className="btn bp" onClick={saveAct}><I d={ICONS.check} s={13}/>Log Activity</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Activities ────────────────────────────────────────────────────────────────
function CRMActivities({ crmAccounts, crmContacts, crmDeals, crmActivities, setCrmActivities }) {
  const [filter, setFilter] = useState("open");
  const [typeFilter, setTypeFilter] = useState("all");
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(null);

  const empty = { dealId:"", accountId:"", contactId:"", type:"email", date:new Date().toISOString().slice(0,10), subject:"", notes:"", completed:false };
  const save = () => { setCrmActivities(as=>[...as,{...form,id:"act"+uid()}]); setModal(false); };
  const toggle = id => setCrmActivities(as=>as.map(a=>a.id===id?{...a,completed:!a.completed}:a));
  const del    = id => setCrmActivities(as=>as.filter(a=>a.id!==id));

  const byStatus = filter==="open" ? crmActivities.filter(a=>!a.completed)
    : filter==="done" ? crmActivities.filter(a=>a.completed) : crmActivities;
  const byType = typeFilter==="all" ? byStatus : byStatus.filter(a=>a.type===typeFilter);
  const sorted = [...byType].sort((a,b)=>a.date.localeCompare(b.date));

  const overdue  = crmActivities.filter(a=>!a.completed&&a.date<TODAY_STR).length;
  const today    = crmActivities.filter(a=>!a.completed&&a.date===TODAY_STR).length;
  const upcoming = crmActivities.filter(a=>!a.completed&&a.date>TODAY_STR).length;
  const done     = crmActivities.filter(a=>a.completed).length;

  return (
    <div>
      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:18}}>
        {[{l:"Overdue",v:overdue,c:"#f87171"},{l:"Due Today",v:today,c:"#f59e0b"},{l:"Upcoming",v:upcoming,c:"#38bdf8"},{l:"Completed",v:done,c:"#34d399"}].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 16px"}}>
            <div className="th" style={{marginBottom:3}}>{k.l}</div>
            <div style={{fontSize:24,fontWeight:800,color:k.c}}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Filters + add */}
      <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
        {[["open","Open"],["done","Done"],["all","All"]].map(([v,l])=>(
          <button key={v} className="btn bg" style={{fontSize:11,padding:"5px 11px",borderColor:filter===v?"#0284c7":"#1a2d45",color:filter===v?"#38bdf8":"#475569"}} onClick={()=>setFilter(v)}>{l}</button>
        ))}
        <div style={{width:1,height:20,background:"#1a2d45",margin:"0 4px"}}/>
        {["all","email","call","meeting","note","task"].map(t=>(
          <button key={t} className="btn bg" style={{fontSize:11,padding:"5px 10px",borderColor:typeFilter===t?"#0284c7":"#1a2d45",color:typeFilter===t?"#38bdf8":"#475569"}} onClick={()=>setTypeFilter(t)}>
            {t==="all"?"All Types":`${ACT_ICONS[t]} ${t}`}
          </button>
        ))}
        <button className="btn bp" style={{marginLeft:"auto",fontSize:12}} onClick={()=>{setForm({...empty});setModal(true);}}>
          <I d={ICONS.plus} s={13}/>Log Activity
        </button>
      </div>

      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"28px 100px 80px 1fr 1.2fr 100px 80px",padding:"8px 18px"}}>
          {["","Date","Type","Subject / Notes","Account · Deal","Contact","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {sorted.map(a=>{
          const acc  = crmAccounts.find(x=>x.id===a.accountId);
          const deal = crmDeals.find(x=>x.id===a.dealId);
          const con  = crmContacts.find(x=>x.id===a.contactId);
          const isOverdue = !a.completed && a.date <TODAY_STR;
          return (
            <div key={a.id} className="tr"
              style={{gridTemplateColumns:"28px 100px 80px 1fr 1.2fr 100px 80px",
                opacity:a.completed?0.55:1,
                background:isOverdue?"#110806":undefined}}>
              <button onClick={()=>toggle(a.id)}
                style={{width:20,height:20,borderRadius:"50%",flexShrink:0,
                  background:a.completed?"#034d2f":"#0a1626",
                  border:`2px solid ${a.completed?"#34d399":isOverdue?"#f87171":"#1e3a5f"}`,
                  cursor:"pointer",fontSize:10,color:"#34d399",display:"flex",alignItems:"center",justifyContent:"center"}}>
                {a.completed?"✓":""}
              </button>
              <span style={{fontSize:11,color:isOverdue?"#f87171":"#64748b"}}>{fmtDate(a.date)}</span>
              <span style={{fontSize:12}}>{ACT_ICONS[a.type]} <span style={{fontSize:10,color:"#475569"}}>{a.type}</span></span>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{a.subject}</div>
                {a.notes&&<div style={{fontSize:10,color:"#3d5a7a",marginTop:1,lineHeight:1.3}}>{a.notes.slice(0,70)}</div>}
              </div>
              <div>
                <div style={{fontSize:11,color:"#7dd3fc"}}>{acc?.name||"—"}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{deal?.name?.slice(0,35)}</div>
              </div>
              <span style={{fontSize:11,color:"#475569"}}>{con?.name||"—"}</span>
              <div style={{display:"flex",gap:4}}>
                <span className="bdg" style={{background:a.completed?"#021f14":"#1a1005",color:a.completed?"#34d399":"#f59e0b",fontSize:9}}>{a.completed?"Done":"Open"}</span>
                <button className="btn br" style={{padding:"2px 5px",fontSize:9}} onClick={()=>del(a.id)}>✕</button>
              </div>
            </div>
          );
        })}
      </div>

      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:500}}>
            <MH title="Log Activity" onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Account"><select className="inp" value={form.accountId} onChange={e=>setForm({...form,accountId:e.target.value,contactId:""})}>
                <option value="">Select…</option>{crmAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select></FF>
              <FF label="Deal"><select className="inp" value={form.dealId} onChange={e=>setForm({...form,dealId:e.target.value})}>
                <option value="">Select…</option>{crmDeals.filter(d=>d.accountId===form.accountId).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
              </select></FF>
              <FF label="Contact"><select className="inp" value={form.contactId} onChange={e=>setForm({...form,contactId:e.target.value})}>
                <option value="">Select…</option>{crmContacts.filter(c=>c.accountId===form.accountId).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></FF>
              <FF label="Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
                {["email","call","meeting","note","task"].map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Date"><input className="inp" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></FF>
              <FF label="Status"><select className="inp" value={form.completed} onChange={e=>setForm({...form,completed:e.target.value==="true"})}>
                <option value="false">Open</option><option value="true">Completed</option>
              </select></FF>
            </div>
            <FF label="Subject"><input className="inp" value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})} placeholder="Brief subject…"/></FF>
            <FF label="Notes"><textarea className="inp" rows={3} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="What happened, what's next…"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Log</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Forecast ──────────────────────────────────────────────────────────────────
function CRMForecast({ crmAccounts, crmDeals, crmActivities }) {
  const [view, setView] = useState("quarter"); // quarter | stage | type | account

  const open = crmDeals.filter(d=>!["closed-won","closed-lost"].includes(d.stage));
  const won  = crmDeals.filter(d=>d.stage==="closed-won");
  const lost = crmDeals.filter(d=>d.stage==="closed-lost");

  const pipeline  = open.reduce((s,d)=>s+d.value,0);
  const weighted  = open.reduce((s,d)=>s+d.value*(d.probability/100),0);
  const wonVal    = won.reduce((s,d)=>s+d.value,0);
  const lostVal   = lost.reduce((s,d)=>s+d.value,0);
  const winRate   = (won.length+lost.length)>0 ? won.length/(won.length+lost.length) : 0;
  const avgDeal   = open.length>0 ? pipeline/open.length : 0;

  // By quarter buckets
  const byQ = {};
  crmDeals.forEach(d=>{
    if(["closed-won","closed-lost"].includes(d.stage)) return;
    const q = "Q"+Math.ceil((new Date(d.closeDate+"T00:00:00").getMonth()+1)/3)+" 2026";
    if(!byQ[q]) byQ[q]={pipeline:0,weighted:0,deals:[]};
    byQ[q].pipeline += d.value;
    byQ[q].weighted += d.value*(d.probability/100);
    byQ[q].deals.push(d);
  });

  // By stage
  const byStage = {};
  STAGE_ORDER.filter(s=>!["closed-won","closed-lost"].includes(s)).forEach(s=>{
    const deals = open.filter(d=>d.stage===s);
    byStage[s] = { total: deals.reduce((x,d)=>x+d.value,0), count: deals.length, weighted: deals.reduce((x,d)=>x+d.value*(d.probability/100),0) };
  });

  // By account
  const byAccount = {};
  open.forEach(d=>{
    if(!byAccount[d.accountId]) byAccount[d.accountId]={pipeline:0,weighted:0,deals:0};
    byAccount[d.accountId].pipeline+=d.value;
    byAccount[d.accountId].weighted+=d.value*(d.probability/100);
    byAccount[d.accountId].deals++;
  });

  const maxPipe = Math.max(...Object.values(byQ).map(q=>q.pipeline), 1);

  return (
    <div>
      {/* KPI row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Open Pipeline",    v:fmt(pipeline),   c:"#38bdf8"},
          {l:"Weighted Forecast",v:fmt(weighted),   c:"#7dd3fc"},
          {l:"Closed Won",       v:fmt(wonVal),     c:"#34d399"},
          {l:"Closed Lost",      v:fmt(lostVal),    c:"#f87171"},
          {l:"Win Rate",         v:pct(winRate),    c:winRate>0.5?"#34d399":"#f59e0b"},
          {l:"Avg Deal Size",    v:fmt(avgDeal),    c:"#a78bfa"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:3}}>{k.l}</div>
            <div style={{fontSize:18,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* View toggle */}
      <div style={{display:"flex",gap:4,marginBottom:18,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {[["quarter","By Quarter"],["stage","By Stage"],["account","By Account"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)}
            style={{padding:"6px 14px",borderRadius:7,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,
              background:view===v?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:view===v?"#fff":"#475569"}}>
            {l}
          </button>
        ))}
      </div>

      {view==="quarter"&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
          {Object.entries(byQ).sort(([a],[b])=>a.localeCompare(b)).map(([q,data])=>(
            <div key={q} className="card" style={{padding:"16px 18px"}}>
              <div style={{fontSize:16,fontWeight:800,color:"#38bdf8",marginBottom:12}}>{q}</div>
              <div style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,color:"#64748b"}}>Pipeline</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#38bdf8",fontFamily:"'DM Mono',monospace"}}>{fmt(data.pipeline)}</span>
                </div>
                <div style={{height:8,background:"#0a1626",borderRadius:4}}>
                  <div style={{height:8,borderRadius:4,background:"#38bdf8",width:`${(data.pipeline/maxPipe)*100}%`}}/>
                </div>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,color:"#64748b"}}>Weighted</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#7dd3fc",fontFamily:"'DM Mono',monospace"}}>{fmt(data.weighted)}</span>
                </div>
                <div style={{height:8,background:"#0a1626",borderRadius:4}}>
                  <div style={{height:8,borderRadius:4,background:"#7dd3fc",width:`${(data.weighted/maxPipe)*100}%`}}/>
                </div>
              </div>
              <div style={{borderTop:"1px solid #111d2d",paddingTop:10}}>
                {data.deals.map(d=>(
                  <div key={d.id} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #0a1626"}}>
                    <span style={{fontSize:11,color:"#475569",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginRight:8}}>{d.name.slice(0,28)}</span>
                    <span style={{fontSize:11,fontWeight:600,color:STAGE_COLORS[d.stage],fontFamily:"'DM Mono',monospace",flexShrink:0}}>{fmt(d.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {view==="stage"&&(
        <div className="card">
          <div className="section-hdr">Pipeline by Stage</div>
          <div className="tr" style={{gridTemplateColumns:"130px 1fr 110px 110px 60px",padding:"8px 18px"}}>
            {["Stage","Visual","Pipeline","Weighted","Deals"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {Object.entries(byStage).map(([stage,data])=>{
            const maxS = Math.max(...Object.values(byStage).map(x=>x.total),1);
            return (
              <div key={stage} className="tr" style={{gridTemplateColumns:"130px 1fr 110px 110px 60px"}}>
                <span className="bdg" style={{background:STAGE_BG[stage],color:STAGE_COLORS[stage],textTransform:"capitalize"}}>{stage}</span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{flex:1,height:10,background:"#0a1626",borderRadius:5,maxWidth:200}}>
                    <div style={{height:10,borderRadius:5,background:STAGE_COLORS[stage],width:`${(data.total/maxS)*100}%`,transition:"width 0.4s"}}/>
                  </div>
                </div>
                <span style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:STAGE_COLORS[stage]}}>{fmt(data.total)}</span>
                <span style={{fontSize:12,color:"#64748b",fontFamily:"'DM Mono',monospace"}}>{fmt(data.weighted)}</span>
                <span style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>{data.count}</span>
              </div>
            );
          })}
          <div className="tr" style={{gridTemplateColumns:"130px 1fr 110px 110px 60px",background:"#080f1e",borderTop:"1px solid #1a2d45"}}>
            <span style={{fontSize:11,fontWeight:700,color:"#3d5a7a",textTransform:"uppercase"}}>TOTAL OPEN</span>
            <div/>
            <span style={{fontSize:14,fontWeight:800,fontFamily:"'DM Mono',monospace",color:"#38bdf8"}}>{fmt(pipeline)}</span>
            <span style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{fmt(weighted)}</span>
            <span style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>{open.length}</span>
          </div>
        </div>
      )}

      {view==="account"&&(
        <div className="card">
          <div className="section-hdr">Pipeline by Account</div>
          <div className="tr" style={{gridTemplateColumns:"1.5fr 1fr 110px 110px 60px",padding:"8px 18px"}}>
            {["Account","Industry","Pipeline","Weighted","Deals"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {Object.entries(byAccount)
            .sort(([,a],[,b])=>b.pipeline-a.pipeline)
            .map(([accId,data])=>{
              const acc = crmAccounts.find(a=>a.id===accId);
              const maxA = Math.max(...Object.values(byAccount).map(x=>x.pipeline),1);
              return (
                <div key={accId} className="tr" style={{gridTemplateColumns:"1.5fr 1fr 110px 110px 60px"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{acc?.name}</div>
                    <div style={{height:4,background:"#0a1626",borderRadius:2,marginTop:5,maxWidth:120}}>
                      <div style={{height:4,borderRadius:2,background:"#38bdf8",width:`${(data.pipeline/maxA)*100}%`}}/>
                    </div>
                  </div>
                  <span style={{fontSize:11,color:"#475569"}}>{acc?.industry}</span>
                  <span style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:"#38bdf8"}}>{fmt(data.pipeline)}</span>
                  <span style={{fontSize:12,color:"#7dd3fc",fontFamily:"'DM Mono',monospace"}}>{fmt(data.weighted)}</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>{data.deals}</span>
                </div>
              );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACTS & SOW MODULE
// ═══════════════════════════════════════════════════════════════════════════════
const CONTRACT_STATUS_C = { active:"#34d399", pending:"#f59e0b", expiring:"#fb923c", draft:"#7dd3fc", expired:"#f87171", terminated:"#64748b" };
const CONTRACT_STATUS_B = { active:"#021f14", pending:"#1a1005", expiring:"#1a0d05", draft:"#0c2340", expired:"#1a0808", terminated:"#0a1626" };
const CONTRACT_TYPES = ["MSA","SOW","NDA","Partner","Amendment","MSA Amendment","PO","Other"];
const MILESTONE_S_C   = { complete:"#34d399", "in-progress":"#f59e0b", pending:"#475569", blocked:"#f87171" };

function ContractsModule({ contracts, setContracts, sows, setSows, crmAccounts, crmDeals, roster }) {
  const [sub, setSub] = useState("overview");
  const tabs = [
    { id:"overview",   label:"Overview" },
    { id:"contracts",  label:"Contracts" },
    { id:"sow",        label:"SOW & Milestones" },
    { id:"builder",    label:"SOW Builder" },
  ];
  const props = { contracts, setContracts, sows, setSows, crmAccounts, crmDeals, roster };
  return (
    <div>
      <PH title="Contracts & SOW" sub="MSA · SOW · NDA · Milestones · SOW Builder"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {sub==="overview"  && <ContractsOverview {...props}/>}
      {sub==="contracts" && <ContractsList     {...props}/>}
      {sub==="sow"       && <SOWView           {...props}/>}
      {sub==="builder"   && <SOWBuilder        {...props}/>}
    </div>
  );
}

function ContractsOverview({ contracts, sows, crmAccounts }) {
  const active   = contracts.filter(c=>c.status==="active").length;
  const pending  = contracts.filter(c=>c.status==="pending").length;
  const expiring = contracts.filter(c=>c.status==="expiring").length;
  const drafts   = contracts.filter(c=>c.status==="draft").length;
  const totalCV  = contracts.filter(c=>c.status==="active").reduce((s,c)=>s+c.value,0);
  const sowActive= sows.filter(s=>s.status==="active").length;

  // Upcoming renewals — sort by endDate
  const upcoming = [...contracts]
    .filter(c=>["active","expiring"].includes(c.status))
    .sort((a,b)=>a.endDate.localeCompare(b.endDate))
    .slice(0,6);

  // Milestone status
  const allMilestones = sows.flatMap(s=>s.milestones);
  const mComplete  = allMilestones.filter(m=>m.status==="complete").length;
  const mPending   = allMilestones.filter(m=>m.status==="pending").length;
  const mBlocked   = allMilestones.filter(m=>m.status==="blocked").length;
  const mInProg    = allMilestones.filter(m=>m.status==="in-progress").length;
  const milestoneVal = allMilestones.reduce((s,m)=>s+m.value,0);
  const earnedVal    = allMilestones.filter(m=>m.status==="complete").reduce((s,m)=>s+m.value,0);

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Active Contracts", v:active,     c:"#34d399"},
          {l:"Pending Signature",v:pending,    c:"#f59e0b"},
          {l:"Expiring Soon",    v:expiring,   c:"#fb923c"},
          {l:"Drafts",           v:drafts,     c:"#7dd3fc"},
          {l:"Contract Value",   v:fmt(totalCV),c:"#38bdf8"},
          {l:"Active SOWs",      v:sowActive,  c:"#a78bfa"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:22,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:16,marginBottom:16}}>
        {/* Renewal timeline */}
        <div className="card">
          <div className="section-hdr">Renewal & Expiry Timeline</div>
          <div className="tr" style={{gridTemplateColumns:"1.5fr 90px 100px 80px 80px",padding:"8px 18px"}}>
            {["Contract","Type","Expires","Value","Status"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {upcoming.map(c=>{
            const acc = crmAccounts.find(a=>a.id===c.accountId);
            const daysLeft = Math.floor((new Date(c.endDate+"T00:00:00")-new Date("2026-03-11T00:00:00"))/86400000);
            const urgColor = daysLeft<=60?"#f87171":daysLeft<=120?"#f59e0b":"#34d399";
            return (
              <div key={c.id} className="tr" style={{gridTemplateColumns:"1.5fr 90px 100px 80px 80px"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{acc?.name}</div>
                </div>
                <span className="bdg" style={{background:"#0a1626",color:"#7dd3fc",fontSize:9}}>{c.type}</span>
                <div>
                  <div style={{fontSize:11,color:urgColor}}>{fmtDate(c.endDate)}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{daysLeft>0?`${daysLeft}d left`:"EXPIRED"}</div>
                </div>
                <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{c.value>0?fmt(c.value):"—"}</span>
                <span className="bdg" style={{background:CONTRACT_STATUS_B[c.status],color:CONTRACT_STATUS_C[c.status],fontSize:9}}>{c.status}</span>
              </div>
            );
          })}
        </div>

        {/* Milestone health */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div className="section-hdr" style={{padding:"0 0 14px",border:"none"}}>SOW Milestone Health</div>
          <div style={{marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:12,color:"#64748b"}}>Revenue earned</span>
              <span style={{fontSize:13,fontWeight:700,color:"#34d399",fontFamily:"'DM Mono',monospace"}}>{fmt(earnedVal)}</span>
            </div>
            <div style={{height:8,background:"#0a1626",borderRadius:4}}>
              <div style={{height:8,borderRadius:4,background:"#34d399",width:`${milestoneVal>0?(earnedVal/milestoneVal)*100:0}%`,transition:"width 0.4s"}}/>
            </div>
            <div style={{fontSize:10,color:"#3d5a7a",marginTop:4}}>of {fmt(milestoneVal)} total SOW value</div>
          </div>
          {[
            {l:"Complete",    v:mComplete, c:"#34d399"},
            {l:"In Progress", v:mInProg,   c:"#f59e0b"},
            {l:"Pending",     v:mPending,  c:"#475569"},
            {l:"Blocked",     v:mBlocked,  c:"#f87171"},
          ].map(m=>(
            <div key={m.l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #0a1626"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:m.c}}/>
                <span style={{fontSize:12,color:"#94a3b8"}}>{m.l}</span>
              </div>
              <span style={{fontSize:14,fontWeight:700,color:m.c}}>{m.v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Pending action items */}
      <div className="card">
        <div className="section-hdr" style={{color:"#f59e0b"}}>⚡ Action Required</div>
        {contracts.filter(c=>["pending","draft","expiring"].includes(c.status)).map(c=>{
          const acc = crmAccounts.find(a=>a.id===c.accountId);
          const msg = c.status==="pending"?"Awaiting countersignature":c.status==="draft"?"Needs legal review & signature":"Renewal negotiation required";
          return (
            <div key={c.id} className="tr" style={{gridTemplateColumns:"1.5fr 1fr 1fr 90px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{acc?.name} · {fmtDate(c.endDate)}</div>
              </div>
              <span style={{fontSize:11,color:"#f59e0b"}}>{msg}</span>
              <span style={{fontSize:11,color:"#475569"}}>{c.notes?.slice(0,60)}</span>
              <span className="bdg" style={{background:CONTRACT_STATUS_B[c.status],color:CONTRACT_STATUS_C[c.status]}}>{c.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContractsList({ contracts, setContracts, crmAccounts, crmDeals }) {
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(null);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);

  const empty = { accountId:"", dealId:"", name:"", type:"MSA", status:"draft", value:0, startDate:"", endDate:"", signedDate:"", counterparty:"", owner:"Manju", renewalAlert:60, notes:"", fileName:"" };
  const open = (c=null) => { setEditing(c?.id||null); setForm(c?{...c}:{...empty}); setModal(true); };
  const save = () => {
    const f = {...form, value:+form.value, renewalAlert:+form.renewalAlert};
    if(editing) setContracts(cs=>cs.map(c=>c.id===editing?f:c));
    else { setContracts(cs=>[...cs,{...f,id:"con"+uid()}]); addAudit&&addAudit("Contracts","New Contract","Contracts",`Created: ${f.title||f.name||"contract"}`,{client:f.clientId}); }
    setModal(false);
  };
  const del = id => { setContracts(cs=>cs.filter(c=>c.id!==id)); if(selected===id) setSelected(null); };

  const filtered = filter==="all" ? contracts : contracts.filter(c=>c.status===filter);
  const selC     = contracts.find(c=>c.id===selected);
  const selAcc   = selC ? crmAccounts.find(a=>a.id===selC.accountId) : null;
  const selDeal  = selC ? crmDeals.find(d=>d.id===selC.dealId) : null;

  return (
    <div style={{display:"grid",gridTemplateColumns:selC?"3fr 2fr":"1fr",gap:16}}>
      <div>
        <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
          {["all","active","pending","expiring","draft","expired"].map(s=>(
            <button key={s} className="btn bg" style={{fontSize:11,padding:"5px 10px",
              borderColor:filter===s?"#0284c7":"#1a2d45",color:filter===s?"#38bdf8":"#475569"}}
              onClick={()=>setFilter(s)}>
              {s.charAt(0).toUpperCase()+s.slice(1)} ({contracts.filter(c=>s==="all"||c.status===s).length})
            </button>
          ))}
          <button className="btn bp" style={{marginLeft:"auto",fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>New Contract</button>
        </div>
        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"2fr 80px 90px 100px 100px 80px 70px",padding:"8px 18px"}}>
            {["Contract","Type","Account","Value","Expires","Status","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(c=>{
            const acc = crmAccounts.find(a=>a.id===c.accountId);
            const daysLeft = Math.floor((new Date(c.endDate+"T00:00:00")-new Date("2026-03-11T00:00:00"))/86400000);
            return (
              <div key={c.id} className="tr"
                style={{gridTemplateColumns:"2fr 80px 90px 100px 100px 80px 70px",cursor:"pointer",
                  background:selected===c.id?"#0a1a2e":undefined}}
                onClick={()=>setSelected(selected===c.id?null:c.id)}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{c.counterparty}</div>
                </div>
                <span className="bdg" style={{background:"#0a1626",color:"#7dd3fc",fontSize:9}}>{c.type}</span>
                <span style={{fontSize:11,color:"#64748b"}}>{acc?.name||"—"}</span>
                <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{c.value>0?fmt(c.value):"—"}</span>
                <div>
                  <div style={{fontSize:11,color:daysLeft<=60?"#f87171":daysLeft<=120?"#f59e0b":"#64748b"}}>{fmtDate(c.endDate)}</div>
                  {c.endDate&&<div style={{fontSize:9,color:"#3d5a7a"}}>{daysLeft>0?`${daysLeft}d`:"PAST"}</div>}
                </div>
                <span className="bdg" style={{background:CONTRACT_STATUS_B[c.status],color:CONTRACT_STATUS_C[c.status],fontSize:9}}>{c.status}</span>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  <button className="btn bg" style={{padding:"3px 7px",fontSize:10}} onClick={()=>open(c)}><I d={ICONS.edit} s={11}/></button>
                  <button className="btn br" style={{padding:"3px 7px",fontSize:10}} onClick={()=>del(c.id)}><I d={ICONS.trash} s={11}/></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail panel */}
      {selC && (
        <div className="card" style={{height:"fit-content",position:"sticky",top:0}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #111d2d",display:"flex",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",lineHeight:1.3}}>{selC.name}</div>
              <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>{selC.counterparty}</div>
            </div>
            <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
          </div>
          <div style={{padding:"16px 18px"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[["Type",selC.type],["Status",selC.status],["Account",selAcc?.name||"—"],["Value",selC.value>0?fmt(selC.value):"—"],["Start",fmtDate(selC.startDate)],["Expires",fmtDate(selC.endDate)],["Signed",selC.signedDate?fmtDate(selC.signedDate):"⚠ Not signed"],["Owner",selC.owner]].map(([l,v])=>(
                <div key={l}><div className="lbl">{l}</div><div style={{fontSize:12,color:"#94a3b8"}}>{v}</div></div>
              ))}
            </div>
            {selDeal&&<div style={{marginBottom:10}}><div className="lbl">Linked Deal</div><div style={{fontSize:12,color:"#7dd3fc"}}>{selDeal.name}</div></div>}
            {selC.notes&&<div style={{fontSize:11,color:"#475569",lineHeight:1.5,marginBottom:12,borderTop:"1px solid #111d2d",paddingTop:10}}>{selC.notes}</div>}
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              {selC.fileName
                ? <div style={{background:"#021f14",border:"1px solid #1a3d20",borderRadius:7,padding:"6px 12px",fontSize:11,color:"#86efac",flex:1}}>📎 {selC.fileName}</div>
                : <div style={{background:"#1a0808",border:"1px solid #3d1010",borderRadius:7,padding:"6px 12px",fontSize:11,color:"#f87171",flex:1}}>⚠ No file attached</div>}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn bg" style={{flex:1,justifyContent:"center",fontSize:11}} onClick={()=>open(selC)}>Edit</button>
              <select className="inp" style={{flex:1,fontSize:11}} value={selC.status}
                onChange={e=>setContracts(cs=>cs.map(c=>c.id===selC.id?{...c,status:e.target.value}:c))}>
                {["draft","pending","active","expiring","expired","terminated"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:580}}>
            <MH title={editing?"Edit Contract":"New Contract"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Contract Name" style={{gridColumn:"1/-1"}}><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="AT&T BRIM Phase 3 MSA"/></FF>
              <FF label="Account"><select className="inp" value={form.accountId} onChange={e=>setForm({...form,accountId:e.target.value})}>
                <option value="">Select…</option>{crmAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select></FF>
              <FF label="Type"><select className="inp" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
                {CONTRACT_TYPES.map(t=><option key={t}>{t}</option>)}
              </select></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
                {["draft","pending","active","expiring","expired","terminated"].map(s=><option key={s}>{s}</option>)}
              </select></FF>
              <FF label="Contract Value ($)"><input className="inp" type="number" value={form.value} onChange={e=>setForm({...form,value:e.target.value})}/></FF>
              <FF label="Start Date"><input className="inp" type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})}/></FF>
              <FF label="End Date"><input className="inp" type="date" value={form.endDate} onChange={e=>setForm({...form,endDate:e.target.value})}/></FF>
              <FF label="Signed Date"><input className="inp" type="date" value={form.signedDate} onChange={e=>setForm({...form,signedDate:e.target.value})}/></FF>
              <FF label="Counterparty"><input className="inp" value={form.counterparty} onChange={e=>setForm({...form,counterparty:e.target.value})} placeholder="AT&T Inc."/></FF>
              <FF label="Owner"><input className="inp" value={form.owner} onChange={e=>setForm({...form,owner:e.target.value})}/></FF>
              <FF label="Renewal Alert (days)"><input className="inp" type="number" value={form.renewalAlert} onChange={e=>setForm({...form,renewalAlert:e.target.value})}/></FF>
              <FF label="File Name / Ref"><input className="inp" value={form.fileName} onChange={e=>setForm({...form,fileName:e.target.value})} placeholder="contract_att_2026.pdf"/></FF>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SOWView({ sows, setSows, crmAccounts, roster }) {
  const [selected, setSelected] = useState(sows[0]?.id||null);
  const selSOW = sows.find(s=>s.id===selected);
  const acc    = selSOW ? crmAccounts.find(a=>a.id===selSOW.accountId) : null;

  const updateMilestone = (sowId, mId, patch) => {
    setSows(ss=>ss.map(s=>s.id===sowId?{...s,milestones:s.milestones.map(m=>m.id===mId?{...m,...patch}:m)}:s));
  };
  const addMilestone = (sowId) => {
    const m = { id:"m"+uid(), name:"New Milestone", dueDate:"", status:"pending", value:0, notes:"" };
    setSows(ss=>ss.map(s=>s.id===sowId?{...s,milestones:[...s.milestones,m]}:s));
  };
  const delMilestone = (sowId, mId) => {
    setSows(ss=>ss.map(s=>s.id===sowId?{...s,milestones:s.milestones.filter(m=>m.id!==mId)}:s));
  };

  const totalVal = selSOW?.milestones.reduce((s,m)=>s+m.value,0)||0;
  const earnedVal= selSOW?.milestones.filter(m=>m.status==="complete").reduce((s,m)=>s+m.value,0)||0;
  const pctDone  = totalVal>0 ? Math.round((earnedVal/totalVal)*100) : 0;

  return (
    <div style={{display:"grid",gridTemplateColumns:"220px 1fr",gap:16}}>
      {/* SOW list */}
      <div>
        {sows.map(s=>{
          const a = crmAccounts.find(x=>x.id===s.accountId);
          const done = s.milestones.filter(m=>m.status==="complete").length;
          return (
            <div key={s.id} onClick={()=>setSelected(s.id)}
              style={{padding:"12px 14px",borderRadius:10,marginBottom:8,cursor:"pointer",
                background:selected===s.id?"#0a1a2e":"#070b14",
                border:`1px solid ${selected===s.id?"#0284c7":"#1a2d45"}`,transition:"all 0.15s"}}>
              <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginBottom:3}}>{s.name}</div>
              <div style={{fontSize:10,color:"#3d5a7a",marginBottom:6}}>{a?.name}</div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#475569"}}>
                <span>{done}/{s.milestones.length} milestones</span>
                <span className="bdg" style={{background:CONTRACT_STATUS_B[s.status],color:CONTRACT_STATUS_C[s.status],fontSize:8}}>{s.status}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* SOW detail */}
      {selSOW && (
        <div>
          {/* Header */}
          <div className="card" style={{padding:"16px 20px",marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:"#e2e8f0"}}>{selSOW.name}</div>
                <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>{acc?.name} · PO: {selSOW.poNumber||"—"}</div>
              </div>
              <span className="bdg" style={{background:CONTRACT_STATUS_B[selSOW.status],color:CONTRACT_STATUS_C[selSOW.status]}}>{selSOW.status}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              {[["Bill Rate","$"+selSOW.billRate+"/hr"],["Est. Hours",selSOW.estimatedHours+"h"],["Start",fmtDate(selSOW.startDate)],["End",fmtDate(selSOW.endDate)]].map(([l,v])=>(
                <div key={l}><div className="lbl">{l}</div><div style={{fontSize:12,color:"#94a3b8"}}>{v}</div></div>
              ))}
            </div>
            {/* Consultants */}
            <div style={{marginBottom:12}}>
              <div className="lbl" style={{marginBottom:6}}>Consultants</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {selSOW.consultants.map(cid=>{
                  const r = roster.find(x=>x.id===cid);
                  return r ? <span key={cid} className="bdg" style={{background:"#0c2340",color:"#7dd3fc"}}>{r.name}</span> : null;
                })}
              </div>
            </div>
            {/* Progress */}
            <div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <span style={{fontSize:11,color:"#64748b"}}>Revenue earned</span>
                <span style={{fontSize:12,fontWeight:700,color:"#34d399",fontFamily:"'DM Mono',monospace"}}>{fmt(earnedVal)} / {fmt(totalVal)} ({pctDone}%)</span>
              </div>
              <div style={{height:10,background:"#0a1626",borderRadius:5}}>
                <div style={{height:10,borderRadius:5,background:"linear-gradient(90deg,#0369a1,#34d399)",width:pctDone+"%",transition:"width 0.5s"}}/>
              </div>
            </div>
          </div>

          {/* Milestones */}
          <div className="card">
            <div className="section-hdr" style={{display:"flex",justifyContent:"space-between"}}>
              <span>Milestones ({selSOW.milestones.length})</span>
              <button className="btn bp" style={{padding:"4px 12px",fontSize:11}} onClick={()=>addMilestone(selSOW.id)}><I d={ICONS.plus} s={11}/>Add</button>
            </div>
            <div className="tr" style={{gridTemplateColumns:"2fr 90px 100px 90px 1fr 60px",padding:"8px 18px"}}>
              {["Milestone","Status","Due Date","Value","Notes","Del"].map(h=><span key={h} className="th">{h}</span>)}
            </div>
            {selSOW.milestones.map((m,i)=>(
              <div key={m.id} className="tr" style={{gridTemplateColumns:"2fr 90px 100px 90px 1fr 60px"}}>
                <input className="inp" style={{fontSize:12,padding:"4px 8px"}} value={m.name}
                  onChange={e=>updateMilestone(selSOW.id,m.id,{name:e.target.value})}/>
                <select className="inp" style={{fontSize:11,padding:"4px"}} value={m.status}
                  onChange={e=>updateMilestone(selSOW.id,m.id,{status:e.target.value})}>
                  {["pending","in-progress","complete","blocked"].map(s=><option key={s}>{s}</option>)}
                </select>
                <input className="inp" type="date" style={{fontSize:11,padding:"4px"}} value={m.dueDate}
                  onChange={e=>updateMilestone(selSOW.id,m.id,{dueDate:e.target.value})}/>
                <input className="inp" type="number" style={{fontSize:11,padding:"4px"}} value={m.value}
                  onChange={e=>updateMilestone(selSOW.id,m.id,{value:+e.target.value})}/>
                <input className="inp" style={{fontSize:11,padding:"4px"}} value={m.notes}
                  onChange={e=>updateMilestone(selSOW.id,m.id,{notes:e.target.value})}/>
                <button className="btn br" style={{padding:"3px 7px",fontSize:10}} onClick={()=>delMilestone(selSOW.id,m.id)}><I d={ICONS.trash} s={11}/></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SOWBuilder({ sows, setSows, crmAccounts, crmDeals, contracts, roster }) {
  const [step, setStep]   = useState(1);
  const [draft, setDraft] = useState({
    accountId:"acc1", dealId:"deal1", name:"", description:"",
    consultants:[], startDate:"", endDate:"",
    billRate:140, estimatedHours:1920,
    status:"draft", poNumber:"",
    milestones:[
      { id:"nm1", name:"Kick-off & Discovery",    dueDate:"", status:"pending", value:0, notes:"" },
      { id:"nm2", name:"Phase 1 Delivery",         dueDate:"", status:"pending", value:0, notes:"" },
      { id:"nm3", name:"Phase 2 Delivery",         dueDate:"", status:"pending", value:0, notes:"" },
      { id:"nm4", name:"UAT & Go-Live",            dueDate:"", status:"pending", value:0, notes:"" },
      { id:"nm5", name:"Hypercare & Sign-off",     dueDate:"", status:"pending", value:0, notes:"" },
    ],
    notes:"",
  });

  const totalMV = draft.milestones.reduce((s,m)=>s+m.value,0);
  const totalEst= draft.billRate * draft.estimatedHours;
  const acc     = crmAccounts.find(a=>a.id===draft.accountId);
  const deal    = crmDeals.find(d=>d.id===draft.dealId);

  const addMilestone = () => setDraft(d=>({...d,milestones:[...d.milestones,{id:"nm"+uid(),name:"New Milestone",dueDate:"",status:"pending",value:0,notes:""}]}));
  const updMilestone = (id,patch) => setDraft(d=>({...d,milestones:d.milestones.map(m=>m.id===id?{...m,...patch}:m)}));
  const delMilestone = (id) => setDraft(d=>({...d,milestones:d.milestones.filter(m=>m.id!==id)}));
  const toggleConsultant = (rid) => setDraft(d=>({...d,consultants:d.consultants.includes(rid)?d.consultants.filter(x=>x!==rid):[...d.consultants,rid]}));

  const saveDraft = () => {
    setSows(ss=>[...ss,{...draft,id:"sow"+uid()}]);
    setStep(4);
  };

  const stepStyle = (n) => ({
    width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",
    fontSize:13,fontWeight:700,flexShrink:0,
    background:step>n?"#034d2f":step===n?"linear-gradient(135deg,#0369a1,#0284c7)":"#0a1626",
    color:step>n?"#34d399":step===n?"#fff":"#475569",
    border:`2px solid ${step>n?"#34d399":step===n?"#0284c7":"#1a2d45"}`,
  });

  return (
    <div>
      {/* Progress steps */}
      <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:28}}>
        {["Deal & Account","Scope & Team","Milestones","Review & Save"].map((s,i)=>(
          <React.Fragment key={s}>
            <div style={{display:"flex",alignItems:"center",gap:8,cursor:i+1<=step?"pointer":"default"}} onClick={()=>i+1<step&&setStep(i+1)}>
              <div style={stepStyle(i+1)}>{step>i+1?"✓":i+1}</div>
              <span style={{fontSize:12,fontWeight:600,color:step===i+1?"#38bdf8":step>i+1?"#34d399":"#475569"}}>{s}</span>
            </div>
            {i<3&&<div style={{flex:1,height:2,background:step>i+1?"#034d2f":"#1a2d45",margin:"0 12px",minWidth:20}}/>}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1 — Deal & Account */}
      {step===1 && (
        <div className="card" style={{padding:"22px 26px",maxWidth:620}}>
          <div style={{fontSize:15,fontWeight:700,color:"#e2e8f0",marginBottom:18}}>Select deal and account</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <FF label="Account"><select className="inp" value={draft.accountId} onChange={e=>setDraft({...draft,accountId:e.target.value})}>
              {crmAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select></FF>
            <FF label="Linked Deal"><select className="inp" value={draft.dealId} onChange={e=>setDraft({...draft,dealId:e.target.value})}>
              <option value="">None</option>{crmDeals.filter(d=>d.accountId===draft.accountId).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
            </select></FF>
            <FF label="SOW Title" style={{gridColumn:"1/-1"}}><input className="inp" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="AT&T BRIM Phase 3 SOW"/></FF>
            <FF label="PO Number"><input className="inp" value={draft.poNumber} onChange={e=>setDraft({...draft,poNumber:e.target.value})} placeholder="ATT-PO-2026-0401"/></FF>
          </div>
          {deal&&<div style={{marginTop:14,background:"#0c1e10",border:"1px solid #1a3d20",borderRadius:8,padding:"10px 14px"}}>
            <div style={{fontSize:11,color:"#34d399",fontWeight:600,marginBottom:4}}>✓ Auto-filled from deal: {deal.name}</div>
            <div style={{fontSize:11,color:"#475569"}}>Value: {fmt(deal.value)} · Close: {fmtDate(deal.closeDate)} · Stage: {deal.stage}</div>
          </div>}
          <button className="btn bp" style={{marginTop:20}} onClick={()=>setStep(2)} disabled={!draft.name}>Next: Scope & Team →</button>
        </div>
      )}

      {/* Step 2 — Scope & Team */}
      {step===2 && (
        <div className="card" style={{padding:"22px 26px",maxWidth:660}}>
          <div style={{fontSize:15,fontWeight:700,color:"#e2e8f0",marginBottom:18}}>Define scope and assign team</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:16}}>
            <FF label="Start Date"><input className="inp" type="date" value={draft.startDate} onChange={e=>setDraft({...draft,startDate:e.target.value})}/></FF>
            <FF label="End Date"><input className="inp" type="date" value={draft.endDate} onChange={e=>setDraft({...draft,endDate:e.target.value})}/></FF>
            <FF label="Bill Rate ($/hr)"><input className="inp" type="number" value={draft.billRate} onChange={e=>setDraft({...draft,billRate:+e.target.value})}/></FF>
            <FF label="Estimated Hours"><input className="inp" type="number" value={draft.estimatedHours} onChange={e=>setDraft({...draft,estimatedHours:+e.target.value})}/></FF>
          </div>
          <FF label="Scope Description"><textarea className="inp" rows={3} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})} placeholder="Describe the engagement scope, deliverables, and boundaries…"/></FF>
          <div style={{marginTop:14,marginBottom:8}}>
            <div className="lbl" style={{marginBottom:8}}>Assign Consultants</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {roster.map(r=>{
                const sel = draft.consultants.includes(r.id);
                return (
                  <button key={r.id} onClick={()=>toggleConsultant(r.id)}
                    style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${sel?"#0284c7":"#1a2d45"}`,
                      background:sel?"#0c2340":"#070b14",color:sel?"#38bdf8":"#475569",
                      cursor:"pointer",fontSize:12,fontWeight:600,transition:"all 0.15s"}}>
                    {sel?"✓ ":""}{r.name}<span style={{fontSize:10,color:"#3d5a7a",marginLeft:6}}>{r.role}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{background:"#0b1422",border:"1px solid #1a2d45",borderRadius:8,padding:"10px 14px",marginTop:12}}>
            <div style={{fontSize:11,color:"#3d5a7a"}}>Estimated contract value: <span style={{color:"#38bdf8",fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{fmt(totalEst)}</span></div>
          </div>
          <div style={{display:"flex",gap:10,marginTop:20}}>
            <button className="btn bg" onClick={()=>setStep(1)}>← Back</button>
            <button className="btn bp" onClick={()=>setStep(3)}>Next: Milestones →</button>
          </div>
        </div>
      )}

      {/* Step 3 — Milestones */}
      {step===3 && (
        <div className="card" style={{padding:"22px 26px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <div style={{fontSize:15,fontWeight:700,color:"#e2e8f0"}}>Define milestones & payment schedule</div>
            <button className="btn bp" style={{fontSize:11,padding:"5px 12px"}} onClick={addMilestone}><I d={ICONS.plus} s={11}/>Add</button>
          </div>
          <div className="card" style={{marginBottom:14}}>
            <div className="tr" style={{gridTemplateColumns:"2fr 120px 100px 80px 60px",padding:"8px 18px"}}>
              {["Milestone Name","Due Date","Value ($)","Notes","Del"].map(h=><span key={h} className="th">{h}</span>)}
            </div>
            {draft.milestones.map((m,i)=>(
              <div key={m.id} className="tr" style={{gridTemplateColumns:"2fr 120px 100px 80px 60px"}}>
                <input className="inp" style={{fontSize:12,padding:"5px 8px"}} value={m.name} onChange={e=>updMilestone(m.id,{name:e.target.value})}/>
                <input className="inp" type="date" style={{fontSize:11,padding:"5px"}} value={m.dueDate} onChange={e=>updMilestone(m.id,{dueDate:e.target.value})}/>
                <input className="inp" type="number" style={{fontSize:11,padding:"5px"}} value={m.value} onChange={e=>updMilestone(m.id,{value:+e.target.value})}/>
                <input className="inp" style={{fontSize:11,padding:"5px"}} value={m.notes} onChange={e=>updMilestone(m.id,{notes:e.target.value})}/>
                <button className="btn br" style={{padding:"3px 7px",fontSize:10}} onClick={()=>delMilestone(m.id)}><I d={ICONS.trash} s={11}/></button>
              </div>
            ))}
          </div>
          <div style={{background:"#0b1422",border:"1px solid #1a2d45",borderRadius:8,padding:"12px 16px",marginBottom:20}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:12,color:"#64748b"}}>Total milestone value</span>
              <span style={{fontSize:14,fontWeight:700,color:Math.abs(totalMV-totalEst)<1000?"#34d399":"#f59e0b",fontFamily:"'DM Mono',monospace"}}>{fmt(totalMV)}</span>
            </div>
            <div style={{fontSize:11,color:"#3d5a7a"}}>vs estimated contract value: {fmt(totalEst)} · {Math.abs(totalMV-totalEst)<1000?"✓ Balanced":"⚠ "+fmt(Math.abs(totalMV-totalEst))+" gap"}</div>
          </div>
          <div style={{display:"flex",gap:10}}>
            <button className="btn bg" onClick={()=>setStep(2)}>← Back</button>
            <button className="btn bp" onClick={()=>setStep(4)}>Review SOW →</button>
          </div>
        </div>
      )}

      {/* Step 4 — Review */}
      {step===4 && (
        <div className="card" style={{padding:"22px 26px",maxWidth:660}}>
          <div style={{fontSize:15,fontWeight:700,color:"#34d399",marginBottom:6}}>✓ SOW Ready for Review</div>
          <div style={{fontSize:12,color:"#475569",marginBottom:20}}>Review the SOW details below, then save as draft or mark as active.</div>
          {[["Account",acc?.name||"—"],["SOW Title",draft.name],["PO Number",draft.poNumber||"—"],["Period",`${fmtDate(draft.startDate)} → ${fmtDate(draft.endDate)}`],["Bill Rate","$"+draft.billRate+"/hr"],["Est. Hours",draft.estimatedHours+"h"],["Est. Value",fmt(totalEst)],["Milestone Value",fmt(totalMV)]].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #0a1626"}}>
              <span style={{fontSize:12,color:"#64748b"}}>{l}</span>
              <span style={{fontSize:12,fontWeight:600,color:"#94a3b8"}}>{v}</span>
            </div>
          ))}
          <div style={{marginTop:14,marginBottom:6}}><div className="lbl">Team</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:6}}>
              {draft.consultants.map(cid=>{const r=roster.find(x=>x.id===cid);return r?<span key={cid} className="bdg" style={{background:"#0c2340",color:"#7dd3fc"}}>{r.name}</span>:null;})}
              {draft.consultants.length===0&&<span style={{fontSize:11,color:"#3d5a7a"}}>No consultants assigned</span>}
            </div>
          </div>
          <div style={{marginTop:14,marginBottom:20}}>
            <div className="lbl" style={{marginBottom:8}}>Milestones ({draft.milestones.length})</div>
            {draft.milestones.map((m,i)=>(
              <div key={m.id} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #070b14"}}>
                <span style={{fontSize:12,color:"#94a3b8"}}>{m.name}</span>
                <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{m.value>0?fmt(m.value):"—"}</span>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:10}}>
            <button className="btn bg" onClick={()=>setStep(3)}>← Edit Milestones</button>
            <button className="btn bs" onClick={saveDraft}><I d={ICONS.check} s={13}/>Save as Draft SOW</button>
            <button className="btn bp" onClick={()=>{setSows(ss=>[...ss,{...draft,id:"sow"+uid(),status:"active"}]);setStep(1);}}>Save & Activate</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT TRACKER MODULE
// ═══════════════════════════════════════════════════════════════════════════════
const PROJ_STATUS_C = { active:"#34d399", planning:"#7dd3fc", "on-hold":"#f59e0b", complete:"#a78bfa", cancelled:"#64748b" };
const PROJ_STATUS_B = { active:"#021f14", planning:"#0c2340", "on-hold":"#1a1005", complete:"#1a1a2e", cancelled:"#0a1626" };
const TASK_PRIORITY_C = { high:"#f87171", medium:"#f59e0b", low:"#64748b" };
const RISK_PROB_C     = { high:"#f87171", medium:"#f59e0b", low:"#34d399" };
const RISK_IMPACT_C   = { high:"#f87171", medium:"#f59e0b", low:"#34d399" };

function ProjectTracker({ projects, setProjects, tasks, setTasks, risks, setRisks, roster, crmAccounts, sows, addAudit }) {
  const [sub, setSub] = useState("overview");
  const tabs = [
    { id:"overview",  label:"Project Overview" },
    { id:"tasks",     label:"Task Board" },
    { id:"risks",     label:"Risk Register" },
    { id:"capacity",  label:"Capacity & Allocation" },
  ];
  const props = { projects, setProjects, tasks, setTasks, risks, setRisks, roster, crmAccounts, sows };
  return (
    <div>
      <PH title="Project Tracker" sub="Active Projects · Tasks · Risks · Capacity"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {sub==="overview"  && <ProjOverview  {...props}/>}
      {sub==="tasks"     && <ProjTasks     {...props}/>}
      {sub==="risks"     && <ProjRisks     {...props}/>}
      {sub==="capacity"  && <ProjCapacity  {...props}/>}
    </div>
  );
}

function ProjOverview({ projects, setProjects, tasks, risks, roster, crmAccounts, sows }) {
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(null);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);

  const empty = { accountId:"", sowId:"", name:"", status:"planning", health:"green", startDate:"", endDate:"", budget:0, spent:0, pm:"", consultants:[], notes:"" };
  const open  = (p=null) => { setEditing(p?.id||null); setForm(p?{...p}:{...empty}); setModal(true); };
  const save  = () => {
    const f = {...form, budget:+form.budget, spent:+form.spent};
    if(editing) setProjects(ps=>ps.map(p=>p.id===editing?f:p));
    else { setProjects(ps=>[...ps,{...f,id:"proj"+uid()}]); addAudit&&addAudit("Projects","New Project","Projects",`Created: ${f.name}`,{client:f.client,budget:f.budget}); }
    setModal(false);
  };
  const toggleConsultant = (rid) => setForm(f=>({...f,consultants:f.consultants.includes(rid)?f.consultants.filter(x=>x!==rid):[...f.consultants,rid]}));

  const selProj    = projects.find(p=>p.id===selected);
  const selAcc     = selProj ? crmAccounts.find(a=>a.id===selProj.accountId) : null;
  const selTasks   = selected ? tasks.filter(t=>t.projectId===selected) : [];
  const selRisks   = selected ? risks.filter(r=>r.projectId===selected) : [];
  const openTasks  = selTasks.filter(t=>t.status!=="done").length;
  const openRisks  = selRisks.filter(r=>r.status==="open").length;

  const healthC = { green:"#34d399", amber:"#f59e0b", red:"#f87171" };
  const healthB = { green:"#021f14", amber:"#1a1005", red:"#1a0808" };

  return (
    <div>
      {/* Summary KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Active Projects",  v:projects.filter(p=>p.status==="active").length,   c:"#34d399"},
          {l:"Planning",         v:projects.filter(p=>p.status==="planning").length,  c:"#7dd3fc"},
          {l:"Total Budget",     v:fmt(projects.reduce((s,p)=>s+p.budget,0)),         c:"#38bdf8"},
          {l:"Total Spent",      v:fmt(projects.reduce((s,p)=>s+p.spent,0)),          c:"#f59e0b"},
          {l:"Open Risks",       v:risks.filter(r=>r.status==="open").length,         c:risks.filter(r=>r.status==="open").length>2?"#f87171":"#34d399"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:22,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        <button className="btn bp" style={{fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>New Project</button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:selProj?"3fr 2fr":"1fr",gap:16}}>
        {/* Project cards */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {projects.map(p=>{
            const acc = crmAccounts.find(a=>a.id===p.accountId);
            const sow = sows.find(s=>s.id===p.sowId);
            const pTasks = tasks.filter(t=>t.projectId===p.id);
            const pRisks = risks.filter(r=>r.projectId===p.id&&r.status==="open");
            const pctSpent = p.budget>0 ? Math.min(100,Math.round((p.spent/p.budget)*100)) : 0;
            const openT = pTasks.filter(t=>t.status!=="done").length;
            const highT = pTasks.filter(t=>t.priority==="high"&&t.status!=="done").length;
            return (
              <div key={p.id} className="card" style={{padding:"16px 20px",cursor:"pointer",
                border:selected===p.id?"1px solid #0284c7":"1px solid #1a2d45"}}
                onClick={()=>setSelected(selected===p.id?null:p.id)}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{p.name}</div>
                    <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>{acc?.name} · PM: {p.pm}</div>
                    {p.notes&&<div style={{fontSize:11,color:"#475569",marginTop:4}}>{p.notes}</div>}
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0,marginLeft:12}}>
                    <span className="bdg" style={{background:healthB[p.health],color:healthC[p.health]}}>{p.health}</span>
                    <span className="bdg" style={{background:PROJ_STATUS_B[p.status],color:PROJ_STATUS_C[p.status]}}>{p.status}</span>
                    <button className="btn bg" style={{padding:"3px 7px",fontSize:10}} onClick={e=>{e.stopPropagation();open(p);}}><I d={ICONS.edit} s={11}/></button>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
                  {[["Budget",fmt(p.budget)],["Spent",fmt(p.spent)],["Start",fmtDate(p.startDate)],["End",fmtDate(p.endDate)]].map(([l,v])=>(
                    <div key={l}><div style={{fontSize:9,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:2}}>{l}</div><div style={{fontSize:12,fontWeight:600,color:"#94a3b8"}}>{v}</div></div>
                  ))}
                </div>
                <div style={{height:6,background:"#0a1626",borderRadius:3,marginBottom:10}}>
                  <div style={{height:6,borderRadius:3,background:pctSpent>90?"#f87171":pctSpent>70?"#f59e0b":"#0369a1",width:pctSpent+"%",transition:"width 0.4s"}}/>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {openT>0&&<span className="bdg" style={{background:"#1a1005",color:"#f59e0b",fontSize:9}}>{openT} open task{openT>1?"s":""}</span>}
                  {highT>0&&<span className="bdg" style={{background:"#1a0808",color:"#f87171",fontSize:9}}>{highT} high-priority</span>}
                  {pRisks.length>0&&<span className="bdg" style={{background:"#1a0808",color:"#f87171",fontSize:9}}>{pRisks.length} open risk{pRisks.length>1?"s":""}</span>}
                  {p.consultants.map(cid=>{const r=roster.find(x=>x.id===cid);return r?<span key={cid} className="bdg" style={{background:"#0a1626",color:"#7dd3fc",fontSize:9}}>{r.name.split(" ")[0]}</span>:null;})}
                </div>
              </div>
            );
          })}
        </div>

        {/* Project detail */}
        {selProj && (
          <div style={{display:"flex",flexDirection:"column",gap:12,position:"sticky",top:0,height:"fit-content"}}>
            <div className="card" style={{padding:"16px 18px"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{selProj.name}</div>
                <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
              </div>
              {/* Budget bar */}
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,color:"#64748b"}}>Budget utilization</span>
                  <span style={{fontSize:12,fontWeight:700,color:"#38bdf8"}}>{selProj.budget>0?Math.round((selProj.spent/selProj.budget)*100):0}%</span>
                </div>
                <div style={{height:8,background:"#0a1626",borderRadius:4}}>
                  <div style={{height:8,borderRadius:4,background:selProj.spent/selProj.budget>0.9?"#f87171":selProj.spent/selProj.budget>0.7?"#f59e0b":"#0369a1",width:Math.min(100,selProj.budget>0?selProj.spent/selProj.budget*100:0)+"%"}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
                  <span style={{fontSize:9,color:"#3d5a7a"}}>{fmt(selProj.spent)} spent</span>
                  <span style={{fontSize:9,color:"#3d5a7a"}}>{fmt(selProj.budget)} budget</span>
                </div>
              </div>
              {/* Team */}
              <div style={{marginBottom:12}}>
                <div className="lbl" style={{marginBottom:6}}>Team</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {selProj.consultants.map(cid=>{
                    const r = roster.find(x=>x.id===cid);
                    return r ? <span key={cid} className="bdg" style={{background:"#0c2340",color:"#7dd3fc"}}>{r.name}</span> : null;
                  })}
                  {selProj.consultants.length===0&&<span style={{fontSize:11,color:"#3d5a7a"}}>No consultants assigned</span>}
                </div>
              </div>
              {/* Quick update */}
              <div style={{display:"flex",gap:8}}>
                <select className="inp" style={{flex:1,fontSize:11}} value={selProj.health}
                  onChange={e=>setProjects(ps=>ps.map(p=>p.id===selProj.id?{...p,health:e.target.value}:p))}>
                  {["green","amber","red"].map(h=><option key={h}>{h}</option>)}
                </select>
                <select className="inp" style={{flex:1,fontSize:11}} value={selProj.status}
                  onChange={e=>setProjects(ps=>ps.map(p=>p.id===selProj.id?{...p,status:e.target.value}:p))}>
                  {["planning","active","on-hold","complete","cancelled"].map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* Tasks snapshot */}
            <div className="card">
              <div className="section-hdr" style={{fontSize:12}}>Open Tasks ({openTasks})</div>
              {selTasks.filter(t=>t.status!=="done").slice(0,6).map(t=>{
                const r = roster.find(x=>x.id===t.assignee);
                return (
                  <div key={t.id} style={{padding:"9px 16px",borderBottom:"1px solid #0d1a2a",display:"flex",gap:8,alignItems:"flex-start"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:TASK_PRIORITY_C[t.priority],flexShrink:0,marginTop:3}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,color:"#cbd5e1"}}>{t.title}</div>
                      <div style={{fontSize:10,color:"#3d5a7a"}}>{r?.name?.split(" ")[0]} · {fmtDate(t.dueDate)}</div>
                    </div>
                    <span className="bdg" style={{background:"#0a1626",color:"#475569",fontSize:9,textTransform:"capitalize"}}>{t.status}</span>
                  </div>
                );
              })}
              {openTasks===0&&<div style={{padding:"14px 16px",fontSize:11,color:"#1e3a5f"}}>All tasks complete 🎉</div>}
            </div>

            {/* Risks snapshot */}
            {selRisks.length>0&&(
              <div className="card">
                <div className="section-hdr" style={{fontSize:12,color:"#f87171"}}>⚠ Open Risks ({openRisks})</div>
                {selRisks.filter(r=>r.status==="open").map(r=>(
                  <div key={r.id} style={{padding:"9px 16px",borderBottom:"1px solid #0d1a2a"}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginBottom:2}}>{r.title}</div>
                    <div style={{display:"flex",gap:6}}>
                      <span className="bdg" style={{background:"#1a0808",color:RISK_PROB_C[r.probability],fontSize:9}}>P: {r.probability}</span>
                      <span className="bdg" style={{background:"#1a0808",color:RISK_IMPACT_C[r.impact],fontSize:9}}>I: {r.impact}</span>
                    </div>
                    <div style={{fontSize:10,color:"#475569",marginTop:4}}>{r.mitigation?.slice(0,80)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add/Edit modal */}
      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:580}}>
            <MH title={editing?"Edit Project":"New Project"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Project Name" style={{gridColumn:"1/-1"}}><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="AT&T BRIM Phase 3"/></FF>
              <FF label="Account"><select className="inp" value={form.accountId} onChange={e=>setForm({...form,accountId:e.target.value})}>
                <option value="">Select…</option>{crmAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
                {["planning","active","on-hold","complete","cancelled"].map(s=><option key={s}>{s}</option>)}
              </select></FF>
              <FF label="Health"><select className="inp" value={form.health} onChange={e=>setForm({...form,health:e.target.value})}>
                {["green","amber","red"].map(h=><option key={h}>{h}</option>)}
              </select></FF>
              <FF label="Project Manager"><input className="inp" value={form.pm} onChange={e=>setForm({...form,pm:e.target.value})} placeholder="Suresh Menon"/></FF>
              <FF label="Start Date"><input className="inp" type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})}/></FF>
              <FF label="End Date"><input className="inp" type="date" value={form.endDate} onChange={e=>setForm({...form,endDate:e.target.value})}/></FF>
              <FF label="Budget ($)"><input className="inp" type="number" value={form.budget} onChange={e=>setForm({...form,budget:e.target.value})}/></FF>
              <FF label="Spent ($)"><input className="inp" type="number" value={form.spent} onChange={e=>setForm({...form,spent:e.target.value})}/></FF>
            </div>
            <div style={{margin:"12px 0"}}>
              <div className="lbl" style={{marginBottom:8}}>Assign Consultants</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {roster.map(r=>{
                  const sel = form.consultants?.includes(r.id);
                  return <button key={r.id} onClick={()=>toggleConsultant(r.id)} style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${sel?"#0284c7":"#1a2d45"}`,background:sel?"#0c2340":"#070b14",color:sel?"#38bdf8":"#475569",cursor:"pointer",fontSize:11,fontWeight:600}}>{sel?"✓ ":""}{r.name.split(" ")[0]}</button>;
                })}
              </div>
            </div>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjTasks({ projects, tasks, setTasks, roster }) {
  const [projFilter, setProjFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState(null);
  const [editing, setEditing] = useState(null);

  const empty = { projectId:"", title:"", assignee:"", dueDate:"", status:"todo", priority:"medium", notes:"" };
  const open  = (t=null) => { setEditing(t?.id||null); setForm(t?{...t}:{...empty}); setModal(true); };
  const save  = () => {
    if(editing) setTasks(ts=>ts.map(t=>t.id===editing?{...form}:t));
    else { setTasks(ts=>[...ts,{...form,id:"task"+uid()}]); addAudit&&addAudit("Projects","New Task","Project Tracker",`Task created: ${form.title}`); }
    setModal(false);
  };
  const del   = id => setTasks(ts=>ts.filter(t=>t.id!==id));
  const cycle = (id) => {
    const order = ["todo","in-progress","done"];
    setTasks(ts=>ts.map(t=>{
      if(t.id!==id) return t;
      const next = order[(order.indexOf(t.status)+1)%order.length];
      return {...t,status:next};
    }));
  };

  const filtered = tasks
    .filter(t=>projFilter==="all"||t.projectId===projFilter)
    .filter(t=>statusFilter==="open"?t.status!=="done":statusFilter==="all"?true:t.status===statusFilter)
    .sort((a,b)=>{
      const po = {high:0,medium:1,low:2};
      return (po[a.priority]||1)-(po[b.priority]||1);
    });

  // Kanban by status
  const columns = [
    {id:"todo",        label:"To Do",       color:"#475569"},
    {id:"in-progress", label:"In Progress", color:"#f59e0b"},
    {id:"done",        label:"Done",        color:"#34d399"},
  ];

  const [view, setView] = useState("list"); // list | kanban

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
        <select className="inp" style={{width:"auto",fontSize:11,padding:"5px 10px"}} value={projFilter} onChange={e=>setProjFilter(e.target.value)}>
          <option value="all">All Projects</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {["open","todo","in-progress","done","all"].map(s=>(
          <button key={s} className="btn bg" style={{fontSize:11,padding:"5px 10px",borderColor:statusFilter===s?"#0284c7":"#1a2d45",color:statusFilter===s?"#38bdf8":"#475569"}} onClick={()=>setStatusFilter(s)}>
            {s==="in-progress"?"In Progress":s.charAt(0).toUpperCase()+s.slice(1)} ({tasks.filter(t=>(projFilter==="all"||t.projectId===projFilter)&&(s==="open"?t.status!=="done":s==="all"?true:t.status===s)).length})
          </button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button className="btn bg" style={{fontSize:11,padding:"5px 10px",borderColor:view==="list"?"#0284c7":"#1a2d45",color:view==="list"?"#38bdf8":"#475569"}} onClick={()=>setView("list")}>List</button>
          <button className="btn bg" style={{fontSize:11,padding:"5px 10px",borderColor:view==="kanban"?"#0284c7":"#1a2d45",color:view==="kanban"?"#38bdf8":"#475569"}} onClick={()=>setView("kanban")}>Kanban</button>
          <button className="btn bp" style={{fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>Add Task</button>
        </div>
      </div>

      {view==="list" && (
        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"28px 2fr 1fr 80px 90px 90px 90px 70px",padding:"8px 18px"}}>
            {["","Task","Project","Priority","Assignee","Due","Status","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(t=>{
            const proj = projects.find(p=>p.id===t.projectId);
            const r    = roster.find(x=>x.id===t.assignee);
            const past = t.status!=="done" && t.dueDate && t.dueDate <TODAY_STR;
            return (
              <div key={t.id} className="tr" style={{gridTemplateColumns:"28px 2fr 1fr 80px 90px 90px 90px 70px",background:past?"#0d0604":undefined}}>
                <button onClick={()=>cycle(t.id)}
                  style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${t.status==="done"?"#34d399":t.status==="in-progress"?"#f59e0b":"#1e3a5f"}`,
                    background:t.status==="done"?"#034d2f":"#0a1626",cursor:"pointer",fontSize:10,color:"#34d399",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {t.status==="done"?"✓":""}
                </button>
                <div style={{opacity:t.status==="done"?0.4:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",textDecoration:t.status==="done"?"line-through":"none"}}>{t.title}</div>
                  {t.notes&&<div style={{fontSize:10,color:"#3d5a7a",marginTop:1}}>{t.notes.slice(0,60)}</div>}
                </div>
                <span style={{fontSize:11,color:"#475569"}}>{proj?.name?.slice(0,25)}</span>
                <span className="bdg" style={{background:"#0a1626",color:TASK_PRIORITY_C[t.priority],fontSize:9}}>{t.priority}</span>
                <span style={{fontSize:11,color:"#64748b"}}>{r?.name?.split(" ")[0]||"—"}</span>
                <span style={{fontSize:11,color:past?"#f87171":"#64748b"}}>{t.dueDate?fmtDate(t.dueDate):"—"}</span>
                <span className="bdg" style={{background:"#060d1c",color:t.status==="done"?"#34d399":t.status==="in-progress"?"#f59e0b":"#475569",fontSize:9,textTransform:"capitalize"}}>{t.status}</span>
                <div style={{display:"flex",gap:4}}>
                  <button className="btn bg" style={{padding:"2px 6px",fontSize:10}} onClick={()=>open(t)}><I d={ICONS.edit} s={10}/></button>
                  <button className="btn br" style={{padding:"2px 6px",fontSize:10}} onClick={()=>del(t.id)}><I d={ICONS.trash} s={10}/></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view==="kanban" && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          {columns.map(col=>{
            const colTasks = tasks
              .filter(t=>t.status===col.id)
              .filter(t=>projFilter==="all"||t.projectId===projFilter);
            return (
              <div key={col.id} style={{background:"#070c18",border:"1px solid #1a2d45",borderRadius:12,padding:"12px 14px",minHeight:200}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                  <span style={{fontSize:12,fontWeight:700,color:col.color}}>{col.label}</span>
                  <span style={{fontSize:11,color:"#3d5a7a",fontFamily:"'DM Mono',monospace"}}>{colTasks.length}</span>
                </div>
                {colTasks.map(t=>{
                  const r = roster.find(x=>x.id===t.assignee);
                  const proj = projects.find(p=>p.id===t.projectId);
                  return (
                    <div key={t.id} style={{background:"#0b1422",border:`1px solid ${TASK_PRIORITY_C[t.priority]}22`,borderLeft:`3px solid ${TASK_PRIORITY_C[t.priority]}`,borderRadius:8,padding:"10px 12px",marginBottom:8}}>
                      <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginBottom:4,lineHeight:1.3}}>{t.title}</div>
                      <div style={{fontSize:10,color:"#3d5a7a",marginBottom:6}}>{proj?.name?.slice(0,20)}</div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <span style={{fontSize:10,color:"#64748b"}}>{r?.name?.split(" ")[0]||"—"}</span>
                        <div style={{display:"flex",gap:4}}>
                          <span className="bdg" style={{background:"#0a1626",color:TASK_PRIORITY_C[t.priority],fontSize:8}}>{t.priority}</span>
                          <button className="btn bg" style={{padding:"2px 5px",fontSize:9}} onClick={()=>cycle(t.id)}>▶</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:500}}>
            <MH title={editing?"Edit Task":"Add Task"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Project"><select className="inp" value={form.projectId} onChange={e=>setForm({...form,projectId:e.target.value})}>
                <option value="">Select…</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select></FF>
              <FF label="Assignee"><select className="inp" value={form.assignee} onChange={e=>setForm({...form,assignee:e.target.value})}>
                <option value="">Select…</option>{roster.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
                {["todo","in-progress","done"].map(s=><option key={s}>{s}</option>)}
              </select></FF>
              <FF label="Priority"><select className="inp" value={form.priority} onChange={e=>setForm({...form,priority:e.target.value})}>
                {["high","medium","low"].map(p=><option key={p}>{p}</option>)}
              </select></FF>
              <FF label="Due Date"><input className="inp" type="date" value={form.dueDate} onChange={e=>setForm({...form,dueDate:e.target.value})}/></FF>
            </div>
            <FF label="Task Title"><input className="inp" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="Complete requirements document"/></FF>
            <FF label="Notes"><textarea className="inp" rows={2} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save Task</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjRisks({ projects, risks, setRisks, roster }) {
  const [projFilter, setProjFilter] = useState("all");
  const [modal, setModal] = useState(false);
  const [form, setForm]   = useState(null);
  const [editing, setEditing] = useState(null);

  const empty = { projectId:"", title:"", probability:"medium", impact:"medium", status:"open", mitigation:"", owner:"" };
  const open  = (r=null) => { setEditing(r?.id||null); setForm(r?{...r}:{...empty}); setModal(true); };
  const save  = () => {
    if(editing) setRisks(rs=>rs.map(r=>r.id===editing?{...form}:r));
    else setRisks(rs=>[...rs,{...form,id:"risk"+uid()}]);
    setModal(false);
  };
  const del   = id => setRisks(rs=>rs.filter(r=>r.id!==id));
  const mitigate = id => setRisks(rs=>rs.map(r=>r.id===id?{...r,status:"mitigated"}:r));

  const filtered = risks.filter(r=>projFilter==="all"||r.projectId===projFilter)
    .sort((a,b)=>{
      const score = {high:3,medium:2,low:1};
      const rA = (score[a.probability]||0)+(score[a.impact]||0);
      const rB = (score[b.probability]||0)+(score[b.impact]||0);
      return rB - rA;
    });

  const openR = risks.filter(r=>r.status==="open");
  const highR = openR.filter(r=>r.probability==="high"&&r.impact==="high");

  // Risk matrix
  const matrixCell = (prob, impact) => {
    const cell = risks.filter(r=>r.probability===prob&&r.impact===impact&&r.status==="open");
    const isHigh = prob==="high"&&impact==="high";
    const isMed  = (prob==="high"&&impact==="medium")||(prob==="medium"&&impact==="high");
    const bg = isHigh?"#1a0808":isMed?"#1a1005":"#021f14";
    const c  = isHigh?"#f87171":isMed?"#f59e0b":"#34d399";
    return { count:cell.length, bg, c };
  };

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Open Risks",     v:openR.length,   c:openR.length>3?"#f87171":"#34d399"},
          {l:"High×High",      v:highR.length,   c:highR.length>0?"#f87171":"#34d399"},
          {l:"Mitigated",      v:risks.filter(r=>r.status==="mitigated").length, c:"#34d399"},
          {l:"Closed",         v:risks.filter(r=>r.status==="closed").length, c:"#64748b"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:24,fontWeight:800,color:k.c}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:16,marginBottom:16}}>
        <div className="card" style={{padding:"16px 20px"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#e2e8f0",marginBottom:14}}>Risk Matrix</div>
          <div style={{display:"grid",gridTemplateColumns:"60px repeat(3,1fr)",gap:4}}>
            <div/>
            {["Low","Medium","High"].map(i=><div key={i} style={{textAlign:"center",fontSize:10,color:"#3d5a7a",fontWeight:700,padding:"4px 0"}}>Impact: {i}</div>)}
            {["High","Medium","Low"].map(prob=>(
              <React.Fragment key={prob}>
                <div style={{fontSize:10,color:"#3d5a7a",fontWeight:700,display:"flex",alignItems:"center",justifyContent:"flex-end",paddingRight:8}}>P: {prob}</div>
                {["low","medium","high"].map(impact=>{
                  const cell = matrixCell(prob.toLowerCase(), impact);
                  return (
                    <div key={impact} style={{background:cell.bg,border:`1px solid ${cell.c}33`,borderRadius:6,padding:"12px",textAlign:"center",minHeight:52,display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {cell.count>0?<span style={{fontSize:18,fontWeight:800,color:cell.c}}>{cell.count}</span>:<span style={{fontSize:11,color:"#1e3a5f"}}>—</span>}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8,justifyContent:"flex-start"}}>
          <select className="inp" style={{fontSize:11,padding:"5px 10px"}} value={projFilter} onChange={e=>setProjFilter(e.target.value)}>
            <option value="all">All Projects</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn bp" style={{fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>Log Risk</button>
        </div>
      </div>

      <div className="card">
        <div className="tr" style={{gridTemplateColumns:"2fr 80px 80px 80px 1.5fr 90px 90px",padding:"8px 18px"}}>
          {["Risk","Probability","Impact","Status","Mitigation","Owner","Actions"].map(h=><span key={h} className="th">{h}</span>)}
        </div>
        {filtered.map(r=>{
          const proj = projects.find(p=>p.id===r.projectId);
          return (
            <div key={r.id} className="tr" style={{gridTemplateColumns:"2fr 80px 80px 80px 1.5fr 90px 90px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r.title}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{proj?.name}</div>
              </div>
              <span className="bdg" style={{background:"#0a1626",color:RISK_PROB_C[r.probability],fontSize:9}}>{r.probability}</span>
              <span className="bdg" style={{background:"#0a1626",color:RISK_IMPACT_C[r.impact],fontSize:9}}>{r.impact}</span>
              <span className="bdg" style={{background:r.status==="open"?"#1a0808":r.status==="mitigated"?"#021f14":"#0a1626",color:r.status==="open"?"#f87171":r.status==="mitigated"?"#34d399":"#64748b",fontSize:9}}>{r.status}</span>
              <span style={{fontSize:11,color:"#475569",lineHeight:1.4}}>{r.mitigation?.slice(0,70)}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{r.owner}</span>
              <div style={{display:"flex",gap:4}}>
                {r.status==="open"&&<button className="btn bs" style={{padding:"2px 6px",fontSize:9}} onClick={()=>mitigate(r.id)}>Mitigate</button>}
                <button className="btn bg" style={{padding:"2px 6px",fontSize:10}} onClick={()=>open(r)}><I d={ICONS.edit} s={10}/></button>
                <button className="btn br" style={{padding:"2px 6px",fontSize:10}} onClick={()=>del(r.id)}><I d={ICONS.trash} s={10}/></button>
              </div>
            </div>
          );
        })}
      </div>

      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:520}}>
            <MH title={editing?"Edit Risk":"Log Risk"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Project"><select className="inp" value={form.projectId} onChange={e=>setForm({...form,projectId:e.target.value})}>
                <option value="">Select…</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select></FF>
              <FF label="Owner"><input className="inp" value={form.owner} onChange={e=>setForm({...form,owner:e.target.value})} placeholder="Manju / Suresh"/></FF>
              <FF label="Probability"><select className="inp" value={form.probability} onChange={e=>setForm({...form,probability:e.target.value})}>
                {["low","medium","high"].map(v=><option key={v}>{v}</option>)}
              </select></FF>
              <FF label="Impact"><select className="inp" value={form.impact} onChange={e=>setForm({...form,impact:e.target.value})}>
                {["low","medium","high"].map(v=><option key={v}>{v}</option>)}
              </select></FF>
              <FF label="Status"><select className="inp" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
                {["open","mitigated","closed"].map(v=><option key={v}>{v}</option>)}
              </select></FF>
            </div>
            <FF label="Risk Title"><input className="inp" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="Describe the risk…"/></FF>
            <FF label="Mitigation Plan"><textarea className="inp" rows={3} value={form.mitigation} onChange={e=>setForm({...form,mitigation:e.target.value})} placeholder="How will this risk be mitigated?"/></FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save Risk</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjCapacity({ projects, roster, tasks }) {
  // Build per-consultant allocation
  const today   = TODAY_STR;
  const active  = projects.filter(p=>p.status==="active"||p.status==="planning");

  const consultantLoad = roster.map(r=>{
    const assignedProj = active.filter(p=>p.consultants?.includes(r.id));
    const openTasks    = tasks.filter(t=>t.assignee===r.id&&t.status!=="done").length;
    const utilization  = r.util || 0;
    return { ...r, assignedProj, openTasks, utilization };
  });

  // Skills matrix
  const skillsSet = [...new Set(roster.flatMap(r=>r.skills||[]))];

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Billable",     v:roster.filter(r=>r.util>0).length,    c:"#34d399"},
          {l:"On Bench",     v:roster.filter(r=>r.util===0).length,  c:"#f87171"},
          {l:"Fully loaded", v:roster.filter(r=>r.util>=1).length,   c:"#f59e0b"},
          {l:"Available",    v:roster.filter(r=>r.util<0.8&&r.util>0).length, c:"#38bdf8"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:24,fontWeight:800,color:k.c}}>{k.v}</div>
          </div>
        ))}
      </div>

      {/* Allocation view */}
      <div className="card" style={{marginBottom:16,overflowX:"auto"}}>
        <div className="section-hdr">Consultant Allocation & Project Coverage</div>
        {consultantLoad.map(c=>(
          <div key={c.id} className="tr" style={{gridTemplateColumns:"1.4fr 80px 1fr 80px 1fr"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{c.name}</div>
              <div style={{fontSize:10,color:"#3d5a7a"}}>{c.role} · {c.type}</div>
            </div>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:c.utilization>=0.8?"#34d399":c.utilization>=0.4?"#f59e0b":"#f87171"}}>{pct(c.utilization)}</div>
              <div style={{height:5,background:"#0a1626",borderRadius:3,marginTop:3,width:60}}>
                <div style={{height:5,borderRadius:3,background:c.utilization>=0.8?"#34d399":c.utilization>=0.4?"#f59e0b":"#f87171",width:`${c.utilization*100}%`}}/>
              </div>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
              {c.assignedProj.map(p=><span key={p.id} className="bdg" style={{background:"#0c2340",color:"#7dd3fc",fontSize:9}}>{p.name.slice(0,18)}</span>)}
              {c.assignedProj.length===0&&<span style={{fontSize:10,color:"#1e3a5f"}}>On bench</span>}
            </div>
            <div style={{fontSize:12,color:c.openTasks>3?"#f59e0b":"#64748b",fontWeight:c.openTasks>3?700:400}}>
              {c.openTasks} task{c.openTasks!==1?"s":""}
            </div>
            <div style={{fontSize:11,color:"#3d5a7a"}}>{c.client}</div>
          </div>
        ))}
      </div>

      {/* Skills matrix */}
      <div className="card">
        <div className="section-hdr">Skills Matrix</div>
        <div style={{overflowX:"auto",paddingBottom:4}}>
          <table style={{borderCollapse:"collapse",minWidth:"100%"}}>
            <thead>
              <tr>
                <th style={{fontSize:11,color:"#2d4a63",textAlign:"left",padding:"6px 14px",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",borderBottom:"1px solid #111d2d"}}>Consultant</th>
                {["SAP BRIM","SAP IS-U","ABAP","S/4HANA","AWS","Databricks","BTP","CPI"].map(skill=>(
                  <th key={skill} style={{fontSize:9,color:"#2d4a63",textAlign:"center",padding:"6px 8px",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",borderBottom:"1px solid #111d2d",minWidth:64}}>{skill}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roster.map(r=>{
                const skills = (r.skills||"").toLowerCase();
                return (
                  <tr key={r.id} style={{borderBottom:"1px solid #0a1626"}}>
                    <td style={{padding:"8px 14px"}}>
                      <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{r.name}</div>
                      <div style={{fontSize:10,color:"#3d5a7a"}}>{r.role}</div>
                    </td>
                    {["brim","is-u","abap","s/4hana","aws","databricks","btp","cpi"].map(skill=>(
                      <td key={skill} style={{textAlign:"center",padding:"8px"}}>
                        {skills.includes(skill)
                          ? <div style={{width:18,height:18,borderRadius:"50%",background:"#034d2f",border:"1px solid #34d399",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                              <span style={{fontSize:11,color:"#34d399"}}>✓</span>
                            </div>
                          : <div style={{width:18,height:18,borderRadius:"50%",background:"#0a1626",margin:"0 auto"}}/>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORG & ACCESS MODULE
// ═══════════════════════════════════════════════════════════════════════════════
const PERM_LEVELS  = ["full","view","none"];
const PERM_COLOR   = { full:"#34d399", view:"#7dd3fc", none:"#1e3a5f" };
const PERM_BG      = { full:"#021f14", view:"#0c2340", none:"#070b14" };
const PERM_LABEL   = { full:"Full",    view:"View",    none:"—"       };



function OrgAccessModule({ orgMembers, setOrgMembers, roster }) {
  const [sub, setSub] = useState("chart");
  const tabs = [
    { id:"chart",   label:"Org Chart"        },
    { id:"members", label:"Team Members"     },
    { id:"access",  label:"Access Matrix"    },
    { id:"roles",   label:"Role Templates"   },
    { id:"approvals", label:"👤 User Approvals" },
  ];
  const props = { orgMembers, setOrgMembers, roster };
  return (
    <div>
      <PH title="Org & Access" sub="Company Structure · Roles · Module Permissions"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {sub==="chart"   && <OrgChart   {...props}/>}
      {sub==="members" && <OrgMembers {...props}/>}
      {sub==="access"  && <AccessMatrix {...props}/>}
      {sub==="roles"   && <RoleTemplates/>}
      {sub==="approvals" && <UserApprovalsPanel />}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getEffectivePerms(member) {
  const base = ROLE_TEMPLATES[member.role]?.perms || {};
  return { ...base, ...(member.customPerms||{}) };
}

function Avatar({ name, role, size=36 }) {
  const initials = name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const roleC = ROLE_TEMPLATES[role]?.color || "#64748b";
  return (
    <div style={{width:size,height:size,borderRadius:"50%",background:ROLE_TEMPLATES[role]?.bg||"#0a1626",
      border:`2px solid ${roleC}`,display:"flex",alignItems:"center",justifyContent:"center",
      fontSize:size*0.35,fontWeight:700,color:roleC,flexShrink:0}}>
      {initials}
    </div>
  );
}

// ── Org Chart ─────────────────────────────────────────────────────────────────



// ═══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// HOME PAGE TILES (module-level — no TDZ issues)
// ══════════════════════════════════════════════════════════════════
function HomeTile({ icon, label, value, sub, color, onClick }) {
  return (
    <div onClick={onClick} style={{
      background:"#0a1120", border:"1px solid #1a2d45", borderRadius:12,
      padding:"16px 18px", cursor:onClick?"pointer":"default", transition:"border-color 0.15s"
    }}
    onMouseEnter={e=>{ if(onClick) e.currentTarget.style.borderColor="#2a4d75"; }}
    onMouseLeave={e=>{ if(onClick) e.currentTarget.style.borderColor="#1a2d45"; }}>
      <div style={{fontSize:22,marginBottom:6}}>{icon}</div>
      <div style={{fontSize:22,fontWeight:800,color:color||"#38bdf8",fontFamily:"'DM Mono',monospace",lineHeight:1}}>{value}</div>
      <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginTop:4}}>{label}</div>
      {sub&&<div style={{fontSize:10,color:"#475569",marginTop:3}}>{sub}</div>}
    </div>
  );
}

function HomeAlert({ alert: a, onDismiss, onNavigate }) {
  const cols = {
    red:  {bg:"#2d0a0a",border:"#7f1d1d",text:"#fca5a5",dot:"#ef4444"},
    amber:{bg:"#2d1f00",border:"#92400e",text:"#fcd34d",dot:"#f59e0b"},
    blue: {bg:"#0c1a2e",border:"#1e3a5f",text:"#7dd3fc",dot:"#38bdf8"},
    green:{bg:"#022c22",border:"#065f46",text:"#6ee7b7",dot:"#34d399"},
  };
  const col = cols[a.type] || cols.blue;
  return (
    <div style={{display:"flex",alignItems:"center",gap:12,background:col.bg,
      border:`1px solid ${col.border}`,borderRadius:8,padding:"10px 14px",cursor:"pointer",marginBottom:6}}
      onClick={()=>onNavigate(a.tab)}>
      <div style={{width:8,height:8,borderRadius:"50%",background:col.dot,flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{fontSize:12,fontWeight:600,color:col.text}}>{a.icon} {a.title}</div>
        <div style={{fontSize:10,color:"#475569",marginTop:2}}>{a.sub}</div>
      </div>
      <span style={{fontSize:11,color:"#3d5a7a"}}>View →</span>
      <button onClick={e=>{e.stopPropagation();onDismiss(a.id);}}
        style={{background:"none",border:"none",color:"#334155",cursor:"pointer",fontSize:16,padding:"0 2px"}}>×</button>
    </div>
  );
}

function HomePage({ roster, clients, finInvoices, crmDeals, candidates,
  workAuth, ptoRequests, auditLog, authProfile, setTab,
  dismissedAlerts, setDismissedAlerts }) {

  const [weather, setWeather] = useState(null);
  const [todos, setTodos]     = useState(()=>{ try{return JSON.parse(localStorage.getItem("zt-home-todos")||"[]")}catch{return [];} });
  const [newTodo, setNewTodo] = useState("");
  const [time, setTime]       = useState(new Date());

  useEffect(()=>{ const t=setInterval(()=>setTime(new Date()),1000); return()=>clearInterval(t); },[]);

  useEffect(()=>{
    fetch("https://api.open-meteo.com/v1/forecast?latitude=33.1507&longitude=-96.8236&current=temperature_2m,weathercode,windspeed_10m,relative_humidity_2m&temperature_unit=fahrenheit&timezone=America%2FChicago")
      .then(r=>r.json()).then(d=>{
        const cur=d.current;
        const codes={0:"☀️ Clear",1:"🌤 Mostly Clear",2:"⛅ Partly Cloudy",3:"☁️ Overcast",51:"🌦 Drizzle",61:"🌧 Rain",63:"🌧 Moderate Rain",80:"🌦 Showers",95:"⛈ Thunderstorm"};
        setWeather({temp:Math.round(cur.temperature_2m),condition:codes[cur.weathercode]||"🌡 "+cur.weathercode,humidity:cur.relative_humidity_2m,wind:Math.round(cur.windspeed_10m)});
      }).catch(()=>{});
  },[]);

  const saveTodos = t => { setTodos(t); localStorage.setItem("zt-home-todos",JSON.stringify(t)); };
  const addTodo   = ()=>{ if(!newTodo.trim())return; saveTodos([...todos,{id:Date.now(),text:newTodo.trim(),done:false}]); setNewTodo(""); };
  const toggleTodo= id=>saveTodos(todos.map(t=>t.id===id?{...t,done:!t.done}:t));
  const deleteTodo= id=>saveTodos(todos.filter(t=>t.id!==id));

  const today = new Date();
  const hr = today.getHours();
  const greeting = hr<12?"Good morning":hr<17?"Good afternoon":"Good evening";
  const dayStr = today.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  const fmtV = v => v>=1000000?`$${(v/1e6).toFixed(1)}M`:v>=1000?`$${(v/1000).toFixed(0)}k`:`$${v}`;

  const totalRev     = clients.reduce((s,c)=>s+(c.annualRev||0),0);
  const overdueInv   = finInvoices.filter(i=>i.status==="overdue");
  const openDeals    = crmDeals.filter(d=>!["closed_won","closed_lost"].includes(d.stage));
  const expiringDocs = (workAuth||[]).filter(w=>{ if(!w.expiryDate)return false; const days=(new Date(w.expiryDate)-today)/86400000; return days>=0&&days<=60; });
  const pendingPTO   = (ptoRequests||[]).filter(p=>p.status==="pending").length;
  const activeCands  = (candidates||[]).filter(c=>!["rejected","hired"].includes(c.stage)).length;

  const rawAlerts = [
    overdueInv.length>0&&{id:"inv",type:"red",icon:"⚠️",title:`${overdueInv.length} Overdue Invoice${overdueInv.length>1?"s":""}`,sub:`${fmtV(overdueInv.reduce((s,i)=>s+(i.amount||0),0))} needs collection`,tab:"finance"},
    expiringDocs.length>0&&{id:"docs",type:"amber",icon:"📋",title:`${expiringDocs.length} Work Auth Expiring`,sub:"Within 60 days — action required",tab:"hr"},
    pendingPTO>0&&{id:"pto",type:"blue",icon:"🏖",title:`${pendingPTO} PTO Request${pendingPTO>1?"s":""}`,sub:"Awaiting your approval",tab:"pto"},
    activeCands>0&&{id:"hiring",type:"green",icon:"👤",title:`${activeCands} Active Candidate${activeCands>1?"s":""}`,sub:"In hiring pipeline",tab:"recruiting"},
    openDeals.length>0&&{id:"deals",type:"blue",icon:"💼",title:`${openDeals.length} Open Deal${openDeals.length>1?"s":""}`,sub:`${fmtV(openDeals.reduce((s,d)=>s+(d.value||0),0))} in pipeline`,tab:"crm"},
  ].filter(Boolean).filter(a=>!(dismissedAlerts||[]).includes(a.id));

  return (
    <div>
      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:22,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:24,fontWeight:800,color:"#e2e8f0"}}>{greeting}, {authProfile?.full_name?.split(" ")[0]||"Manju"} 👋</div>
          <div style={{fontSize:13,color:"#475569",marginTop:3}}>{dayStr}</div>
        </div>
        <div style={{fontSize:26,fontWeight:700,color:"#38bdf8",fontFamily:"'DM Mono',monospace",letterSpacing:2}}>
          {time.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 310px",gap:18,alignItems:"start"}}>
        {/* LEFT */}
        <div>
          {/* Stat Tiles Row 1 */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:12}}>
            <HomeTile icon="💰" label="Annual Revenue" value={fmtV(totalRev)} sub="All clients" color="#34d399" onClick={()=>setTab("dashboard")}/>
            <HomeTile icon="👥" label="Active Consultants" value={roster.filter(r=>r.util>0).length} sub={`of ${roster.length} total`} color="#38bdf8" onClick={()=>setTab("roster")}/>
            <HomeTile icon="💼" label="Open Pipeline" value={fmtV(openDeals.reduce((s,d)=>s+(d.value||0),0))} sub={`${openDeals.length} deals`} color="#a78bfa" onClick={()=>setTab("crm")}/>
            <HomeTile icon="⚠️" label="Overdue A/R" value={overdueInv.length>0?fmtV(overdueInv.reduce((s,i)=>s+(i.amount||0),0)):"$0"} sub={overdueInv.length>0?`${overdueInv.length} invoices`:"All clear"} color={overdueInv.length>0?"#f87171":"#34d399"} onClick={()=>setTab("finance")}/>
          </div>
          {/* Stat Tiles Row 2 */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
            <HomeTile icon="📋" label="Expiring Docs" value={expiringDocs.length} sub="Work auth ≤60 days" color={expiringDocs.length>0?"#f59e0b":"#34d399"} onClick={()=>setTab("hr")}/>
            <HomeTile icon="🏖" label="Pending PTO" value={pendingPTO} sub="Awaiting approval" color={pendingPTO>0?"#f59e0b":"#34d399"} onClick={()=>setTab("pto")}/>
            <HomeTile icon="🎯" label="Hiring Pipeline" value={activeCands} sub="Active candidates" color="#60a5fa" onClick={()=>setTab("recruiting")}/>
            <HomeTile icon="🏢" label="Active Clients" value={clients.filter(c=>c.health!=="Red").length} sub={`of ${clients.length} total`} color="#34d399" onClick={()=>setTab("clients")}/>
          </div>

          {/* Alerts */}
          <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:12,padding:"16px 18px",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>🔔 Notifications & Alerts</span>
              {rawAlerts.length>0&&<span style={{background:"#ef4444",color:"#fff",fontSize:10,fontWeight:700,borderRadius:10,padding:"1px 7px"}}>{rawAlerts.length}</span>}
            </div>
            {rawAlerts.length===0
              ? <div style={{textAlign:"center",padding:"16px 0",color:"#334155",fontSize:13}}>✅ All clear — no pending alerts</div>
              : rawAlerts.map(a=><HomeAlert key={a.id} alert={a} onDismiss={id=>setDismissedAlerts(p=>[...(p||[]),id])} onNavigate={setTab}/>)
            }
          </div>

          {/* Recent Activity */}
          <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:12,padding:"16px 18px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",marginBottom:12}}>📜 Recent Activity</div>
            {!(auditLog||[]).length
              ? <div style={{color:"#334155",fontSize:12,textAlign:"center",padding:"12px 0"}}>No recent activity</div>
              : (auditLog||[]).slice(0,6).map((log,i)=>(
                <div key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 0",borderBottom:i<5?"1px solid #0a1420":"none"}}>
                  <div style={{width:28,height:28,borderRadius:8,background:"#0f1e30",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>
                    {log.module==="Timesheet"?"⏱":log.module==="Invoice"?"🧾":log.module==="Settings"?"⚙️":log.module==="PTO"?"🏖":"📝"}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,color:"#cbd5e1",fontWeight:500}}>{log.action}</div>
                    <div style={{fontSize:10,color:"#334155",marginTop:2}}>{log.module} · {log.user} · {log.timestamp?new Date(log.timestamp).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):""}</div>
                  </div>
                </div>
              ))
            }
          </div>
        </div>

        {/* RIGHT */}
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {/* Weather */}
          <div style={{background:"linear-gradient(135deg,#0c1e3d,#0a1829)",border:"1px solid #1e3a5f",borderRadius:12,padding:"18px 20px"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>🌍 Weather · Frisco, TX</div>
            {weather
              ? <>
                  <div style={{display:"flex",alignItems:"flex-end",gap:6,marginBottom:6}}>
                    <div style={{fontSize:46,fontWeight:800,color:"#e2e8f0",lineHeight:1}}>{weather.temp}°</div>
                    <div style={{fontSize:13,color:"#94a3b8",marginBottom:6}}>F</div>
                  </div>
                  <div style={{fontSize:14,color:"#7dd3fc",fontWeight:600,marginBottom:12}}>{weather.condition}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[{label:"Humidity",value:weather.humidity+"%",icon:"💧"},{label:"Wind",value:weather.wind+" mph",icon:"💨"}].map(w=>(
                      <div key={w.label} style={{background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"8px 10px"}}>
                        <div style={{fontSize:10,color:"#475569"}}>{w.icon} {w.label}</div>
                        <div style={{fontSize:14,fontWeight:700,color:"#cbd5e1",marginTop:2}}>{w.value}</div>
                      </div>
                    ))}
                  </div>
                </>
              : <div style={{color:"#334155",fontSize:13,textAlign:"center",padding:"20px 0"}}>Loading weather…</div>
            }
          </div>

          {/* To-Do */}
          <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:12,padding:"16px 18px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",marginBottom:12}}>
              ✅ My To-Do <span style={{fontSize:10,color:"#334155",fontWeight:400}}>{todos.filter(t=>!t.done).length} remaining</span>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <input className="inp" value={newTodo} onChange={e=>setNewTodo(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&addTodo()} placeholder="Add a task…"
                style={{flex:1,fontSize:12,padding:"7px 10px"}}/>
              <button onClick={addTodo} style={{background:"#0369a1",border:"none",borderRadius:7,color:"#fff",padding:"0 12px",cursor:"pointer",fontSize:16,fontWeight:700}}>+</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:220,overflowY:"auto"}}>
              {todos.length===0&&<div style={{color:"#334155",fontSize:12,textAlign:"center",padding:"10px 0"}}>No tasks yet</div>}
              {todos.map(todo=>(
                <div key={todo.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:"#0a1120",borderRadius:8,border:"1px solid #1a2d45"}}>
                  <input type="checkbox" checked={todo.done} onChange={()=>toggleTodo(todo.id)} style={{accentColor:"#0369a1",cursor:"pointer",flexShrink:0}}/>
                  <span style={{flex:1,fontSize:12,color:todo.done?"#334155":"#cbd5e1",textDecoration:todo.done?"line-through":"none"}}>{todo.text}</span>
                  <button onClick={()=>deleteTodo(todo.id)} style={{background:"none",border:"none",color:"#334155",cursor:"pointer",fontSize:15,padding:"0 2px"}}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Actions */}
          <div style={{background:"#060d1c",border:"1px solid #1a2d45",borderRadius:12,padding:"16px 18px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",marginBottom:12}}>⚡ Quick Actions</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[{icon:"👥",label:"Team Roster",tab:"roster"},{icon:"🧾",label:"Invoices",tab:"finance"},{icon:"📊",label:"Dashboard",tab:"dashboard"},{icon:"🎯",label:"CRM",tab:"crm"},{icon:"⏱",label:"Timesheets",tab:"timesheet"},{icon:"📋",label:"Reports",tab:"reports"}].map(q=>(
                <button key={q.tab} onClick={()=>setTab(q.tab)}
                  style={{background:"#0a1120",border:"1px solid #1a2d45",borderRadius:8,color:"#94a3b8",fontSize:11,fontWeight:600,padding:"8px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.background="#0f1e30";e.currentTarget.style.color="#e2e8f0";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="#0a1120";e.currentTarget.style.color="#94a3b8";}}>
                  {q.icon} {q.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function HomePage({ roster, clients, tsHours, finInvoices, finPayments, crmDeals,
  candidates, offers, compDocs, workAuth, ptoRequests, auditLog, authProfile, setTab,
  dismissedAlerts, setDismissedAlerts }) {

  // ── Weather ──────────────────────────────────────────────────────────────
  const [weather, setWeather] = useState(null);
  const [todos, setTodos] = useState(() => {
    try { return JSON.parse(localStorage.getItem("zt-todos") || "[]"); } catch { return []; }
  });
  const [newTodo, setNewTodo] = useState("");
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // Fetch weather for Frisco TX using Open-Meteo (free, no key needed)
    fetch("https://api.open-meteo.com/v1/forecast?latitude=33.1507&longitude=-96.8236&current=temperature_2m,weathercode,windspeed_10m,relative_humidity_2m&temperature_unit=fahrenheit&timezone=America%2FChicago")
      .then(r => r.json())
      .then(d => {
        const cur = d.current;
        const codes = { 0:"☀️ Clear", 1:"🌤 Mostly Clear", 2:"⛅ Partly Cloudy", 3:"☁️ Overcast",
          45:"🌫 Foggy", 48:"🌫 Icy Fog", 51:"🌦 Light Drizzle", 61:"🌧 Light Rain",
          63:"🌧 Moderate Rain", 65:"🌧 Heavy Rain", 71:"❄️ Light Snow", 73:"❄️ Moderate Snow",
          75:"❄️ Heavy Snow", 80:"🌦 Rain Showers", 81:"🌧 Heavy Showers", 95:"⛈ Thunderstorm" };
        setWeather({
          temp: Math.round(cur.temperature_2m),
          condition: codes[cur.weathercode] || "🌡 " + cur.weathercode,
          humidity: cur.relative_humidity_2m,
          wind: Math.round(cur.windspeed_10m),
          location: "Frisco, TX"
        });
      }).catch(() => {});
  }, []);

  // ── Todo helpers ─────────────────────────────────────────────────────────
  const saveTodos = (t) => { setTodos(t); localStorage.setItem("zt-todos", JSON.stringify(t)); };
  const addTodo = () => {
    if (!newTodo.trim()) return;
    saveTodos([...todos, { id: Date.now(), text: newTodo.trim(), done: false, createdAt: new Date().toISOString() }]);
    setNewTodo("");
  };
  const toggleTodo = (id) => saveTodos(todos.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const deleteTodo = (id) => saveTodos(todos.filter(t => t.id !== id));

  // ── Computed stats ───────────────────────────────────────────────────────
  const today = new Date();
  const greeting = today.getHours() < 12 ? "Good morning" : today.getHours() < 17 ? "Good afternoon" : "Good evening";
  const dayName = today.toLocaleDateString("en-US", { weekday:"long" });
  const dateStr = today.toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });

  const totalRev = clients.reduce((s, c) => s + (c.annualRev || 0), 0);
  const activeConsultants = roster.filter(r => r.util > 0).length;
  const overdueInvoices = finInvoices.filter(i => i.status === "overdue").length;
  const overdueAmt = finInvoices.filter(i => i.status === "overdue").reduce((s, i) => s + (i.amount || 0), 0);
  const openDeals = crmDeals.filter(d => !["closed_won","closed_lost"].includes(d.stage)).length;
  const openDealVal = crmDeals.filter(d => !["closed_won","closed_lost"].includes(d.stage)).reduce((s, d) => s + (d.value || 0), 0);
  const expiringDocs = workAuth.filter(w => {
    if (!w.expiryDate) return false;
    const days = (new Date(w.expiryDate) - today) / 86400000;
    return days >= 0 && days <= 60;
  }).length;
  const pendingPTO = (ptoRequests || []).filter(p => p.status === "pending").length;
  const activeCandidates = candidates.filter(c => !["rejected","hired"].includes(c.stage)).length;

  // ── Notifications (smart alerts) ─────────────────────────────────────────
  const alerts = [
    overdueInvoices > 0 && { id:"inv", type:"red", icon:"⚠️", title:`${overdueInvoices} Overdue Invoice${overdueInvoices>1?"s":""}`, sub:`$${(overdueAmt/1000).toFixed(0)}k needs collection`, tab:"finance" },
    expiringDocs > 0 && { id:"docs", type:"amber", icon:"📋", title:`${expiringDocs} Work Auth Expiring`, sub:"Within 60 days — action required", tab:"hr" },
    pendingPTO > 0 && { id:"pto", type:"blue", icon:"🏖", title:`${pendingPTO} PTO Request${pendingPTO>1?"s":""}`, sub:"Awaiting your approval", tab:"pto" },
    activeCandidates > 0 && { id:"hiring", type:"green", icon:"👤", title:`${activeCandidates} Active Candidate${activeCandidates>1?"s":""}`, sub:"In hiring pipeline", tab:"recruiting" },
    openDeals > 0 && { id:"deals", type:"blue", icon:"💼", title:`${openDeals} Open Deal${openDeals>1?"s":""}`, sub:`$${(openDealVal/1000).toFixed(0)}k in pipeline`, tab:"crm" },
  ].filter(Boolean).filter(a => !(dismissedAlerts||[]).includes(a.id));

  const alertColors = {
    red:   { bg:"#2d0a0a", border:"#7f1d1d", text:"#fca5a5", dot:"#ef4444" },
    amber: { bg:"#2d1f00", border:"#92400e", text:"#fcd34d", dot:"#f59e0b" },
    blue:  { bg:"#0c1a2e", border:"#1e3a5f", text:"#7dd3fc", dot:"#38bdf8" },
    green: { bg:"#022c22", border:"#065f46", text:"#6ee7b7", dot:"#34d399" },
  };

  // ── Tile helpers ─────────────────────────────────────────────────────────
  const Tile = ({ icon, label, value, sub, color="#38bdf8", onClick, span=1 }) => (
    <div onClick={onClick} style={{
      background:"#0a1120", border:"1px solid #1a2d45", borderRadius:12, padding:"16px 18px",
      cursor:onClick?"pointer":"default", transition:"border-color 0.15s",
      gridColumn: span > 1 ? `span ${span}` : undefined,
    }}
    onMouseEnter={e => onClick && (e.currentTarget.style.borderColor="#2a4d75")}
    onMouseLeave={e => onClick && (e.currentTarget.style.borderColor="#1a2d45")}>
      <div style={{fontSize:22, marginBottom:6}}>{icon}</div>
      <div style={{fontSize:22, fontWeight:800, color, fontFamily:"'DM Mono',monospace", lineHeight:1}}>{value}</div>
      <div style={{fontSize:12, fontWeight:600, color:"#cbd5e1", marginTop:4}}>{label}</div>
      {sub && <div style={{fontSize:10, color:"#475569", marginTop:3}}>{sub}</div>}
    </div>
  );

  const fmt = v => v >= 1000000 ? `$${(v/1000000).toFixed(1)}M` : v >= 1000 ? `$${(v/1000).toFixed(0)}k` : `$${v}`;

  return (
    <div>
      {/* ── Header: Greeting + Date/Time ── */}
      <div style={{display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24, flexWrap:"wrap", gap:12}}>
        <div>
          <div style={{fontSize:24, fontWeight:800, color:"#e2e8f0"}}>
            {greeting}, {authProfile?.full_name?.split(" ")[0] || "Manju"} 👋
          </div>
          <div style={{fontSize:13, color:"#475569", marginTop:4}}>{dayName}, {dateStr}</div>
        </div>
        <div style={{fontSize:28, fontWeight:700, color:"#38bdf8", fontFamily:"'DM Mono',monospace", letterSpacing:2}}>
          {time.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit", second:"2-digit"})}
        </div>
      </div>

      <div style={{display:"grid", gridTemplateColumns:"1fr 320px", gap:18, alignItems:"start"}}>
        {/* ── LEFT COLUMN ── */}
        <div>

          {/* ── Quick Stats Tiles ── */}
          <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:18}}>
            <Tile icon="💰" label="Annual Revenue" value={fmt(totalRev)} sub="All clients" color="#34d399" onClick={()=>setTab("dashboard")}/>
            <Tile icon="👥" label="Active Consultants" value={activeConsultants} sub={`of ${roster.length} total`} color="#38bdf8" onClick={()=>setTab("roster")}/>
            <Tile icon="💼" label="Open Pipeline" value={fmt(openDealVal)} sub={`${openDeals} deals`} color="#a78bfa" onClick={()=>setTab("crm")}/>
            <Tile icon="⚠️" label="Overdue A/R" value={overdueInvoices > 0 ? fmt(overdueAmt) : "$0"} sub={overdueInvoices > 0 ? `${overdueInvoices} invoices` : "All clear"} color={overdueInvoices > 0 ? "#f87171" : "#34d399"} onClick={()=>setTab("finance")}/>
          </div>

          <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:18}}>
            <Tile icon="📋" label="Expiring Docs" value={expiringDocs} sub="Work auth ≤60 days" color={expiringDocs > 0 ? "#f59e0b" : "#34d399"} onClick={()=>setTab("hr")}/>
            <Tile icon="🏖" label="Pending PTO" value={pendingPTO} sub="Awaiting approval" color={pendingPTO > 0 ? "#f59e0b" : "#34d399"} onClick={()=>setTab("pto")}/>
            <Tile icon="🎯" label="Hiring Pipeline" value={activeCandidates} sub="Active candidates" color="#60a5fa" onClick={()=>setTab("recruiting")}/>
            <Tile icon="🏢" label="Active Clients" value={clients.filter(c=>c.health!=="Red").length} sub={`of ${clients.length} total`} color="#34d399" onClick={()=>setTab("clients")}/>
          </div>

          {/* ── Notifications / Alerts ── */}
          <div style={{background:"#060d1c", border:"1px solid #1a2d45", borderRadius:12, padding:"16px 18px", marginBottom:18}}>
            <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14}}>
              <div style={{fontSize:13, fontWeight:700, color:"#e2e8f0", display:"flex", alignItems:"center", gap:8}}>
                🔔 Notifications & Alerts
                {alerts.length > 0 && <span style={{background:"#ef4444", color:"#fff", fontSize:10, fontWeight:700, borderRadius:10, padding:"1px 7px"}}>{alerts.length}</span>}
              </div>
            </div>
            {alerts.length === 0 ? (
              <div style={{textAlign:"center", padding:"20px 0", color:"#334155", fontSize:13}}>
                ✅ All clear — no pending alerts
              </div>
            ) : (
              <div style={{display:"flex", flexDirection:"column", gap:8}}>
                {alerts.map(a => {
                  const col = alertColors[a.type];
                  return (
                    <div key={a.id} style={{display:"flex", alignItems:"center", gap:12, background:col.bg,
                      border:`1px solid ${col.border}`, borderRadius:8, padding:"10px 14px", cursor:"pointer"}}
                      onClick={()=>setTab(a.tab)}>
                      <div style={{width:8, height:8, borderRadius:"50%", background:col.dot, flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{fontSize:12, fontWeight:600, color:col.text}}>{a.icon} {a.title}</div>
                        <div style={{fontSize:10, color:"#475569", marginTop:2}}>{a.sub}</div>
                      </div>
                      <div style={{display:"flex", alignItems:"center", gap:8}}>
                        <span style={{fontSize:11, color:"#3d5a7a"}}>View →</span>
                        <button onClick={e=>{e.stopPropagation(); setDismissedAlerts(prev=>[...(prev||[]),a.id]);}}
                          style={{background:"none", border:"none", color:"#334155", cursor:"pointer", fontSize:14, padding:"0 2px"}}>×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Recent Activity ── */}
          <div style={{background:"#060d1c", border:"1px solid #1a2d45", borderRadius:12, padding:"16px 18px"}}>
            <div style={{fontSize:13, fontWeight:700, color:"#e2e8f0", marginBottom:14}}>📜 Recent Activity</div>
            {(auditLog||[]).length === 0 ? (
              <div style={{color:"#334155", fontSize:12, textAlign:"center", padding:"16px 0"}}>No recent activity</div>
            ) : (
              <div style={{display:"flex", flexDirection:"column", gap:0}}>
                {(auditLog||[]).slice(0,6).map((log, i) => (
                  <div key={i} style={{display:"flex", alignItems:"flex-start", gap:12, padding:"8px 0",
                    borderBottom: i < Math.min(5, (auditLog||[]).length-1) ? "1px solid #0a1420" : "none"}}>
                    <div style={{width:28, height:28, borderRadius:8, background:"#0f1e30", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, flexShrink:0}}>
                      {log.module==="Timesheet"?"⏱":log.module==="Invoice"?"🧾":log.module==="Settings"?"⚙️":log.module==="PTO"?"🏖":"📝"}
                    </div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:12, color:"#cbd5e1", fontWeight:500}}>{log.action}</div>
                      <div style={{fontSize:10, color:"#334155", marginTop:2}}>{log.module} · {log.user} · {log.timestamp ? new Date(log.timestamp).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div style={{display:"flex", flexDirection:"column", gap:14}}>

          {/* ── Weather ── */}
          <div style={{background:"linear-gradient(135deg,#0c1e3d,#0a1829)", border:"1px solid #1e3a5f", borderRadius:12, padding:"18px 20px"}}>
            <div style={{fontSize:11, fontWeight:700, color:"#3d5a7a", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:12}}>🌍 Weather · Frisco, TX</div>
            {weather ? (
              <>
                <div style={{display:"flex", alignItems:"flex-end", gap:8, marginBottom:8}}>
                  <div style={{fontSize:48, fontWeight:800, color:"#e2e8f0", lineHeight:1}}>{weather.temp}°</div>
                  <div style={{fontSize:13, color:"#94a3b8", marginBottom:8}}>F</div>
                </div>
                <div style={{fontSize:15, color:"#7dd3fc", fontWeight:600, marginBottom:12}}>{weather.condition}</div>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
                  {[
                    {label:"Humidity", value:weather.humidity+"%", icon:"💧"},
                    {label:"Wind", value:weather.wind+" mph", icon:"💨"},
                  ].map(w=>(
                    <div key={w.label} style={{background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px"}}>
                      <div style={{fontSize:10, color:"#475569"}}>{w.icon} {w.label}</div>
                      <div style={{fontSize:14, fontWeight:700, color:"#cbd5e1", marginTop:2}}>{w.value}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{color:"#334155", fontSize:13, textAlign:"center", padding:"20px 0"}}>Loading weather…</div>
            )}
          </div>

          {/* ── To-Do List ── */}
          <div style={{background:"#060d1c", border:"1px solid #1a2d45", borderRadius:12, padding:"16px 18px"}}>
            <div style={{fontSize:13, fontWeight:700, color:"#e2e8f0", marginBottom:12}}>
              ✅ My To-Do
              <span style={{fontSize:10, color:"#334155", fontWeight:400, marginLeft:8}}>
                {todos.filter(t=>!t.done).length} remaining
              </span>
            </div>

            {/* Add Todo */}
            <div style={{display:"flex", gap:8, marginBottom:12}}>
              <input className="inp" value={newTodo} onChange={e=>setNewTodo(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&addTodo()}
                placeholder="Add a task…" style={{flex:1, fontSize:12, padding:"7px 10px"}}/>
              <button onClick={addTodo} style={{background:"#0369a1", border:"none", borderRadius:7, color:"#fff",
                padding:"0 12px", cursor:"pointer", fontSize:16, fontWeight:700}}>+</button>
            </div>

            {/* Todo items */}
            <div style={{display:"flex", flexDirection:"column", gap:4, maxHeight:240, overflowY:"auto"}}>
              {todos.length === 0 && (
                <div style={{color:"#334155", fontSize:12, textAlign:"center", padding:"12px 0"}}>No tasks yet</div>
              )}
              {todos.map(todo => (
                <div key={todo.id} style={{display:"flex", alignItems:"center", gap:8, padding:"7px 10px",
                  background:"#0a1120", borderRadius:8, border:"1px solid #1a2d45"}}>
                  <input type="checkbox" checked={todo.done} onChange={()=>toggleTodo(todo.id)}
                    style={{accentColor:"#0369a1", cursor:"pointer", flexShrink:0}}/>
                  <span style={{flex:1, fontSize:12, color: todo.done?"#334155":"#cbd5e1",
                    textDecoration: todo.done?"line-through":"none"}}>{todo.text}</span>
                  <button onClick={()=>deleteTodo(todo.id)} style={{background:"none", border:"none",
                    color:"#334155", cursor:"pointer", fontSize:14, padding:"0 2px", lineHeight:1}}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* ── Quick Links ── */}
          <div style={{background:"#060d1c", border:"1px solid #1a2d45", borderRadius:12, padding:"16px 18px"}}>
            <div style={{fontSize:13, fontWeight:700, color:"#e2e8f0", marginBottom:12}}>⚡ Quick Actions</div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
              {[
                {icon:"👥", label:"Team Roster", tab:"roster"},
                {icon:"🧾", label:"Invoices", tab:"finance"},
                {icon:"📊", label:"Dashboard", tab:"dashboard"},
                {icon:"🎯", label:"CRM", tab:"crm"},
                {icon:"⏱", label:"Timesheets", tab:"timesheet"},
                {icon:"📋", label:"Reports", tab:"reports"},
              ].map(q => (
                <button key={q.tab} onClick={()=>setTab(q.tab)} style={{
                  background:"#0a1120", border:"1px solid #1a2d45", borderRadius:8,
                  color:"#94a3b8", fontSize:11, fontWeight:600, padding:"8px 10px",
                  cursor:"pointer", textAlign:"left", transition:"all 0.15s"
                }}
                onMouseEnter={e=>{e.currentTarget.style.background="#0f1e30"; e.currentTarget.style.color="#e2e8f0";}}
                onMouseLeave={e=>{e.currentTarget.style.background="#0a1120"; e.currentTarget.style.color="#94a3b8";}}>
                  {q.icon} {q.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}




// ═══════════════════════════════════════════════════════════════════════════════
// MY PROFILE — Team member personal info form
// ═══════════════════════════════════════════════════════════════════════════════
function MyProfilePage({ authProfile, authSession }) {
  const PROFILE_KEY = authProfile?.id ? `zt-profile-${authProfile.id}` : null;

  const blank = {
    firstName:"", lastName:"",
    cellPhone:"", altPhone:"", workPhone:"",
    currentAddress:"", currentCity:"", currentState:"", currentZip:"",
    intlAddress:"", intlCity:"", intlCountry:"", intlPhone:"",
    emergencyName:"", emergencyRelation:"", emergencyPhone:"", emergencyAltPhone:"",
    updatedAt:""
  };

  const [form, setForm] = useState(blank);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load existing profile data from Supabase
  useEffect(() => {
    if (!PROFILE_KEY || !supaAuth) { setLoading(false); return; }
    const sess = authSession || supaAuth.loadSession();
    if (!sess?.access_token) { setLoading(false); return; }
    const SUPA_URL = typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL;
    const SUPA_ANON = typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_ANON;
    if (!SUPA_URL) { setLoading(false); return; }
    fetch(`${SUPA_URL}/rest/v1/ops_store?key=eq.${PROFILE_KEY}&select=value`, {
      headers: { "apikey": SUPA_ANON, "Authorization": `Bearer ${sess.access_token}` }
    }).then(r => r.json()).then(rows => {
      if (rows?.[0]?.value) setForm({ ...blank, ...JSON.parse(rows[0].value) });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [PROFILE_KEY]);

  const saveProfile = async () => {
    if (!PROFILE_KEY || !supaAuth) return;
    const sess = authSession || supaAuth.loadSession();
    if (!sess?.access_token) return;
    const SUPA_URL = typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL;
    const SUPA_ANON = typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_ANON;
    if (!SUPA_URL) return;
    const payload = { ...form, updatedAt: new Date().toISOString() };
    await fetch(`${SUPA_URL}/rest/v1/ops_store?on_conflict=key`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "apikey":SUPA_ANON, "Authorization":`Bearer ${sess.access_token}`, "Prefer":"return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify({ key: PROFILE_KEY, value: JSON.stringify(payload), updated_at: new Date().toISOString() })
    });
    setForm(payload);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const f = (k) => (e) => setForm(prev => ({ ...prev, [k]: e.target.value }));

  const Section = ({ title, children }) => (
    <div className="card" style={{ padding:"20px 22px", marginBottom:16 }}>
      <div style={{ fontSize:12, fontWeight:700, color:"#3d5a7a", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:16, paddingBottom:10, borderBottom:"1px solid #0f1e30" }}>{title}</div>
      {children}
    </div>
  );

  const Row = ({ children }) => (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>{children}</div>
  );

  const Field = ({ label, value, onChange, type="text", placeholder="" }) => (
    <div>
      <div style={{ fontSize:11, fontWeight:600, color:"#64748b", marginBottom:5, letterSpacing:"0.04em" }}>{label}</div>
      <input className="inp" type={type} value={value} onChange={onChange} placeholder={placeholder}
        style={{ width:"100%", boxSizing:"border-box" }} />
    </div>
  );

  const FullField = ({ label, value, onChange, placeholder="" }) => (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:11, fontWeight:600, color:"#64748b", marginBottom:5, letterSpacing:"0.04em" }}>{label}</div>
      <input className="inp" value={value} onChange={onChange} placeholder={placeholder}
        style={{ width:"100%", boxSizing:"border-box" }} />
    </div>
  );

  if (loading) return <div style={{ padding:40, textAlign:"center", color:"#64748b" }}>Loading your profile…</div>;

  return (
    <div style={{ maxWidth:860 }}>
      <PH title="My Profile" sub="Personal info · Emergency contact · Contact details"/>

      {/* Name & Role banner */}
      <div style={{ display:"flex", alignItems:"center", gap:16, padding:"16px 20px", background:"#0a1120", border:"1px solid #1a2d45", borderRadius:12, marginBottom:20 }}>
        <Avatar name={(form.firstName||authProfile?.full_name||"?")} size={48}/>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:"#e2e8f0" }}>
            {form.firstName || form.lastName ? `${form.firstName} ${form.lastName}`.trim() : (authProfile?.full_name || "Your Name")}
          </div>
          <div style={{ fontSize:12, color:"#475569", marginTop:2, textTransform:"capitalize" }}>
            {authProfile?.role?.replace("_"," ")} · {authProfile?.email}
          </div>
        </div>
        {form.updatedAt && (
          <div style={{ marginLeft:"auto", fontSize:10, color:"#334155" }}>
            Last updated {new Date(form.updatedAt).toLocaleDateString()}
          </div>
        )}
      </div>

      {/* Personal Info */}
      <Section title="👤 Personal Information">
        <Row>
          <Field label="First Name *" value={form.firstName} onChange={f("firstName")} placeholder="Manju" />
          <Field label="Last Name *" value={form.lastName} onChange={f("lastName")} placeholder="Murthy" />
        </Row>
        <Row>
          <Field label="Cell Phone *" value={form.cellPhone} onChange={f("cellPhone")} type="tel" placeholder="+1 (555) 000-0000" />
          <Field label="Alternative Phone" value={form.altPhone} onChange={f("altPhone")} type="tel" placeholder="+1 (555) 000-0001" />
        </Row>
        <Row>
          <Field label="Work / Office Phone" value={form.workPhone} onChange={f("workPhone")} type="tel" placeholder="+1 (555) 000-0002" />
        </Row>
      </Section>

      {/* Current US Address */}
      <Section title="🏠 Current Address (US)">
        <FullField label="Street Address" value={form.currentAddress} onChange={f("currentAddress")} placeholder="123 Main Street, Apt 4B" />
        <Row>
          <Field label="City" value={form.currentCity} onChange={f("currentCity")} placeholder="Frisco" />
          <Field label="State" value={form.currentState} onChange={f("currentState")} placeholder="TX" />
        </Row>
        <Row>
          <Field label="ZIP Code" value={form.currentZip} onChange={f("currentZip")} placeholder="75034" />
        </Row>
      </Section>

      {/* Address Outside US */}
      <Section title="✈️ Address Outside US (Home Country)">
        <FullField label="Street Address" value={form.intlAddress} onChange={f("intlAddress")} placeholder="123 Street Name" />
        <Row>
          <Field label="City" value={form.intlCity} onChange={f("intlCity")} placeholder="Hyderabad" />
          <Field label="Country" value={form.intlCountry} onChange={f("intlCountry")} placeholder="India" />
        </Row>
        <Row>
          <Field label="Phone Number (International)" value={form.intlPhone} onChange={f("intlPhone")} type="tel" placeholder="+91 98765 43210" />
        </Row>
      </Section>

      {/* Emergency Contact */}
      <Section title="🚨 Emergency Contact">
        <Row>
          <Field label="Contact Name *" value={form.emergencyName} onChange={f("emergencyName")} placeholder="Spouse / Parent name" />
          <Field label="Relationship" value={form.emergencyRelation} onChange={f("emergencyRelation")} placeholder="Spouse, Parent, Sibling…" />
        </Row>
        <Row>
          <Field label="Primary Phone *" value={form.emergencyPhone} onChange={f("emergencyPhone")} type="tel" placeholder="+1 (555) 000-0000" />
          <Field label="Alternative Phone" value={form.emergencyAltPhone} onChange={f("emergencyAltPhone")} type="tel" placeholder="+1 (555) 000-0001" />
        </Row>
      </Section>

      {/* Save */}
      <div style={{ display:"flex", alignItems:"center", gap:14, marginTop:4 }}>
        <button className="btn bp" style={{ padding:"11px 32px", fontSize:14, fontWeight:700 }} onClick={saveProfile}>
          Save Profile
        </button>
        {saved && (
          <span style={{ fontSize:13, color:"#34d399", fontWeight:600, display:"flex", alignItems:"center", gap:6 }}>
            ✓ Profile saved successfully
          </span>
        )}
      </div>

      <div style={{ marginTop:16, padding:"10px 14px", background:"#060d1c", borderRadius:8, border:"1px solid #0f1e30", fontSize:11, color:"#334155", lineHeight:1.6 }}>
        🔒 Your profile data is stored securely in our database. Only HR and admins can view your emergency contact details.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER APPROVALS PANEL — Admin approves / rejects access requests
// ═══════════════════════════════════════════════════════════════════════════════
function UserApprovalsPanel() {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [actionMsg, setActionMsg] = useState("");

  // Load all profiles from Supabase using stored session
  useEffect(() => {
    if (!supaAuth) { setError("Auth not configured"); setLoading(false); return; }
    const sess = supaAuth.loadSession();
    if (!sess?.access_token) { setError("Not authenticated"); setLoading(false); return; }
    supaAuth.getAllProfiles(sess.access_token)
      .then(data => {
        if (Array.isArray(data)) setProfiles(data);
        else setError("Could not load profiles: " + JSON.stringify(data).substring(0, 80));
        setLoading(false);
      })
      .catch(e => { setError("Error: " + e.message); setLoading(false); });
  }, []);

  async function handleAction(userId, action) {
    const sess = supaAuth.loadSession();
    if (!sess?.access_token) return;
    const updates = action === "approve"
      ? { status: "approved", approved_at: new Date().toISOString(), approved_by: "manju@ziksatech.com" }
      : { status: "rejected" };
    await supaAuth.updateProfile(userId, updates, sess.access_token);
    setProfiles(prev => prev.map(p => p.id === userId ? { ...p, ...updates } : p));
    setActionMsg(action === "approve" ? "✅ User approved — they can now sign in." : "❌ User rejected.");
    setTimeout(() => setActionMsg(""), 4000);
  }

  const statusColor = { pending: "#f59e0b", approved: "#34d399", rejected: "#f87171" };
  const statusBg    = { pending: "#2d1f00", approved: "#002d1a", rejected: "#2d0a0a" };

  const pending  = profiles.filter(p => p.status === "pending");
  const approved = profiles.filter(p => p.status === "approved");
  const rejected = profiles.filter(p => p.status === "rejected");

  function ProfileRow({ p, showActions }) {
    return (
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 90px 120px",gap:8,alignItems:"center",
        padding:"12px 16px",background:"#0a1120",border:"1px solid #1a2d45",borderRadius:8,marginBottom:6}}>
        <div>
          <div style={{fontWeight:600,color:"#e2e8f0",fontSize:13}}>{p.full_name}</div>
          <div style={{color:"#475569",fontSize:11,marginTop:2}}>{p.email}</div>
        </div>
        <div style={{color:"#64748b",fontSize:12,textTransform:"capitalize"}}>{p.role}</div>
        <div>
          <span style={{background:statusBg[p.status],color:statusColor[p.status],borderRadius:20,padding:"2px 10px",fontSize:11,fontWeight:600}}>
            {p.status}
          </span>
        </div>
        <div style={{color:"#475569",fontSize:11}}>{p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}</div>
        <div style={{display:"flex",gap:6}}>
          {showActions && p.status !== "approved" && (
            <button onClick={()=>handleAction(p.id,"approve")}
              style={{background:"#064e3b",border:"1px solid #065f46",borderRadius:6,color:"#34d399",fontSize:11,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>
              Approve
            </button>
          )}
          {showActions && p.status !== "rejected" && (
            <button onClick={()=>handleAction(p.id,"reject")}
              style={{background:"#450a0a",border:"1px solid #7f1d1d",borderRadius:6,color:"#f87171",fontSize:11,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>
              Reject
            </button>
          )}
        </div>
      </div>
    );
  }

  if (loading) return <div style={{padding:40,textAlign:"center",color:"#64748b"}}>Loading user profiles…</div>;
  if (error)   return <div style={{padding:24,background:"#2d0a0a",border:"1px solid #7f1d1d",borderRadius:8,color:"#fca5a5",margin:16}}>{error}</div>;

  return (
    <div>
      {actionMsg && (
        <div style={{background:"#042f1c",border:"1px solid #065f46",borderRadius:8,padding:"12px 16px",color:"#34d399",marginBottom:20,fontWeight:600}}>
          {actionMsg}
        </div>
      )}

      {/* Pending requests */}
      <div style={{marginBottom:28}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <h3 style={{margin:0,color:"#f59e0b",fontSize:14,fontWeight:700}}>⏳ Pending Approval</h3>
          <span style={{background:"#2d1f00",color:"#f59e0b",borderRadius:20,padding:"1px 10px",fontSize:11,fontWeight:600}}>
            {pending.length}
          </span>
        </div>
        {pending.length === 0
          ? <div style={{color:"#334155",fontSize:13,padding:"12px 16px",background:"#0a1120",borderRadius:8}}>No pending requests</div>
          : pending.map(p => <ProfileRow key={p.id} p={p} showActions={true}/>)
        }
      </div>

      {/* Header row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 90px 120px",gap:8,padding:"6px 16px",marginBottom:6}}>
        {["Name / Email","Role","Status","Joined","Actions"].map(h=>(
          <div key={h} style={{fontSize:10,color:"#334155",fontWeight:700,textTransform:"uppercase",letterSpacing:.6}}>{h}</div>
        ))}
      </div>

      {/* Approved */}
      {approved.length > 0 && (
        <div style={{marginBottom:28}}>
          <h3 style={{color:"#34d399",fontSize:13,fontWeight:700,margin:"0 0 10px"}}>✅ Approved ({approved.length})</h3>
          {approved.map(p => <ProfileRow key={p.id} p={p} showActions={true}/>)}
        </div>
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <div>
          <h3 style={{color:"#f87171",fontSize:13,fontWeight:700,margin:"0 0 10px"}}>❌ Rejected ({rejected.length})</h3>
          {rejected.map(p => <ProfileRow key={p.id} p={p} showActions={true}/>)}
        </div>
      )}

      {profiles.length === 0 && (
        <div style={{textAlign:"center",padding:48,color:"#334155"}}>
          <div style={{fontSize:32,marginBottom:12}}>👤</div>
          <div style={{fontWeight:600,color:"#475569",marginBottom:6}}>No users yet</div>
          <div style={{fontSize:13}}>Share the app URL and users will appear here once they request access</div>
        </div>
      )}
    </div>
  );
}


function OrgChart({ orgMembers, setOrgMembers }) {
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);

  // Build tree levels
  const root   = orgMembers.find(m=>!m.reportsTo);
  const lvl1   = orgMembers.filter(m=>m.reportsTo===root?.id);
  const lvl2map = {};
  lvl1.forEach(m=>{ lvl2map[m.id] = orgMembers.filter(x=>x.reportsTo===m.id); });

  const selMember = orgMembers.find(m=>m.id===selected);
  const perms = selMember ? getEffectivePerms(selMember) : {};
  const fullModules  = selMember ? ALL_MODULES.filter(m=>perms[m.id]==="full") : [];
  const viewModules  = selMember ? ALL_MODULES.filter(m=>perms[m.id]==="view") : [];

  const NodeCard = ({ member, isRoot=false }) => {
    const rt = ROLE_TEMPLATES[member.role];
    const isHov  = hovered  === member.id;
    const isSel  = selected === member.id;
    return (
      <div onClick={()=>setSelected(isSel?null:member.id)}
        onMouseEnter={()=>setHovered(member.id)} onMouseLeave={()=>setHovered(null)}
        style={{
          padding:isRoot?"18px 24px":"12px 18px",
          borderRadius:12,cursor:"pointer",userSelect:"none",
          background: isSel ? (rt?.bg||"#0a1626") : isHov ? "#0f1e30" : "#070c18",
          border:`${isSel?"2px":"1px"} solid ${isSel?(rt?.color||"#38bdf8"):"#1a2d45"}`,
          transition:"all 0.15s",minWidth:isRoot?180:160,textAlign:"center",
          boxShadow: isSel?`0 0 0 3px ${rt?.color||"#38bdf8"}22`:"none",
        }}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:8}}>
          <Avatar name={member.name} role={member.role} size={isRoot?44:36}/>
        </div>
        <div style={{fontSize:isRoot?14:12,fontWeight:700,color:"#e2e8f0",marginBottom:2}}>{member.name}</div>
        <div style={{fontSize:isRoot?11:10,color:"#475569",marginBottom:6,lineHeight:1.3}}>{member.title}</div>
        <span style={{fontSize:9,fontWeight:700,padding:"3px 10px",borderRadius:20,
          background:rt?.bg||"#0a1626",color:rt?.color||"#64748b",
          border:`1px solid ${rt?.color||"#1a2d45"}44`}}>
          {rt?.label||member.role}
        </span>
      </div>
    );
  };

  // Vertical connector
  const VLine = ({h=24}) => <div style={{width:2,height:h,background:"#1a2d45",margin:"0 auto"}}/>;
  const HLine = ({w}) => <div style={{height:2,width:w,background:"#1a2d45"}}/>;

  return (
    <div style={{display:"grid",gridTemplateColumns:selMember?"1fr 280px":"1fr",gap:20}}>
      <div style={{overflowX:"auto",paddingBottom:16}}>
        {/* Root */}
        <div style={{display:"flex",justifyContent:"center",marginBottom:0}}>
          <NodeCard member={root} isRoot/>
        </div>
        <VLine h={28}/>

        {/* L1 horizontal rail */}
        <div style={{position:"relative",display:"flex",justifyContent:"center"}}>
          {/* Rail line across tops of L1 nodes */}
          <div style={{position:"absolute",top:0,left:"calc(50% - "+(lvl1.length>2?"280px":"140px")+")",
            width:lvl1.length>2?"560px":"280px",height:2,background:"#1a2d45"}}/>
        </div>

        <div style={{display:"flex",gap:20,justifyContent:"center",alignItems:"flex-start",paddingTop:0}}>
          {lvl1.map(m1=>{
            const children = lvl2map[m1.id]||[];
            return (
              <div key={m1.id} style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                <VLine h={24}/>
                <NodeCard member={m1}/>
                {children.length>0&&<>
                  <VLine h={20}/>
                  {/* Horizontal connector for children */}
                  {children.length>1&&(
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"center",position:"relative",width:"100%"}}>
                      <div style={{position:"absolute",top:0,left:"50px",right:"50px",height:2,background:"#1a2d45"}}/>
                    </div>
                  )}
                  <div style={{display:"flex",gap:10,alignItems:"flex-start",justifyContent:"center"}}>
                    {children.map((m2,ci)=>(
                      <div key={m2.id} style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                        <VLine h={20}/>
                        <NodeCard member={m2}/>
                      </div>
                    ))}
                  </div>
                </>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Side panel */}
      {selMember && (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="card" style={{padding:"18px 20px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div style={{display:"flex",gap:12,alignItems:"center"}}>
                <Avatar name={selMember.name} role={selMember.role} size={44}/>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{selMember.name}</div>
                  <div style={{fontSize:11,color:"#3d5a7a"}}>{selMember.title}</div>
                </div>
              </div>
              <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[["Email",selMember.email||"—"],["Reports to",selMember.reportsTo?(orgMembers.find(m=>m.id===selMember.reportsTo)?.name||"—"):"Top"],["Status",selMember.active?"Active":"Inactive"]].map(([l,v])=>(
                <div key={l}><div className="lbl">{l}</div><div style={{fontSize:11,color:"#94a3b8"}}>{v}</div></div>
              ))}
            </div>
            <div style={{padding:"10px 14px",borderRadius:8,background:ROLE_TEMPLATES[selMember.role]?.bg,border:`1px solid ${ROLE_TEMPLATES[selMember.role]?.color}44`,textAlign:"center"}}>
              <div style={{fontSize:12,fontWeight:700,color:ROLE_TEMPLATES[selMember.role]?.color}}>{ROLE_TEMPLATES[selMember.role]?.label}</div>
              <div style={{fontSize:10,color:"#475569",marginTop:2}}>Role template</div>
            </div>
          </div>

          {/* Access summary */}
          <div className="card">
            <div className="section-hdr" style={{fontSize:12}}>Module Access</div>
            {fullModules.length>0&&(
              <div style={{padding:"10px 16px",borderBottom:"1px solid #0a1626"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#34d399",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Full Access</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {fullModules.map(m=><span key={m.id} className="bdg" style={{background:"#021f14",color:"#34d399",fontSize:9}}>{m.label}</span>)}
                </div>
              </div>
            )}
            {viewModules.length>0&&(
              <div style={{padding:"10px 16px",borderBottom:"1px solid #0a1626"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#7dd3fc",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>View Only</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {viewModules.map(m=><span key={m.id} className="bdg" style={{background:"#0c2340",color:"#7dd3fc",fontSize:9}}>{m.label}</span>)}
                </div>
              </div>
            )}
            <div style={{padding:"8px 16px"}}>
              <div style={{fontSize:9,color:"#1e3a5f"}}>Hidden: {ALL_MODULES.filter(m=>perms[m.id]==="none"||!perms[m.id]).length} modules</div>
            </div>
          </div>

          <div style={{display:"flex",gap:8}}>
            <button className="btn bp" style={{flex:1,justifyContent:"center",fontSize:11}}
              onClick={()=>{ document.querySelector('[data-tab-members]')?.click(); }}>
              Edit in Team Members →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Team Members ──────────────────────────────────────────────────────────────
function OrgMembers({ orgMembers, setOrgMembers, roster }) {
  const [modal, setModal]   = useState(false);
  const [form, setForm]     = useState(null);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);

  const empty = { rosterId:"", name:"", title:"", email:"", phone:"", reportsTo:"", role:"consultant", active:true, customPerms:{} };
  const open  = (m=null) => { setEditing(m?.id||null); setForm(m?{...m}:{...empty}); setModal(true); };
  const save  = () => {
    if(editing) setOrgMembers(ms=>ms.map(m=>m.id===editing?{...form}:m));
    else setOrgMembers(ms=>[...ms,{...form,id:"org"+uid()}]);
    setModal(false);
  };
  const toggle = id => setOrgMembers(ms=>ms.map(m=>m.id===id?{...m,active:!m.active}:m));
  const changeRole = (id, role) => setOrgMembers(ms=>ms.map(m=>m.id===id?{...m,role,customPerms:{}}:m));

  const selMember = orgMembers.find(m=>m.id===selected);
  const perms = selMember ? getEffectivePerms(selMember) : {};

  return (
    <div style={{display:"grid",gridTemplateColumns:selMember?"3fr 2fr":"1fr",gap:16}}>
      <div>
        {/* Summary */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16}}>
          {Object.entries(ROLE_TEMPLATES).map(([k,rt])=>{
            const count = orgMembers.filter(m=>m.role===k).length;
            return count>0?(
              <div key={k} className="card" style={{padding:"10px 14px",borderLeft:`3px solid ${rt.color}`}}>
                <div style={{fontSize:10,color:rt.color,fontWeight:700,marginBottom:3,textTransform:"uppercase",letterSpacing:"0.07em"}}>{rt.label}</div>
                <div style={{fontSize:22,fontWeight:800,color:"#e2e8f0"}}>{count}</div>
              </div>
            ):null;
          }).filter(Boolean)}
        </div>

        <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
          <button className="btn bp" style={{fontSize:12}} onClick={()=>open()}><I d={ICONS.plus} s={13}/>Add Member</button>
        </div>

        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"2.5fr 1fr 1.5fr 80px 80px 70px",padding:"8px 18px"}}>
            {["Team Member","Type","Role","Status","Access","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {orgMembers.map(m=>{
            const rt = ROLE_TEMPLATES[m.role];
            const manager = orgMembers.find(x=>x.id===m.reportsTo);
            const hasCustom = Object.keys(m.customPerms||{}).length > 0;
            return (
              <div key={m.id} className="tr"
                style={{gridTemplateColumns:"2.5fr 1fr 1.5fr 80px 80px 70px",cursor:"pointer",
                  opacity:m.active?1:0.45,background:selected===m.id?"#0a1a2e":undefined}}
                onClick={()=>setSelected(selected===m.id?null:m.id)}>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <Avatar name={m.name} role={m.role} size={32}/>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{m.name}</div>
                    <div style={{fontSize:10,color:"#3d5a7a"}}>{m.title}</div>
                    {manager&&<div style={{fontSize:9,color:"#1e3a5f"}}>↳ {manager.name}</div>}
                  </div>
                </div>
                <span className="bdg" style={{background:"#0a1626",color:m.rosterId?"#7dd3fc":"#475569",fontSize:9}}>{m.rosterId?"FTE/Contractor":"Admin only"}</span>
                <div style={{display:"flex",flexDirection:"column",gap:3}} onClick={e=>e.stopPropagation()}>
                  <select className="inp" style={{fontSize:10,padding:"3px 6px",background:rt?.bg,borderColor:rt?.color+"44"}}
                    value={m.role} onChange={e=>changeRole(m.id,e.target.value)}>
                    {Object.entries(ROLE_TEMPLATES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                  </select>
                  {hasCustom&&<span style={{fontSize:8,color:"#f59e0b"}}>⚡ Custom permissions</span>}
                </div>
                <button className="btn bg" style={{fontSize:10,padding:"4px 8px",borderColor:m.active?"#34d39944":"#f8717144",color:m.active?"#34d399":"#f87171"}}
                  onClick={e=>{e.stopPropagation();toggle(m.id);}}>
                  {m.active?"Active":"Inactive"}
                </button>
                <div>
                  {["full","view","none"].map(lvl=>{
                    const mPerms = getEffectivePerms(m);
                    const cnt = ALL_MODULES.filter(x=>mPerms[x.id]===lvl).length;
                    return cnt>0?<div key={lvl} style={{fontSize:9,color:PERM_COLOR[lvl]}}>{cnt} {PERM_LABEL[lvl]}</div>:null;
                  })}
                </div>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  <button className="btn bg" style={{padding:"3px 7px",fontSize:10}} onClick={()=>open(m)}><I d={ICONS.edit} s={11}/></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Permission editor panel */}
      {selMember && (
        <div className="card" style={{height:"fit-content",position:"sticky",top:0}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #111d2d",display:"flex",gap:12,alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <Avatar name={selMember.name} role={selMember.role} size={36}/>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>{selMember.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{ROLE_TEMPLATES[selMember.role]?.label}</div>
              </div>
            </div>
            <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setSelected(null)}>✕</button>
          </div>
          <div style={{padding:"12px 18px",borderBottom:"1px solid #111d2d"}}>
            <div style={{fontSize:11,fontWeight:600,color:"#64748b",marginBottom:8}}>CUSTOMIZE PERMISSIONS</div>
            <div style={{fontSize:10,color:"#1e3a5f",marginBottom:12}}>Override role defaults per module. Blank = use role template.</div>
            {Object.entries(
              ALL_MODULES.reduce((acc,m)=>{ (acc[m.group]=acc[m.group]||[]).push(m); return acc; },{})
            ).map(([group,mods])=>(
              <div key={group} style={{marginBottom:14}}>
                <div style={{fontSize:9,fontWeight:700,color:"#2d4a63",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>{group}</div>
                {mods.map(mod=>{
                  const baseVal = ROLE_TEMPLATES[selMember.role]?.perms?.[mod.id]||"none";
                  const customVal = selMember.customPerms?.[mod.id];
                  const effectiveVal = customVal||baseVal;
                  return (
                    <div key={mod.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #070b14"}}>
                      <div>
                        <div style={{fontSize:11,color:customVal?"#f59e0b":"#94a3b8"}}>{mod.label}{customVal?" ⚡":""}</div>
                        {customVal&&<div style={{fontSize:9,color:"#475569"}}>Base: {PERM_LABEL[baseVal]}</div>}
                      </div>
                      <select className="inp" style={{width:72,fontSize:10,padding:"3px 5px",
                        background:PERM_BG[effectiveVal],borderColor:PERM_COLOR[effectiveVal]+"66",color:PERM_COLOR[effectiveVal]}}
                        value={customVal||baseVal}
                        onChange={e=>{
                          const val = e.target.value;
                          setOrgMembers(ms=>ms.map(m=>{
                            if(m.id!==selMember.id) return m;
                            const cp = {...(m.customPerms||{})};
                            // If same as base, remove custom; otherwise store it
                            if(val===baseVal) delete cp[mod.id]; else cp[mod.id]=val;
                            return {...m,customPerms:cp};
                          }));
                        }}>
                        {PERM_LEVELS.map(lv=><option key={lv} value={lv}>{PERM_LABEL[lv]}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            ))}
            <button className="btn br" style={{width:"100%",justifyContent:"center",fontSize:11,marginTop:8}}
              onClick={()=>setOrgMembers(ms=>ms.map(m=>m.id===selMember.id?{...m,customPerms:{}}:m))}>
              Reset to role defaults
            </button>
          </div>
        </div>
      )}

      {modal&&form&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div className="modal" style={{maxWidth:500}}>
            <MH title={editing?"Edit Member":"Add Team Member"} onClose={()=>setModal(false)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <FF label="Full Name"><input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Suresh Menon"/></FF>
              <FF label="Title"><input className="inp" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="SAP Consultant"/></FF>
              <FF label="Email"><input className="inp" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="suresh@ziksatech.com"/></FF>
              <FF label="Phone"><input className="inp" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} placeholder="+1 (214) 555-0100"/></FF>
              <FF label="Role Template"><select className="inp" value={form.role} onChange={e=>setForm({...form,role:e.target.value,customPerms:{}})}>
                {Object.entries(ROLE_TEMPLATES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select></FF>
              <FF label="Reports To"><select className="inp" value={form.reportsTo} onChange={e=>setForm({...form,reportsTo:e.target.value})}>
                <option value="">— Top of org —</option>
                {orgMembers.filter(m=>m.id!==editing).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
              </select></FF>
              <FF label="Linked Roster Member"><select className="inp" value={form.rosterId} onChange={e=>setForm({...form,rosterId:e.target.value})}>
                <option value="">None (admin/external)</option>
                {roster.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></FF>
              <FF label="Status"><select className="inp" value={form.active?"active":"inactive"} onChange={e=>setForm({...form,active:e.target.value==="active"})}>
                <option value="active">Active</option><option value="inactive">Inactive</option>
              </select></FF>
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setModal(false)}>Cancel</button>
              <button className="btn bp" onClick={save}><I d={ICONS.check} s={13}/>Save Member</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Access Matrix ─────────────────────────────────────────────────────────────
function AccessMatrix({ orgMembers, setOrgMembers }) {
  const [hovCell, setHovCell] = useState(null);
  const [editingCell, setEditingCell] = useState(null);
  const activeMembers = orgMembers.filter(m=>m.active);

  const cyclePermission = (memberId, moduleId) => {
    setOrgMembers(ms=>ms.map(m=>{
      if(m.id!==memberId) return m;
      const base    = ROLE_TEMPLATES[m.role]?.perms?.[moduleId]||"none";
      const current = m.customPerms?.[moduleId]||base;
      const idx     = PERM_LEVELS.indexOf(current);
      const next    = PERM_LEVELS[(idx+1)%PERM_LEVELS.length];
      const cp      = {...(m.customPerms||{})};
      if(next===base) delete cp[moduleId]; else cp[moduleId]=next;
      return {...m,customPerms:cp};
    }));
  };

  const groups = [...new Set(ALL_MODULES.map(m=>m.group))];

  return (
    <div>
      <div style={{marginBottom:14,display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{fontSize:12,color:"#475569"}}>Click any cell to cycle: <b style={{color:"#34d399"}}>Full</b> → <b style={{color:"#7dd3fc"}}>View</b> → <b style={{color:"#1e3a5f"}}>—</b></div>
        <div style={{display:"flex",gap:8}}>
          {[["full","#34d399","Full Access"],["view","#7dd3fc","View Only"],["none","#1e3a5f","No Access"]].map(([lv,c,lab])=>(
            <span key={lv} style={{fontSize:11,color:c,display:"flex",alignItems:"center",gap:5}}>
              <span style={{width:12,height:12,borderRadius:3,background:c+"22",border:`1px solid ${c}`,display:"inline-block"}}/>
              {lab}
            </span>
          ))}
          <span style={{fontSize:10,color:"#f59e0b"}}>⚡ = custom override</span>
        </div>
      </div>

      <div style={{overflowX:"auto"}}>
        <table style={{borderCollapse:"separate",borderSpacing:"2px 2px",minWidth:"100%"}}>
          <thead>
            <tr>
              <th style={{width:160,textAlign:"left",padding:"8px 12px",fontSize:11,color:"#2d4a63",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em",position:"sticky",left:0,background:"#070b14",zIndex:2}}>Module</th>
              {activeMembers.map(m=>(
                <th key={m.id} style={{textAlign:"center",padding:"6px 4px",minWidth:72,maxWidth:90}}>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                    <Avatar name={m.name} role={m.role} size={26}/>
                    <div style={{fontSize:9,color:"#475569",lineHeight:1.2,maxWidth:80,textOverflow:"ellipsis",overflow:"hidden",whiteSpace:"nowrap"}}>{m.name.split(" ")[0]}</div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(group=>(
              <React.Fragment key={group}>
                <tr>
                  <td colSpan={activeMembers.length+1} style={{padding:"10px 12px 4px",position:"sticky",left:0,background:"#070b14",zIndex:1}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#2d4a63",textTransform:"uppercase",letterSpacing:"0.1em"}}>{group}</div>
                  </td>
                </tr>
                {ALL_MODULES.filter(mod=>mod.group===group).map(mod=>(
                  <tr key={mod.id}>
                    <td style={{padding:"5px 12px",fontSize:12,color:"#94a3b8",position:"sticky",left:0,background:"#0a0f1a",zIndex:1,borderRight:"1px solid #111d2d"}}>
                      {mod.label}
                    </td>
                    {activeMembers.map(m=>{
                      const base    = ROLE_TEMPLATES[m.role]?.perms?.[mod.id]||"none";
                      const custom  = m.customPerms?.[mod.id];
                      const val     = custom||base;
                      const isHov   = hovCell===`${m.id}-${mod.id}`;
                      return (
                        <td key={m.id}
                          style={{textAlign:"center",padding:"3px",cursor:"pointer"}}
                          onMouseEnter={()=>setHovCell(`${m.id}-${mod.id}`)}
                          onMouseLeave={()=>setHovCell(null)}
                          onClick={()=>cyclePermission(m.id,mod.id)}
                          title={`${m.name} · ${mod.label}: ${val}${custom?" (custom)":""}`}>
                          <div style={{
                            width:50,height:28,borderRadius:6,margin:"0 auto",
                            display:"flex",alignItems:"center",justifyContent:"center",
                            background: isHov?PERM_COLOR[val]+"22":PERM_BG[val],
                            border:`1px solid ${PERM_COLOR[val]}${val==="none"?"22":"66"}`,
                            transition:"all 0.1s",fontSize:10,fontWeight:700,color:PERM_COLOR[val],
                            position:"relative",
                          }}>
                            {PERM_LABEL[val]}
                            {custom&&<span style={{position:"absolute",top:1,right:2,fontSize:7,color:"#f59e0b"}}>⚡</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Module summary */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginTop:18}}>
        {activeMembers.map(m=>{
          const perms = getEffectivePerms(m);
          const full  = ALL_MODULES.filter(x=>perms[x.id]==="full").length;
          const view  = ALL_MODULES.filter(x=>perms[x.id]==="view").length;
          const none  = ALL_MODULES.filter(x=>perms[x.id]==="none"||!perms[x.id]).length;
          const hasC  = Object.keys(m.customPerms||{}).length;
          const rt    = ROLE_TEMPLATES[m.role];
          return (
            <div key={m.id} className="card" style={{padding:"12px 14px",borderLeft:`3px solid ${rt?.color||"#1a2d45"}`}}>
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                <Avatar name={m.name} role={m.role} size={28}/>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{m.name}</div>
                  <div style={{fontSize:9,color:"#3d5a7a"}}>{rt?.label}</div>
                </div>
              </div>
              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1,textAlign:"center"}}>
                  <div style={{fontSize:16,fontWeight:800,color:"#34d399"}}>{full}</div>
                  <div style={{fontSize:9,color:"#475569"}}>Full</div>
                </div>
                <div style={{flex:1,textAlign:"center"}}>
                  <div style={{fontSize:16,fontWeight:800,color:"#7dd3fc"}}>{view}</div>
                  <div style={{fontSize:9,color:"#475569"}}>View</div>
                </div>
                <div style={{flex:1,textAlign:"center"}}>
                  <div style={{fontSize:16,fontWeight:800,color:"#1e3a5f"}}>{none}</div>
                  <div style={{fontSize:9,color:"#475569"}}>None</div>
                </div>
              </div>
              {hasC>0&&<div style={{fontSize:9,color:"#f59e0b",marginTop:6}}>⚡ {hasC} custom override{hasC>1?"s":""}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Role Templates Reference ──────────────────────────────────────────────────
function RoleTemplates() {
  const [expanded, setExpanded] = useState(null);

  return (
    <div>
      <div style={{fontSize:12,color:"#3d5a7a",marginBottom:18}}>
        Role templates define default access. You can override individual modules per person in Team Members → permission panel.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:14}}>
        {Object.entries(ROLE_TEMPLATES).map(([key, rt])=>{
          const isExp = expanded===key;
          const fullMods = ALL_MODULES.filter(m=>rt.perms[m.id]==="full");
          const viewMods = ALL_MODULES.filter(m=>rt.perms[m.id]==="view");
          const noneMods = ALL_MODULES.filter(m=>rt.perms[m.id]==="none");
          return (
            <div key={key} className="card" style={{padding:"18px 20px",borderLeft:`4px solid ${rt.color}`,cursor:"pointer"}}
              onClick={()=>setExpanded(isExp?null:key)}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:rt.color}}>{rt.label}</div>
                  <div style={{fontSize:10,color:"#3d5a7a",marginTop:2}}>key: {key}</div>
                </div>
                <div style={{display:"flex",gap:12}}>
                  <div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:800,color:"#34d399"}}>{fullMods.length}</div><div style={{fontSize:8,color:"#475569"}}>Full</div></div>
                  <div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:800,color:"#7dd3fc"}}>{viewMods.length}</div><div style={{fontSize:8,color:"#475569"}}>View</div></div>
                  <div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:800,color:"#1e3a5f"}}>{noneMods.length}</div><div style={{fontSize:8,color:"#475569"}}>None</div></div>
                </div>
              </div>

              {/* Bar visualization */}
              <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",marginBottom:isExp?14:0}}>
                <div style={{flex:fullMods.length,background:"#34d399"}}/>
                <div style={{flex:viewMods.length,background:"#7dd3fc"}}/>
                <div style={{flex:noneMods.length,background:"#0a1626"}}/>
              </div>

              {isExp && (
                <div>
                  <div style={{marginTop:8,marginBottom:6}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#34d399",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>Full Access ({fullMods.length})</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {fullMods.map(m=><span key={m.id} className="bdg" style={{background:"#021f14",color:"#34d399",fontSize:9}}>{m.label}</span>)}
                    </div>
                  </div>
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#7dd3fc",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>View Only ({viewMods.length})</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {viewMods.map(m=><span key={m.id} className="bdg" style={{background:"#0c2340",color:"#7dd3fc",fontSize:9}}>{m.label}</span>)}
                      {viewMods.length===0&&<span style={{fontSize:10,color:"#1e3a5f"}}>None</span>}
                    </div>
                  </div>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>Hidden ({noneMods.length})</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {noneMods.map(m=><span key={m.id} className="bdg" style={{background:"#0a1626",color:"#1e3a5f",fontSize:9}}>{m.label}</span>)}
                    </div>
                  </div>
                </div>
              )}

              <div style={{marginTop:isExp?10:8,fontSize:10,color:"#3d5a7a",textAlign:"right"}}>{isExp?"▲ collapse":"▼ expand"}</div>
            </div>
          );
        })}
      </div>

      {/* Recommended assignments */}
      <div className="card" style={{padding:"18px 22px",marginTop:18}}>
        <div className="section-hdr">Recommended Assignments for Ziksatech</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:0}}>
          {[
            ["Manju",             "Owner",         "Full access to all 15 modules"],
            ["Suresh Menon",      "Delivery Lead",  "Projects, Roster, Compliance, Clients"],
            ["Deepa, Vikram…",    "Consultant",     "Timesheet view, Project view, Dashboard"],
            ["Rajesh, Priya…",    "Contractor",     "Timesheet view, Project view only"],
            ["Future: Finance Mgr","Finance Mgr",   "P&L, Finance, ADP, FreshBooks full"],
            ["Future: Recruiter", "Recruiter / HR", "Recruiting, Pipeline full"],
          ].map(([who,role,access])=>(
            <div key={who} style={{padding:"10px 14px",borderBottom:"1px solid #0a1626",borderRight:"1px solid #0a1626"}}>
              <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1",marginBottom:2}}>{who}</div>
              <div style={{fontSize:10,color:ROLE_TEMPLATES[Object.keys(ROLE_TEMPLATES).find(k=>ROLE_TEMPLATES[k].label===role)]?.color||"#7dd3fc",marginBottom:2}}>{role}</div>
              <div style={{fontSize:10,color:"#475569"}}>{access}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMESHEET APPROVAL WORKFLOW
// ═══════════════════════════════════════════════════════════════════════════════
const TS_STATUS_COLOR = {
  draft:       "#475569",
  submitted:   "#f59e0b",
  pm_approved: "#38bdf8",
  approved:    "#a78bfa",
  locked:      "#34d399",
  rejected:    "#f87171",
};
const TS_STATUS_BG = {
  draft:       "#0a1626",
  submitted:   "#1a1005",
  pm_approved: "#0c2340",
  approved:    "#1a1a2e",
  locked:      "#021f14",
  rejected:    "#1a0808",
};
const TS_STATUS_LABEL = {
  draft:       "Draft",
  submitted:   "Submitted",
  pm_approved: "PM Approved",
  approved:    "Owner Approved",
  locked:      "Locked ✓",
  rejected:    "Rejected",
};
const TS_FLOW = ["draft","submitted","pm_approved","approved","locked"];

function TimesheetApproval({ roster, setRoster, tsHours, setTsHours, tsSubmissions, setTsSubmissions, finInvoices, setFinInvoices, orgMembers, projects, clients, addAudit }) {
  const [sub, setSub] = useState("overview");
  const tabs = [
    { id:"overview",    label:"Overview"         },
    { id:"selfservice", label:"Log My Hours"      },
    { id:"grid",        label:"Hours Grid"        },
    { id:"approvals",   label:"Approval Queue"    },
    { id:"history",     label:"History & Locked"  },
  ];
  const props = { roster, setRoster, tsHours, setTsHours, tsSubmissions, setTsSubmissions, finInvoices, setFinInvoices, orgMembers, projects, clients, addAudit };

  // Badge count on Approval Queue tab
  const pendingCount = tsSubmissions.filter(s=>["submitted","pm_approved"].includes(s.status)).length;
  const rejectedCount = tsSubmissions.filter(s=>s.status==="rejected").length;

  return (
    <div>
      <PH title="Timesheet Approval" sub="Log My Hours (self-service) → PM Approve → Owner Approve → Lock → Invoice"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s",position:"relative"}}>
            {t.label}
            {t.id==="approvals" && pendingCount>0 && (
              <span style={{position:"absolute",top:4,right:6,background:"#f59e0b",color:"#000",borderRadius:"50%",width:16,height:16,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{pendingCount}</span>
            )}
            {t.id==="selfservice" && rejectedCount>0 && (
              <span style={{position:"absolute",top:4,right:6,background:"#f87171",color:"#fff",borderRadius:"50%",width:16,height:16,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{rejectedCount}</span>
            )}
          </button>
        ))}
      </div>
      {sub==="overview"    && <TSOverview   {...props}/>}
      {sub==="selfservice" && <TSConsultant {...props}/>}
      {sub==="grid"      && <TSGrid       {...props}/>}
      {sub==="approvals" && <TSApprovals  {...props}/>}
      {sub==="history"   && <TSHistory    {...props}/>}
    </div>
  );
}


// ── Consultant Self-Service Timesheet Entry ───────────────────────────────────
function TSConsultant({ roster, tsSubmissions, setTsSubmissions, tsHours, setTsHours, projects, clients, addAudit }) {
  const DAYS = ["Mon","Tue","Wed","Thu","Fri"];
  const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Build list of Mon-starting weeks covering ±8 weeks from today
  const buildWeeks = () => {
    const today = new Date();
    const day = today.getDay(); // 0=Sun, 1=Mon...
    const base = new Date(today);
    base.setDate(today.getDate() - (day === 0 ? 6 : day - 1)); // nearest Monday
    const weeks = [];
    for (let i = -4; i <= 8; i++) {
      const mon = new Date(base); mon.setDate(mon.getDate() + i*7);
      const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
      const label = `${MONTHS_SHORT[mon.getMonth()]} ${mon.getDate()} – ${mon.getDate()+4}, ${mon.getFullYear()}`;
      const key   = mon.toISOString().slice(0,10);
      weeks.push({ key, label, mon, fri });
    }
    return weeks;
  };
  const WEEKS = buildWeeks();

  // State
  const [consultantId, setConsultantId] = useState(roster[0]?.id||"");
  const [weekKey,      setWeekKey]      = useState(WEEKS[4].key); // default = current week
  const [dayHours,     setDayHours]     = useState({Mon:8,Tue:8,Wed:8,Thu:8,Fri:8});
  const [projectId,    setProjectId]    = useState("");
  const [notes,        setNotes]        = useState("");
  const [viewMode,     setViewMode]     = useState("entry"); // entry | history
  const [successMsg,   setSuccessMsg]   = useState("");
  const [error,        setError]        = useState("");
  const [resubId,      setResubId]      = useState(null);
  const [resubNote,    setResubNote]    = useState("");

  // ── Live clock-in timer ──────────────────────────────────────
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerDay,     setTimerDay]     = useState("Mon");
  const timerRef = useRef(null);

  const startTimer = (day) => {
    setTimerDay(day);
    setTimerRunning(true);
    timerRef.current = setInterval(() => setTimerSeconds(s => s + 1), 1000);
  };
  const stopTimer = () => {
    clearInterval(timerRef.current);
    setTimerRunning(false);
    // Add elapsed hours to selected day (rounded to nearest 0.25h)
    const hrs = Math.round((timerSeconds / 3600) * 4) / 4;
    if (hrs >= 0.25) {
      setDayHours(h => ({ ...h, [timerDay]: Math.min(24, (parseFloat(h[timerDay])||0) + hrs) }));
    }
    setTimerSeconds(0);
  };
  const fmtTimer = (s) => {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    return `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  };
  useEffect(() => () => clearInterval(timerRef.current), []);

  const consultant  = roster.find(r => r.id === consultantId);
  const billRate    = consultant?.billRate || 0;
  const totalHours  = Object.values(dayHours).reduce((s,h) => s + (parseFloat(h)||0), 0);
  const totalRevenue = totalHours * billRate;
  const selectedWeek = WEEKS.find(w => w.key === weekKey) || WEEKS[4];

  // Period string: "Mar W2 2026" style
  const weekLabel = selectedWeek.label;

  // Check if this consultant+week already has a submission
  const existingSub = tsSubmissions.find(s =>
    s.rosterId === consultantId && s.weekKey === weekKey
  );

  const isSubmitted = existingSub && existingSub.status !== "draft" && existingSub.status !== "rejected";
  const isRejected  = existingSub?.status === "rejected";

  // When consultant or week changes, pre-fill hours if draft exists
  useEffect(() => {
    if (existingSub?.dayHours) {
      setDayHours(existingSub.dayHours);
    } else {
      setDayHours({Mon:8,Tue:8,Wed:8,Thu:8,Fri:8});
    }
    setNotes(existingSub?.notes||"");
    setProjectId(existingSub?.projectId||"");
    setError("");
    setSuccessMsg("");
  }, [consultantId, weekKey]);

  const setDay = (day, val) => {
    const v = Math.max(0, Math.min(24, parseFloat(val)||0));
    setDayHours(h => ({...h, [day]: v}));
  };

  // Validate + submit
  const handleSubmit = () => {
    if (totalHours <= 0) { setError("Total hours must be greater than 0."); return; }
    if (totalHours > 60) { setError("Total hours exceed 60 for the week — please review."); return; }
    setError("");

    const period = weekLabel;
    const newSub = {
      id:          existingSub?.id || "tss" + uid(),
      rosterId:    consultantId,
      memberName:  consultant?.name || "",
      weekKey,
      period,
      dayHours:    {...dayHours},
      totalHours,
      billRate,
      totalRevenue,
      projectId,
      clientId:    projects.find(p=>p.id===projectId)?.clientId || consultant?.client || "",
      notes,
      status:      "submitted",
      submittedAt: TODAY_STR,
      pmApproverId:"", pmApprovedAt:"", ownerApprovedAt:"",
      lockedAt:"", pmNotes:"", rejectionNote:"", invoiceRef:"",
      monthIdx: selectedWeek.mon.getMonth(),
      year:     selectedWeek.mon.getFullYear(),
    };

    if (existingSub) {
      setTsSubmissions(ss => ss.map(s => s.id === existingSub.id ? newSub : s));
    } else {
      setTsSubmissions(ss => [...ss, newSub]);
      // Sync with tsHours grid (monthly bucket)
      const mi = newSub.monthIdx;
      setTsHours(h => ({
        ...h,
        [consultantId]: (h[consultantId]||Array(12).fill(0)).map((v,i) => i===mi ? (v + totalHours) : v)
      }));
    }

    addAudit && addAudit("Timesheets", "Consultant Submitted Timesheet", "Timesheet",
      `${consultant?.name} submitted ${totalHours}h for ${period}`, {totalRevenue});

    setSuccessMsg(`✓ Submitted ${totalHours}h for ${period}. Sent to PM for approval.`);
    setTimeout(() => setSuccessMsg(""), 5000);
  };

  // Resubmit after rejection
  const handleResubmit = (sub) => {
    setTsSubmissions(ss => ss.map(s => s.id === sub.id ? {
      ...s, status:"submitted", submittedAt: TODAY_STR,
      rejectionNote:"", pmNotes:"",
    } : s));
    addAudit && addAudit("Timesheets","Consultant Resubmitted","Timesheet",
      `${sub.memberName} resubmitted ${sub.period} after rejection`);
    setResubId(null);
    setResubNote("");
  };

  // My submissions filtered to this consultant
  const mySubs = tsSubmissions.filter(s => s.rosterId === consultantId)
    .sort((a,b) => (b.weekKey||b.period||"").localeCompare(a.weekKey||a.period||""));

  const statusColor = { submitted:"#f59e0b", pm_approved:"#38bdf8", approved:"#34d399", locked:"#a78bfa", rejected:"#f87171", draft:"#64748b" };
  const statusBg    = { submitted:"#1a1000", pm_approved:"#020d1c", approved:"#021f14", locked:"#0d0b1a", rejected:"#1a0808", draft:"#0a0f1c" };

  const clientProjects = projects.filter(p =>
    p.status==="active" && (p.client === consultant?.client || !p.client)
  );

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:18,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:4,background:"#060d1c",borderRadius:8,padding:3,border:"1px solid #1a2d45"}}>
          {[["entry","Log Hours"],["history","My Submissions"]].map(([v,l])=>(
            <button key={v} onClick={()=>setViewMode(v)}
              style={{padding:"5px 16px",borderRadius:6,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
                background:viewMode===v?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
                color:viewMode===v?"#fff":"#475569"}}>
              {l}{v==="history"&&mySubs.filter(s=>s.status==="rejected").length>0?
                <span style={{marginLeft:5,background:"#f87171",color:"#fff",borderRadius:"50%",padding:"1px 5px",fontSize:9}}>
                  {mySubs.filter(s=>s.status==="rejected").length}
                </span>:""}
            </button>
          ))}
        </div>
        {/* Consultant selector */}
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"#060d1c",borderRadius:8,border:"1px solid #1a2d45"}}>
          <span style={{fontSize:11,color:"#3d5a7a",fontWeight:700}}>CONSULTANT</span>
          <select className="inp" style={{fontSize:12,padding:"3px 10px",width:"auto"}}
            value={consultantId} onChange={e=>setConsultantId(e.target.value)}>
            {roster.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>

      {/* ── LOG HOURS VIEW ─────────────────────────────────────────────────── */}
      {viewMode==="entry"&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:16,alignItems:"start"}}>

          {/* Left: entry form */}
          <div className="card" style={{padding:"20px 22px"}}>

            {/* Consultant summary strip */}
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18,padding:"12px 14px",
              background:"#070c18",borderRadius:8,border:"1px solid #1a2d45"}}>
              <Avatar name={consultant?.name||"?"} size={40}/>
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{consultant?.name}</div>
                <div style={{fontSize:11,color:"#3d5a7a"}}>{consultant?.role} · {consultant?.client} · ${billRate}/hr</div>
              </div>
              {existingSub&&(
                <span style={{fontSize:10,padding:"3px 8px",borderRadius:20,
                  background:statusBg[existingSub.status],color:statusColor[existingSub.status],
                  border:`1px solid ${statusColor[existingSub.status]}44`}}>
                  {existingSub.status}
                </span>
              )}
            </div>

            {/* Week selector */}
            <div style={{marginBottom:18}}>
              <div className="lbl" style={{marginBottom:6}}>Work Week</div>
              <select className="inp" value={weekKey} onChange={e=>setWeekKey(e.target.value)}>
                {WEEKS.map(w=>{
                  const hasSub = tsSubmissions.find(s=>s.rosterId===consultantId&&s.weekKey===w.key);
                  const suffix = hasSub ? ` — ${hasSub.status}` : "";
                  return <option key={w.key} value={w.key}>{w.label}{suffix}</option>;
                })}
              </select>
            </div>

            {/* Already submitted / locked notice */}
            {isSubmitted&&!isRejected&&(
              <div style={{padding:"12px 14px",background:"#021f14",borderRadius:8,border:"1px solid #063d28",
                marginBottom:14,fontSize:12,color:"#34d399"}}>
                ✓ This week is <strong>{existingSub.status}</strong> — {existingSub.totalHours}h submitted on {existingSub.submittedAt}.
                {existingSub.status==="pm_approved"&&" Waiting for owner final approval."}
                {existingSub.status==="approved"&&" Approved — will be locked and invoiced at month end."}
                {existingSub.status==="locked"&&` Locked. Invoice ref: ${existingSub.invoiceRef||"—"}`}
              </div>
            )}

            {/* Rejection notice */}
            {isRejected&&(
              <div style={{padding:"12px 14px",background:"#1a0808",borderRadius:8,border:"1px solid #3d1010",
                marginBottom:14}}>
                <div style={{fontSize:12,color:"#f87171",fontWeight:700,marginBottom:4}}>Timesheet Rejected</div>
                <div style={{fontSize:11,color:"#f87171",marginBottom:8}}>{existingSub.rejectionNote||"Please review and resubmit."}</div>
                <div style={{fontSize:11,color:"#3d5a7a"}}>Update your hours below and resubmit.</div>
              </div>
            )}

            {/* Day-by-day hours */}
            <div className="lbl" style={{marginBottom:10}}>Daily Hours — {selectedWeek.label}</div>
            {/* Live timer banner */}
            {timerRunning && (
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",marginBottom:12,
                background:"#021f14",border:"1px solid #34d39944",borderRadius:8}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:"#34d399",
                  animation:"pulse 1s infinite",flexShrink:0}}/>
                <span style={{fontSize:13,color:"#34d399",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                  {fmtTimer(timerSeconds)}
                </span>
                <span style={{fontSize:11,color:"#64748b"}}>clocked in — {timerDay}</span>
                <button className="btn br" style={{marginLeft:"auto",fontSize:11,padding:"4px 12px"}} onClick={stopTimer}>
                  ⏹ Stop &amp; Add Hours
                </button>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:18}}>
              {DAYS.map(day=>(
                <div key={day} style={{textAlign:"center"}}>
                  <div style={{fontSize:11,color:"#3d5a7a",fontWeight:700,marginBottom:6,
                    letterSpacing:"0.04em"}}>{day}</div>
                  <input
                    type="number" min="0" max="24" step="0.5"
                    className="inp"
                    style={{textAlign:"center",fontSize:18,fontWeight:700,fontFamily:"'DM Mono',monospace",
                      color:"#38bdf8",padding:"8px 4px"}}
                    value={dayHours[day]}
                    disabled={isSubmitted&&!isRejected}
                    onChange={e=>setDay(day, e.target.value)}
                  />
                  <div style={{fontSize:9,color:"#1e3a5f",marginTop:3}}>hrs</div>
                  {!isSubmitted && (
                    <button
                      onClick={()=>timerRunning&&timerDay===day ? stopTimer() : (!timerRunning ? startTimer(day) : null)}
                      style={{marginTop:4,fontSize:9,padding:"2px 6px",borderRadius:4,border:"none",cursor:"pointer",
                        background: timerRunning&&timerDay===day ? "#1a0808" : timerRunning ? "#0a1626" : "#021f14",
                        color: timerRunning&&timerDay===day ? "#f87171" : timerRunning ? "#1e3a5f" : "#34d399"}}>
                      {timerRunning&&timerDay===day ? "⏹ stop" : "▶ clock"}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Project + notes */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:18}}>
              <FF label="Project / Engagement">
                <select className="inp" value={projectId} disabled={isSubmitted&&!isRejected}
                  onChange={e=>setProjectId(e.target.value)}>
                  <option value="">— General / {consultant?.client||"No client"} —</option>
                  {clientProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </FF>
              <FF label="Notes (optional)">
                <input className="inp" value={notes} disabled={isSubmitted&&!isRejected}
                  placeholder="e.g. Sprint 3 delivery, client travel..."
                  onChange={e=>setNotes(e.target.value)}/>
              </FF>
            </div>

            {/* Error / success */}
            {error&&<div style={{marginBottom:12,padding:"8px 12px",background:"#1a0808",border:"1px solid #3d1010",borderRadius:6,fontSize:12,color:"#f87171"}}>{error}</div>}
            {successMsg&&<div style={{marginBottom:12,padding:"8px 12px",background:"#021f14",border:"1px solid #063d28",borderRadius:6,fontSize:12,color:"#34d399"}}>{successMsg}</div>}

            {/* Submit button */}
            {(!isSubmitted||isRejected)&&(
              <button className="btn bp" style={{width:"100%",padding:"12px",fontSize:14,fontWeight:700}}
                onClick={handleSubmit} disabled={totalHours===0}>
                {isRejected?"Resubmit Timesheet →":"Submit for Approval →"}
              </button>
            )}
          </div>

          {/* Right: summary panel */}
          <div style={{display:"flex",flexDirection:"column",gap:12}}>

            {/* Week totals card */}
            <div className="card" style={{padding:"18px 20px",overflowX:"auto"}}>
              <div className="section-hdr" style={{marginBottom:14}}>Week Summary</div>
              {DAYS.map(day=>{
                const h = parseFloat(dayHours[day])||0;
                const rev = h * billRate;
                return (
                  <div key={day} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"5px 0",borderBottom:"1px solid #070b14"}}>
                    <span style={{fontSize:12,color:"#64748b",width:32}}>{day}</span>
                    <div style={{flex:1,margin:"0 8px",height:4,background:"#1a2d45",borderRadius:2,overflow:"hidden"}}>
                      <div style={{height:4,width:`${Math.min(100,h/12*100)}%`,background:"#0369a1",borderRadius:2}}/>
                    </div>
                    <span style={{fontSize:12,fontFamily:"monospace",color:"#38bdf8",minWidth:28,textAlign:"right"}}>{h}h</span>
                    <span style={{fontSize:11,color:"#3d5a7a",minWidth:56,textAlign:"right"}}>{fmt(rev)}</span>
                  </div>
                );
              })}
              <div style={{marginTop:10,paddingTop:10,borderTop:"2px solid #0369a1",
                display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>Total</span>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:20,fontWeight:800,color:"#38bdf8",fontFamily:"'DM Mono',monospace"}}>{totalHours}h</div>
                  <div style={{fontSize:12,color:"#34d399",fontFamily:"monospace"}}>{fmt(totalRevenue)}</div>
                </div>
              </div>
            </div>

            {/* Workflow guide */}
            <div className="card" style={{padding:"16px 18px"}}>
              <div className="section-hdr" style={{marginBottom:10}}>Approval Flow</div>
              {[
                ["1","You submit","→ Sent to PM"],
                ["2","PM reviews","→ Approves or rejects"],
                ["3","Owner approves","→ Final sign-off"],
                ["4","Locked","→ Invoice generated"],
              ].map(([n,l,sub])=>(
                <div key={n} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"5px 0",
                  borderBottom:"1px solid #070b14"}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:"#0369a1",
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:9,fontWeight:800,color:"#fff",flexShrink:0,marginTop:1}}>{n}</div>
                  <div>
                    <div style={{fontSize:11,fontWeight:600,color:"#cbd5e1"}}>{l}</div>
                    <div style={{fontSize:10,color:"#3d5a7a"}}>{sub}</div>
                  </div>
                </div>
              ))}
              <div style={{marginTop:10,fontSize:10,color:"#1e3a5f"}}>
                Questions? Contact Manju or check the Approval Queue tab.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MY SUBMISSIONS VIEW ────────────────────────────────────────────── */}
      {viewMode==="history"&&(
        <div>
          {mySubs.length===0&&(
            <div style={{padding:"40px",textAlign:"center",background:"#060d1c",borderRadius:10,
              border:"1px dashed #1a2d45",fontSize:12,color:"#1e3a5f"}}>
              No timesheets submitted yet. Switch to "Log Hours" to submit your first one.
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {mySubs.map(sub=>{
              const sc = statusColor[sub.status]||"#64748b";
              const sb = statusBg[sub.status]||"#0a0f1c";
              const isRej = sub.status==="rejected";
              return (
                <div key={sub.id} className="card" style={{padding:"16px 20px",
                  borderLeft:`4px solid ${sc}`,opacity:sub.status==="locked"?0.8:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>
                        {sub.period}
                      </div>
                      <div style={{fontSize:11,color:"#3d5a7a",marginTop:2}}>
                        Submitted {sub.submittedAt||"—"}
                        {sub.projectId&&projects.find(p=>p.id===sub.projectId)&&
                          ` · ${projects.find(p=>p.id===sub.projectId).name}`}
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:16,fontWeight:800,color:"#38bdf8",fontFamily:"monospace"}}>{sub.totalHours}h</div>
                        <div style={{fontSize:11,color:"#34d399",fontFamily:"monospace"}}>{fmt(sub.totalRevenue)}</div>
                      </div>
                      <span style={{fontSize:10,padding:"3px 10px",borderRadius:20,
                        background:sb,color:sc,border:`1px solid ${sc}44`}}>{sub.status}</span>
                    </div>
                  </div>

                  {/* Day breakdown if available */}
                  {sub.dayHours&&(
                    <div style={{display:"flex",gap:6,margin:"8px 0"}}>
                      {DAYS.map(d=>(
                        <div key={d} style={{textAlign:"center",flex:1,padding:"4px 2px",
                          background:"#070c18",borderRadius:4}}>
                          <div style={{fontSize:9,color:"#1e3a5f"}}>{d}</div>
                          <div style={{fontSize:12,fontWeight:700,fontFamily:"monospace",color:"#38bdf8"}}>{sub.dayHours[d]||0}h</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Rejection note */}
                  {isRej&&(
                    <div style={{padding:"8px 12px",background:"#1a0808",borderRadius:6,
                      border:"1px solid #3d1010",marginBottom:10}}>
                      <div style={{fontSize:11,color:"#f87171",fontWeight:700}}>Rejected</div>
                      <div style={{fontSize:11,color:"#f87171",marginTop:2}}>{sub.rejectionNote||"Please review and resubmit."}</div>
                    </div>
                  )}

                  {/* PM notes */}
                  {sub.pmNotes&&(
                    <div style={{padding:"6px 10px",background:"#020d1c",borderRadius:4,
                      fontSize:11,color:"#38bdf8",marginBottom:8}}>
                      PM note: {sub.pmNotes}
                    </div>
                  )}

                  {/* Invoice ref if locked */}
                  {sub.status==="locked"&&sub.invoiceRef&&(
                    <div style={{fontSize:11,color:"#a78bfa",padding:"4px 10px",background:"#0d0b1a",borderRadius:4}}>
                      Invoice: {sub.invoiceRef}
                    </div>
                  )}

                  {/* Resubmit button if rejected */}
                  {isRej&&(
                    resubId===sub.id ? (
                      <div style={{marginTop:8}}>
                        <div style={{fontSize:11,color:"#3d5a7a",marginBottom:4}}>Add a note to your resubmission (optional):</div>
                        <div style={{display:"flex",gap:8}}>
                          <input className="inp" style={{flex:1,fontSize:12}}
                            placeholder="What changed..."
                            value={resubNote} onChange={e=>setResubNote(e.target.value)}/>
                          <button className="btn bp" style={{fontSize:11}}
                            onClick={()=>handleResubmit({...sub,notes:resubNote||sub.notes})}>Resubmit</button>
                          <button className="btn bg" style={{fontSize:11}}
                            onClick={()=>setResubId(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button className="btn bp" style={{fontSize:11,marginTop:6}}
                        onClick={()=>{ setResubId(sub.id); setViewMode("history"); }}>
                        Resubmit Timesheet →
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────────
function TSOverview({ tsSubmissions, roster, setTsSubmissions, finInvoices, setFinInvoices }) {
  const pending    = tsSubmissions.filter(s=>s.status==="submitted");
  const pmApproved = tsSubmissions.filter(s=>s.status==="pm_approved");
  const approved   = tsSubmissions.filter(s=>s.status==="approved");
  const locked     = tsSubmissions.filter(s=>s.status==="locked");
  const rejected   = tsSubmissions.filter(s=>s.status==="rejected");
  const drafts     = tsSubmissions.filter(s=>s.status==="draft");

  const lockedRev  = locked.reduce((s,x)=>s+x.totalRevenue,0);
  const pendingRev = [...pending,...pmApproved,...approved].reduce((s,x)=>s+x.totalRevenue,0);
  const readyToInvoice = approved.filter(s=>!s.invoiceRef);

  // Workflow funnel
  const funnelSteps = [
    { label:"Hours entered",  count:drafts.length,     color:"#475569" },
    { label:"Submitted",      count:pending.length,    color:"#f59e0b" },
    { label:"PM Approved",    count:pmApproved.length, color:"#38bdf8" },
    { label:"Owner Approved", count:approved.length,   color:"#a78bfa" },
    { label:"Locked & Invoiced", count:locked.length,  color:"#34d399" },
  ];
  const maxCount = Math.max(...funnelSteps.map(s=>s.count),1);

  const quickApproveAll = (fromStatus, toStatus) => {
    setTsSubmissions(ss=>ss.map(s=>{
      if(s.status!==fromStatus) return s;
      if(toStatus==="pm_approved") return {...s,status:"pm_approved",pmApprovedAt:TODAY_STR};
      if(toStatus==="approved")    return {...s,status:"approved",ownerApprovedAt:TODAY_STR};
      if(toStatus==="locked") {
        return {...s,status:"locked",lockedAt:TODAY_STR};
      }
      return s;
    }));
  };

  const generateInvoices = () => {
    const ready = tsSubmissions.filter(s=>s.status==="approved"&&!s.invoiceRef);
    if(!ready.length) return;
    const newInvoices = ready.map(s=>{
      const r = roster.find(x=>x.id===s.rosterId);
      const ref = "FB-"+(2700+Math.floor(Math.random()*99));
      return { id:"fi"+uid(), number:ref, clientId:s.clientId||"acc1", description:`Consulting services — ${r?.name} — ${s.period}`, amount:s.totalRevenue, status:"draft", date:TODAY_STR, dueDate:"2026-04-11", type:"timesheet", tsSubmissionId:s.id };
    });
    setFinInvoices(inv=>[...inv,...newInvoices]);
    const refMap = {};
    ready.forEach((s,i)=>{ refMap[s.id]=newInvoices[i].number; });
    setTsSubmissions(ss=>ss.map(s=>refMap[s.id]?{...s,status:"locked",lockedAt:TODAY_STR,invoiceRef:refMap[s.id]}:s));
  };

  return (
    <div>
      {/* KPI row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:20}}>
        {[
          {l:"Drafts",        v:drafts.length,     c:"#475569"},
          {l:"Awaiting PM",   v:pending.length,    c:"#f59e0b"},
          {l:"PM Approved",   v:pmApproved.length, c:"#38bdf8"},
          {l:"Owner Approved",v:approved.length,   c:"#a78bfa"},
          {l:"Locked",        v:locked.length,     c:"#34d399"},
          {l:"Rejected",      v:rejected.length,   c:"#f87171"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:24,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
            <div style={{fontSize:10,color:"#475569",marginTop:2}}>{k.l}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"3fr 2fr",gap:16,marginBottom:16}}>
        {/* Workflow funnel */}
        <div className="card" style={{padding:"18px 22px"}}>
          <div className="section-hdr">Approval Pipeline</div>
          {funnelSteps.map((step,i)=>(
            <div key={step.label} style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:step.color,flexShrink:0}}/>
                  <span style={{fontSize:12,color:"#94a3b8"}}>{step.label}</span>
                </div>
                <span style={{fontSize:13,fontWeight:700,color:step.color,fontFamily:"'DM Mono',monospace"}}>{step.count}</span>
              </div>
              <div style={{height:8,background:"#0a1626",borderRadius:4}}>
                <div style={{height:8,borderRadius:4,background:step.color,width:`${(step.count/maxCount)*100}%`,opacity:0.85,transition:"width 0.4s"}}/>
              </div>
              {i<funnelSteps.length-1 && <div style={{marginLeft:5,paddingLeft:4,borderLeft:"2px dashed #1a2d45",height:8,marginTop:2}}/>}
            </div>
          ))}
        </div>

        {/* Revenue status */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="card" style={{padding:"16px 18px"}}>
            <div className="lbl" style={{marginBottom:8}}>Revenue by approval status</div>
            {[
              {l:"Locked & invoiced",  v:lockedRev,  c:"#34d399"},
              {l:"Awaiting approval",  v:pendingRev, c:"#f59e0b"},
              {l:"Ready to invoice",   v:readyToInvoice.reduce((s,x)=>s+x.totalRevenue,0), c:"#a78bfa"},
            ].map(r=>(
              <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #0a1626"}}>
                <span style={{fontSize:11,color:"#64748b"}}>{r.l}</span>
                <span style={{fontSize:13,fontWeight:700,color:r.c,fontFamily:"'DM Mono',monospace"}}>{fmt(r.v)}</span>
              </div>
            ))}
          </div>

          {/* Action center */}
          <div className="card" style={{padding:"16px 18px"}}>
            <div className="lbl" style={{marginBottom:10}}>⚡ Quick Actions</div>
            {pending.length>0 && (
              <button className="btn bp" style={{width:"100%",justifyContent:"center",marginBottom:8,fontSize:12}}
                onClick={()=>quickApproveAll("submitted","pm_approved")}>
                PM Approve All ({pending.length}) →
              </button>
            )}
            {pmApproved.length>0 && (
              <button className="btn bp" style={{width:"100%",justifyContent:"center",marginBottom:8,fontSize:12}}
                onClick={()=>quickApproveAll("pm_approved","approved")}>
                Owner Approve All ({pmApproved.length}) →
              </button>
            )}
            {readyToInvoice.length>0 && (
              <button className="btn bs" style={{width:"100%",justifyContent:"center",fontSize:12}}
                onClick={generateInvoices}>
                <I d={ICONS.check} s={13}/>Generate {readyToInvoice.length} Invoice{readyToInvoice.length>1?"s":""} ({fmt(readyToInvoice.reduce((s,x)=>s+x.totalRevenue,0))})
              </button>
            )}
            {pending.length===0&&pmApproved.length===0&&readyToInvoice.length===0 && (
              <div style={{fontSize:11,color:"#1e3a5f",textAlign:"center",padding:"8px 0"}}>All caught up ✓</div>
            )}
          </div>
        </div>
      </div>

      {/* Rejected — action needed */}
      {rejected.length>0 && (
        <div className="card">
          <div className="section-hdr" style={{color:"#f87171"}}>⚠ Rejected — Consultant Action Required</div>
          {rejected.map(s=>{
            const r = roster.find(x=>x.id===s.rosterId);
            return (
              <div key={s.id} className="tr" style={{gridTemplateColumns:"1.5fr 90px 1fr 1fr 90px"}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r?.name}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{s.period}</div>
                </div>
                <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{s.totalHours}h</span>
                <span style={{fontSize:11,color:"#f87171"}}>{s.rejectionNote?.slice(0,70)}</span>
                <span style={{fontSize:11,color:"#475569"}}>Resubmit after corrections</span>
                <button className="btn br" style={{fontSize:10,padding:"4px 10px"}}
                  onClick={()=>setTsSubmissions(ss=>ss.map(x=>x.id===s.id?{...x,status:"draft",rejectionNote:"",submittedAt:""}:x))}>
                  Reset to Draft
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Hours Grid ────────────────────────────────────────────────────────────────
function TSGrid({ roster, setRoster, tsHours, setTsHours, tsSubmissions, setTsSubmissions }) {
  const [editCell, setEditCell]   = useState(null);
  const [editVal, setEditVal]     = useState("");
  const [rejectModal, setRejectModal] = useState(null);
  const [rejectNote, setRejectNote]   = useState("");

  // Determine lock status per consultant per month
  const isLocked = (rid, mi) => tsSubmissions.some(s=>s.rosterId===rid&&s.monthIdx===mi&&["locked","approved","pm_approved","submitted"].includes(s.status));
  const submissionFor = (rid, mi) => tsSubmissions.find(s=>s.rosterId===rid&&s.monthIdx===mi);

  const updateHrs = (rid, mi, val) => {
    if(isLocked(rid, mi)) return;
    setTsHours(h=>({...h,[rid]:h[rid].map((v,i)=>i===mi?+val:v)}));
    // Keep draft submission in sync
    setTsSubmissions(ss=>ss.map(s=>{
      if(s.rosterId!==rid||s.monthIdx!==mi||s.status!=="draft") return s;
      const hrs = tsHours[rid]?.map((v,i)=>i===mi?+val:v)||[];
      const total = hrs.reduce((a,b)=>a+b,0);
      const r = roster.find(x=>x.id===rid);
      return {...s, totalHours:total, totalRevenue:total*(r?.billRate||0)};
    }));
  };

  const submitMonth = (rid, mi) => {
    const r = roster.find(x=>x.id===rid);
    const hrs = tsHours[rid]||Array(12).fill(0);
    const totalH = hrs[mi]||0;
    const sub = submissionFor(rid, mi);
    const period = `${MONTHS[mi]} 2026`;
    if(sub) {
      setTsSubmissions(ss=>ss.map(s=>s.id===sub.id?{...s,status:"submitted",submittedAt:TODAY_STR,totalHours:totalH,totalRevenue:totalH*(r?.billRate||0)}:s));
    } else {
      setTsSubmissions(ss=>[...ss,{
        id:"tss"+uid(), rosterId:rid, period, monthIdx:mi, year:2026,
        totalHours:totalH, billRate:r?.billRate||0, totalRevenue:totalH*(r?.billRate||0),
        status:"submitted", clientId:"", projectId:"",
        submittedAt:TODAY_STR, pmApproverId:"", pmApprovedAt:"",
        ownerApprovedAt:"", lockedAt:"", pmNotes:"", rejectionNote:"", invoiceRef:""
      }]);
    }
  };

  const startEdit = (rid,field,val) => { setEditCell({rid,field}); setEditVal(val); };
  const commitEdit = () => {
    if(!editCell) return;
    setRoster(rs=>rs.map(r=>r.id===editCell.rid?{...r,[editCell.field]:editCell.field==="billRate"?+editVal:editVal}:r));
    setEditCell(null);
  };
  const isEditing = (rid,field) => editCell?.rid===rid && editCell?.field===field;
  const EditCell = ({rid,field,value,style={}}) => isEditing(rid,field)
    ? <input autoFocus className="inp" value={editVal}
        onChange={e=>setEditVal(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={e=>{if(e.key==="Enter")commitEdit();if(e.key==="Escape")setEditCell(null);}}
        style={{width:"100%",padding:"3px 6px",fontSize:12,...style}}/>
    : <div onClick={()=>startEdit(rid,field,value)} title="Click to edit"
        style={{cursor:"text",padding:"2px 4px",borderRadius:4,transition:"background 0.15s",...style}}
        onMouseEnter={e=>e.currentTarget.style.background="#0f1e30"}
        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        {value}
      </div>;

  const totalsByMonth   = MONTHS.map((_,mi)=>roster.reduce((s,r)=>s+(tsHours[r.id]?.[mi]||0),0));
  const totalRevByMonth = MONTHS.map((_,mi)=>roster.reduce((s,r)=>s+(tsHours[r.id]?.[mi]||0)*r.billRate,0));

  return (
    <div>
      <div style={{fontSize:11,color:"#475569",marginBottom:14}}>
        Submitted/approved months are locked (grey). Click a cell to edit draft hours. Use "Submit" to send for approval.
      </div>
      <div className="card" style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{borderBottom:"1px solid #111d2d"}}>
              <th style={{padding:"10px 14px",textAlign:"left"}} className="th">Consultant</th>
              <th className="th" style={{padding:"8px 6px",textAlign:"left"}}>Rate</th>
              {MONTHS.map((m,mi)=>(
                <th key={m} className="th" style={{padding:"8px 6px",textAlign:"center",minWidth:58,fontSize:10}}>{m}</th>
              ))}
              <th className="th" style={{padding:"8px 12px",textAlign:"right"}}>Total Hrs</th>
              <th className="th" style={{padding:"8px 12px",textAlign:"right"}}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {roster.map(r=>{
              const hrs = tsHours[r.id]||Array(12).fill(0);
              const totalH = hrs.reduce((s,v)=>s+v,0);
              const totalR = totalH*r.billRate;
              return (
                <tr key={r.id} style={{borderBottom:"1px solid #0a1626"}}>
                  <td style={{padding:"6px 14px",minWidth:160}}>
                    <EditCell rid={r.id} field="name" value={r.name} style={{fontWeight:600,color:"#cbd5e1"}}/>
                    <EditCell rid={r.id} field="role" value={r.role} style={{fontSize:10,color:"#3d5a7a"}}/>
                  </td>
                  <td style={{padding:"4px 6px",minWidth:55}}>
                    <EditCell rid={r.id} field="billRate" value={`$${r.billRate}`} style={{fontFamily:"'DM Mono',monospace",color:"#7dd3fc",fontSize:12}}/>
                  </td>
                  {hrs.map((h,mi)=>{
                    const locked = isLocked(r.id, mi);
                    const sub    = submissionFor(r.id, mi);
                    const sc     = sub ? TS_STATUS_COLOR[sub.status] : "#1a2d45";
                    const canSubmit = !locked && h>0 && (!sub||sub.status==="draft"||sub.status==="rejected");
                    return (
                      <td key={mi} style={{padding:"3px 3px",textAlign:"center",position:"relative"}}>
                        <input className="inp" type="number" value={h}
                          onChange={e=>updateHrs(r.id,mi,e.target.value)}
                          disabled={locked}
                          style={{width:50,padding:"4px 5px",textAlign:"center",fontSize:12,
                            background:locked?"#050910":h===0?"#0a0f1a":"#0c1e10",
                            color:locked?"#1e3a5f":"#e2e8f0",
                            border:`1px solid ${locked?sc+"55":"#1a2d45"}`,
                            cursor:locked?"not-allowed":"text"}}/>
                        {/* Status pip + submit */}
                        {sub&&sub.status!=="draft" && (
                          <div style={{position:"absolute",top:2,right:5,width:6,height:6,borderRadius:"50%",background:sc}}/>
                        )}
                        {canSubmit && (
                          <button onClick={()=>submitMonth(r.id,mi)}
                            title="Submit for approval"
                            style={{position:"absolute",bottom:2,right:2,width:14,height:14,borderRadius:"50%",
                              background:"#f59e0b",border:"none",cursor:"pointer",fontSize:8,color:"#000",fontWeight:800,
                              display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>↑</button>
                        )}
                      </td>
                    );
                  })}
                  <td className="mono" style={{padding:"8px 12px",textAlign:"right",fontWeight:700,color:"#e2e8f0"}}>{totalH}h</td>
                  <td className="mono" style={{padding:"8px 12px",textAlign:"right",color:"#38bdf8",fontWeight:600}}>{fmt(totalR)}</td>
                </tr>
              );
            })}
            <tr style={{background:"#0a1626",borderTop:"1px solid #1a2d45"}}>
              <td style={{padding:"10px 14px",fontSize:11,fontWeight:800,color:"#3d5a7a",textTransform:"uppercase",letterSpacing:"0.07em"}} colSpan={2}>TOTALS</td>
              {totalsByMonth.map((t,i)=>(
                <td key={i} className="mono" style={{padding:"8px 6px",textAlign:"center",fontWeight:700,fontSize:11,color:t>0?"#34d399":"#3d5a7a"}}>{t}</td>
              ))}
              <td className="mono" style={{padding:"10px 12px",textAlign:"right",fontWeight:700,fontSize:13,color:"#e2e8f0"}}>{totalsByMonth.reduce((s,v)=>s+v,0)}h</td>
              <td className="mono" style={{padding:"10px 12px",textAlign:"right",fontWeight:700,fontSize:13,color:"#38bdf8"}}>{fmt(totalRevByMonth.reduce((s,v)=>s+v,0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* Legend */}
      <div style={{display:"flex",gap:14,marginTop:12,flexWrap:"wrap"}}>
        {Object.entries(TS_STATUS_COLOR).map(([k,c])=>(
          <span key={k} style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#475569"}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:c,display:"inline-block"}}/>
            {TS_STATUS_LABEL[k]}
          </span>
        ))}
        <span style={{fontSize:10,color:"#f59e0b"}}>↑ = submit this month</span>
      </div>
    </div>
  );
}

// ── Approval Queue ────────────────────────────────────────────────────────────
function TSApprovals({ tsSubmissions, setTsSubmissions, roster, orgMembers, projects, finInvoices, setFinInvoices }) {
  const [rejectModal, setRejectModal] = useState(null);
  const [rejectNote, setRejectNote]   = useState("");
  const [notesModal, setNotesModal]   = useState(null);
  const [pmNote, setPmNote]           = useState("");

  const pending    = tsSubmissions.filter(s=>s.status==="submitted");
  const pmApproved = tsSubmissions.filter(s=>s.status==="pm_approved");
  const readyToLock= tsSubmissions.filter(s=>s.status==="approved"&&!s.invoiceRef);

  const pmApprove = (id, note="") => {
    setTsSubmissions(ss=>ss.map(s=>s.id===id?{...s,status:"pm_approved",pmApproverId:"org2",pmApprovedAt:TODAY_STR,pmNotes:note}:s));
    addAudit&&addAudit("Timesheets","PM Approve Timesheet","Timesheet Approval",`PM approved timesheet ${id}`);
    setNotesModal(null);
  };
  const ownerApprove = (id) => {
    setTsSubmissions(ss=>ss.map(s=>s.id===id?{...s,status:"approved",ownerApprovedAt:TODAY_STR}:s));
    addAudit&&addAudit("Timesheets","Owner Approved","Timesheet Approval",`Final approval: ${id}`);
  };
  const reject = (id) => {
    setTsSubmissions(ss=>ss.map(s=>s.id===id?{...s,status:"rejected",rejectionNote:rejectNote}:s));
    addAudit&&addAudit("Timesheets","Reject Timesheet","Timesheet Approval",`Rejected: ${id} — ${rejectNote}`);
    setRejectModal(null);
    setRejectNote("");
  };
  const lockAndInvoice = (sub) => {
    const r = roster.find(x=>x.id===sub.rosterId);
    const ref = "FB-"+(2700+Math.floor(Math.random()*99));
    const newInv = { id:"fi"+uid(), number:ref, clientId:sub.clientId||"acc1",
      description:`Consulting — ${r?.name} — ${sub.period}`,
      amount:sub.totalRevenue, status:"draft", date:TODAY_STR, dueDate:"2026-04-11", type:"timesheet" };
    setFinInvoices(inv=>[...inv,newInv]);
    setTsSubmissions(ss=>ss.map(s=>s.id===sub.id?{...s,status:"locked",lockedAt:TODAY_STR,invoiceRef:ref}:s));
    addAudit&&addAudit("Timesheets","Invoice Created from Timesheet","Timesheet Approval",`Invoice ${ref} created`,{amount:newInv.amount});
  };

  const SubRow = ({s, actions}) => {
    const r   = roster.find(x=>x.id===s.rosterId);
    const proj= projects?.find(p=>p.id===s.projectId);
    return (
      <div className="tr" style={{gridTemplateColumns:"1.6fr 90px 80px 90px 110px 1fr"}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r?.name}</div>
          <div style={{fontSize:10,color:"#3d5a7a"}}>{s.period} {proj?`· ${proj.name.slice(0,20)}`:""}</div>
          {s.submittedAt&&<div style={{fontSize:9,color:"#1e3a5f",marginTop:1}}>Submitted {fmtDate(s.submittedAt)}</div>}
        </div>
        <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0",fontFamily:"'DM Mono',monospace"}}>{s.totalHours}h</span>
        <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{fmt(s.totalRevenue)}</span>
        <span className="bdg" style={{background:TS_STATUS_BG[s.status],color:TS_STATUS_COLOR[s.status],fontSize:9}}>{TS_STATUS_LABEL[s.status]}</span>
        <div style={{fontSize:10,color:"#475569",lineHeight:1.3}}>{s.pmNotes?.slice(0,35)||""}</div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{actions}</div>
      </div>
    );
  };

  const colHdr = <div className="tr" style={{gridTemplateColumns:"1.6fr 90px 80px 90px 110px 1fr",padding:"8px 18px"}}>
    {["Consultant","Hours","Revenue","Status","PM Notes","Actions"].map(h=><span key={h} className="th">{h}</span>)}
  </div>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Step 1: PM Queue */}
      <div className="card">
        <div className="section-hdr" style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{color:"#f59e0b"}}>Step 1 — PM Review: Awaiting PM Approval ({pending.length})</span>
          {pending.length>0&&<button className="btn bp" style={{fontSize:11,padding:"4px 12px"}}
            onClick={()=>pending.forEach(s=>pmApprove(s.id))}>Approve All</button>}
        </div>
        {pending.length===0 && <div style={{padding:"16px 18px",fontSize:11,color:"#1e3a5f"}}>No submissions awaiting PM review.</div>}
        {pending.length>0&&<>{colHdr}{pending.map(s=>(
          <SubRow key={s.id} s={s} actions={[
            <button key="a" className="btn bs" style={{fontSize:10,padding:"4px 10px"}}
              onClick={()=>{setNotesModal(s);setPmNote("");}}>Approve</button>,
            <button key="r" className="btn br" style={{fontSize:10,padding:"4px 10px"}}
              onClick={()=>{setRejectModal(s);setRejectNote("");}}>Reject</button>,
          ]}/>
        ))}</>}
      </div>

      {/* Step 2: Owner Queue */}
      <div className="card">
        <div className="section-hdr" style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{color:"#38bdf8"}}>Step 2 — Owner Review: PM Approved ({pmApproved.length})</span>
          {pmApproved.length>0&&<button className="btn bp" style={{fontSize:11,padding:"4px 12px"}}
            onClick={()=>pmApproved.forEach(s=>ownerApprove(s.id))}>Approve All</button>}
        </div>
        {pmApproved.length===0 && <div style={{padding:"16px 18px",fontSize:11,color:"#1e3a5f"}}>No submissions awaiting owner approval.</div>}
        {pmApproved.length>0&&<>{colHdr}{pmApproved.map(s=>(
          <SubRow key={s.id} s={s} actions={[
            <button key="a" className="btn bs" style={{fontSize:10,padding:"4px 10px"}}
              onClick={()=>ownerApprove(s.id)}>Approve</button>,
            <button key="r" className="btn br" style={{fontSize:10,padding:"4px 10px"}}
              onClick={()=>{setRejectModal(s);setRejectNote("");}}>Reject</button>,
          ]}/>
        ))}</>}
      </div>

      {/* Step 3: Lock & Invoice */}
      <div className="card">
        <div className="section-hdr" style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{color:"#a78bfa"}}>Step 3 — Lock & Invoice: Owner Approved ({readyToLock.length})</span>
          {readyToLock.length>0&&<button className="btn bs" style={{fontSize:11,padding:"4px 12px"}}
            onClick={()=>readyToLock.forEach(s=>lockAndInvoice(s))}>
            <I d={ICONS.check} s={11}/>Lock All & Generate Invoices
          </button>}
        </div>
        {readyToLock.length===0 && <div style={{padding:"16px 18px",fontSize:11,color:"#1e3a5f"}}>No approved timesheets ready to lock.</div>}
        {readyToLock.length>0&&<>{colHdr}{readyToLock.map(s=>(
          <SubRow key={s.id} s={s} actions={[
            <button key="l" className="btn bs" style={{fontSize:10,padding:"4px 10px"}}
              onClick={()=>lockAndInvoice(s)}>
              <I d={ICONS.check} s={10}/>Lock & Invoice
            </button>,
          ]}/>
        ))}</>}
      </div>

      {/* PM Approve modal with notes */}
      {notesModal&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setNotesModal(null)}>
          <div className="modal" style={{maxWidth:440}}>
            <MH title="PM Approval" onClose={()=>setNotesModal(null)}/>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>
              Approving: <b style={{color:"#e2e8f0"}}>{roster.find(x=>x.id===notesModal.rosterId)?.name}</b> — {notesModal.period} — {notesModal.totalHours}h — {fmt(notesModal.totalRevenue)}
            </div>
            <FF label="PM Notes (optional)">
              <textarea className="inp" rows={2} value={pmNote} onChange={e=>setPmNote(e.target.value)} placeholder="Looks good. Hours match project tracker."/>
            </FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setNotesModal(null)}>Cancel</button>
              <button className="btn bs" onClick={()=>pmApprove(notesModal.id,pmNote)}><I d={ICONS.check} s={13}/>Approve</button>
            </div>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {rejectModal&&(
        <div className="modal-bg" onClick={e=>e.target===e.currentTarget&&setRejectModal(null)}>
          <div className="modal" style={{maxWidth:440}}>
            <MH title="Reject Timesheet" onClose={()=>setRejectModal(null)}/>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>
              Rejecting: <b style={{color:"#e2e8f0"}}>{roster.find(x=>x.id===rejectModal.rosterId)?.name}</b> — {rejectModal.period}
            </div>
            <FF label="Rejection Reason (required)">
              <textarea className="inp" rows={3} value={rejectNote} onChange={e=>setRejectNote(e.target.value)} placeholder="Please explain why this timesheet is being rejected…"/>
            </FF>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:16}}>
              <button className="btn bg" onClick={()=>setRejectModal(null)}>Cancel</button>
              <button className="btn br" disabled={!rejectNote.trim()} onClick={()=>reject(rejectModal.id)}>Reject & Notify</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── History & Locked ──────────────────────────────────────────────────────────
function TSHistory({ tsSubmissions, setTsSubmissions, roster, finInvoices }) {
  const [filter, setFilter] = useState("all");

  const historical = tsSubmissions
    .filter(s=>["locked","approved","pm_approved","rejected"].includes(s.status))
    .filter(s=>filter==="all"||s.status===filter)
    .sort((a,b)=>b.period.localeCompare(a.period));

  const lockedRev   = tsSubmissions.filter(s=>s.status==="locked").reduce((s,x)=>s+x.totalRevenue,0);
  const invoiced    = tsSubmissions.filter(s=>s.status==="locked"&&s.invoiceRef).length;
  const pendingInv  = tsSubmissions.filter(s=>s.status==="locked"&&!s.invoiceRef).length;

  // Group by period
  const byPeriod = historical.reduce((acc,s)=>{
    (acc[s.period]=acc[s.period]||[]).push(s);
    return acc;
  },{});

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:18}}>
        {[
          {l:"Total Locked Revenue", v:fmt(lockedRev),                c:"#34d399"},
          {l:"Invoiced",             v:invoiced,                      c:"#34d399"},
          {l:"Locked, Not Invoiced", v:pendingInv,                    c:pendingInv>0?"#f59e0b":"#34d399"},
          {l:"Rejected (total)",     v:tsSubmissions.filter(s=>s.status==="rejected").length, c:"#f87171"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px"}}>
            <div className="th" style={{marginBottom:4}}>{k.l}</div>
            <div style={{fontSize:22,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
        {["all","locked","approved","pm_approved","rejected"].map(f=>(
          <button key={f} className="btn bg" style={{fontSize:11,padding:"5px 10px",
            borderColor:filter===f?"#0284c7":"#1a2d45",color:filter===f?"#38bdf8":"#475569"}}
            onClick={()=>setFilter(f)}>
            {TS_STATUS_LABEL[f]||"All"} ({f==="all"?historical.length:tsSubmissions.filter(s=>s.status===f).length})
          </button>
        ))}
      </div>

      {Object.entries(byPeriod).map(([period,subs])=>{
        const periodRev = subs.reduce((s,x)=>s+x.totalRevenue,0);
        return (
          <div key={period} className="card" style={{marginBottom:14}}>
            <div className="section-hdr" style={{display:"flex",justifyContent:"space-between"}}>
              <span>{period}</span>
              <span style={{fontFamily:"'DM Mono',monospace",color:"#38bdf8",fontSize:12}}>{fmt(periodRev)}</span>
            </div>
            <div className="tr" style={{gridTemplateColumns:"1.5fr 70px 90px 90px 100px 110px 80px",padding:"8px 18px"}}>
              {["Consultant","Hours","Revenue","Status","PM Approved","Invoice Ref","Actions"].map(h=><span key={h} className="th">{h}</span>)}
            </div>
            {subs.map(s=>{
              const r = roster.find(x=>x.id===s.rosterId);
              const inv = finInvoices?.find(i=>i.number===s.invoiceRef);
              return (
                <div key={s.id} className="tr" style={{gridTemplateColumns:"1.5fr 70px 90px 90px 100px 110px 80px"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{r?.name}</div>
                    <div style={{fontSize:10,color:"#3d5a7a"}}>{r?.role}</div>
                  </div>
                  <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#e2e8f0"}}>{s.totalHours}h</span>
                  <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{fmt(s.totalRevenue)}</span>
                  <span className="bdg" style={{background:TS_STATUS_BG[s.status],color:TS_STATUS_COLOR[s.status],fontSize:9}}>{TS_STATUS_LABEL[s.status]}</span>
                  <span style={{fontSize:11,color:"#475569"}}>{s.pmApprovedAt?fmtDate(s.pmApprovedAt):"—"}</span>
                  <div>
                    {s.invoiceRef
                      ? <span className="bdg" style={{background:"#021f14",color:"#34d399",fontSize:9}}>{s.invoiceRef}</span>
                      : <span style={{fontSize:11,color:"#1e3a5f"}}>—</span>}
                  </div>
                  <div style={{display:"flex",gap:4}}>
                    {s.status==="locked"&&(
                      <button className="btn br" style={{fontSize:9,padding:"3px 7px"}}
                        title="Unlock (admin)"
                        onClick={()=>setTsSubmissions(ss=>ss.map(x=>x.id===s.id?{...x,status:"approved",lockedAt:"",invoiceRef:""}:x))}>
                        Unlock
                      </button>
                    )}
                    {s.status==="rejected"&&(
                      <button className="btn bg" style={{fontSize:9,padding:"3px 7px"}}
                        onClick={()=>setTsSubmissions(ss=>ss.map(x=>x.id===s.id?{...x,status:"draft",rejectionNote:"",submittedAt:""}:x))}>
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {Object.keys(byPeriod).length===0&&(
        <div style={{padding:"24px",textAlign:"center",fontSize:12,color:"#1e3a5f"}}>No records match this filter.</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE ORDER MODULE
// ═══════════════════════════════════════════════════════════════════════════════
function ChangeOrderModule({ changeOrders, setChangeOrders, projects, contracts, sows, roster, crmAccounts, finInvoices, setFinInvoices }) {
  const [sub, setSub] = useState("dashboard");
  const tabs = [
    { id:"dashboard", label:"Dashboard"      },
    { id:"log",       label:"Change Log"     },
    { id:"builder",   label:"New Change Order"},
    { id:"impact",    label:"Budget Impact"  },
  ];
  const pending = changeOrders.filter(c=>c.status==="pending").length;
  const props = { changeOrders, setChangeOrders, projects, contracts, sows, roster, crmAccounts, finInvoices, setFinInvoices };
  return (
    <div>
      <PH title="Change Order Management" sub="Scope changes · Budget amendments · Client approvals · Contract amendments"/>
      <div style={{display:"flex",gap:4,marginBottom:22,background:"#060d1c",borderRadius:10,padding:4,border:"1px solid #1a2d45",width:"fit-content"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"7px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:sub===t.id?"linear-gradient(135deg,#0369a1,#0284c7)":"transparent",
              color:sub===t.id?"#fff":"#475569",transition:"all 0.15s",position:"relative"}}>
            {t.label}
            {t.id==="log"&&pending>0&&<span style={{position:"absolute",top:4,right:6,background:"#f59e0b",color:"#000",borderRadius:"50%",width:16,height:16,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{pending}</span>}
          </button>
        ))}
      </div>
      {sub==="dashboard" && <CODashboard  {...props}/>}
      {sub==="log"       && <COLog        {...props}/>}
      {sub==="builder"   && <COBuilder    {...props} onSave={(co)=>{setChangeOrders(cos=>[...cos,co]);addAudit&&addAudit("Projects","New Change Order","Change Orders",`CO ${co.number}: ${co.title}`,{amount:co.changeAmount});setSub("log");}}/>}
      {sub==="impact"    && <COImpact     {...props}/>}
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function CODashboard({ changeOrders, setChangeOrders, projects, roster }) {
  const approved  = changeOrders.filter(c=>c.status==="approved");
  const pending   = changeOrders.filter(c=>c.status==="pending");
  const drafts    = changeOrders.filter(c=>c.status==="draft");
  const rejected  = changeOrders.filter(c=>c.status==="rejected");

  const totalAdded    = approved.filter(c=>c.changeAmount>0).reduce((s,c)=>s+c.changeAmount,0);
  const totalReduced  = approved.filter(c=>c.changeAmount<0).reduce((s,c)=>s+c.changeAmount,0);
  const pendingValue  = pending.reduce((s,c)=>s+Math.abs(c.changeAmount),0);
  const netImpact     = totalAdded + totalReduced;

  // Type breakdown
  const byType = Object.entries(CO_TYPE_LABEL).map(([k,label])=>({
    key:k, label, count:changeOrders.filter(c=>c.type===k).length,
    value:changeOrders.filter(c=>c.type===k).reduce((s,c)=>s+c.changeAmount,0),
    color:CO_TYPE_COLOR[k],
  })).filter(t=>t.count>0);

  // Per-project impact
  const projImpact = projects.map(p=>{
    const cos = changeOrders.filter(c=>c.projectId===p.id&&c.status==="approved");
    const delta = cos.reduce((s,c)=>s+c.changeAmount,0);
    return {...p, coCount:cos.length, netDelta:delta, newBudget:(p.budget||0)+delta};
  }).filter(p=>p.coCount>0);

  const approve = (id) => setChangeOrders(cos=>cos.map(c=>c.id===id?{...c,status:"approved",approvedBy:"Manju",clientResponseAt:TODAY_STR,clientSignedBy:"Client"}:c));
  const reject  = (id) => setChangeOrders(cos=>cos.map(c=>c.id===id?{...c,status:"rejected",clientResponseAt:TODAY_STR}:c));

  return (
    <div>
      {/* KPI row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:18}}>
        {[
          {l:"Total COs",       v:changeOrders.length,      c:"#e2e8f0"},
          {l:"Budget Added",    v:fmt(totalAdded),           c:"#34d399"},
          {l:"Budget Reduced",  v:fmt(totalReduced),         c:"#f87171"},
          {l:"Net Impact",      v:fmt(netImpact),            c:netImpact>=0?"#34d399":"#f87171"},
          {l:"Pending Client",  v:fmt(pendingValue),         c:"#f59e0b"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
            <div style={{fontSize:10,color:"#475569",marginTop:2}}>{k.l}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        {/* By type */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div className="section-hdr">By Type</div>
          {byType.map(t=>(
            <div key={t.key} style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:t.color}}/>
                  <span style={{fontSize:12,color:"#94a3b8"}}>{t.label}</span>
                </div>
                <div style={{display:"flex",gap:12}}>
                  <span className="bdg" style={{background:"#0a1626",color:"#475569",fontSize:9}}>{t.count} CO{t.count>1?"s":""}</span>
                  <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:t.color}}>{t.value>0?"+":""}{fmt(t.value)}</span>
                </div>
              </div>
              <div style={{height:6,background:"#0a1626",borderRadius:3}}>
                <div style={{height:6,borderRadius:3,background:t.color,width:`${Math.min(100,(t.count/changeOrders.length)*100)}%`}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Status */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div className="section-hdr">Status Overview</div>
          {[
            {label:"Draft",          items:drafts,    action:null},
            {label:"Pending Client", items:pending,   action:"approve"},
            {label:"Approved",       items:approved,  action:null},
            {label:"Rejected",       items:rejected,  action:null},
          ].map(g=>(
            <div key={g.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0a1626"}}>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:CO_STATUS_COLOR[g.items[0]?.status||"draft"]}}/>
                <span style={{fontSize:12,color:"#94a3b8"}}>{g.label}</span>
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <span style={{fontSize:18,fontWeight:800,color:"#e2e8f0",fontFamily:"'DM Mono',monospace"}}>{g.items.length}</span>
                {g.action==="approve"&&g.items.length>0&&(
                  <button className="btn bs" style={{fontSize:10,padding:"3px 8px"}}
                    onClick={()=>g.items.forEach(c=>approve(c.id))}>Approve All</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pending action items */}
      {pending.length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div className="section-hdr" style={{color:"#f59e0b"}}>⏳ Awaiting Client Response</div>
          {pending.map(co=>{
            const proj = projects?.find(p=>p.id===co.projectId);
            const days = co.submittedAt ? Math.floor((new Date()-new Date(co.submittedAt))/(86400000)) : 0;
            return (
              <div key={co.id} className="tr" style={{gridTemplateColumns:"60px 1fr 90px 100px 80px 100px"}}>
                <span className="mono" style={{color:"#3d5a7a",fontSize:11}}>{co.number}</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{co.title}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{proj?.name} · Submitted {fmtDate(co.submittedAt)}</div>
                </div>
                <span className="bdg" style={{background:CO_TYPE_COLOR[co.type]+"22",color:CO_TYPE_COLOR[co.type],fontSize:9}}>{CO_TYPE_LABEL[co.type]}</span>
                <span style={{fontSize:13,fontFamily:"'DM Mono',monospace",color:co.changeAmount>=0?"#34d399":"#f87171",fontWeight:700}}>{co.changeAmount>=0?"+":""}{fmt(co.changeAmount)}</span>
                <span style={{fontSize:10,color:days>7?"#f87171":"#f59e0b"}}>{days}d waiting</span>
                <div style={{display:"flex",gap:6}}>
                  <button className="btn bs"  style={{fontSize:10,padding:"4px 8px"}} onClick={()=>approve(co.id)}>Approve</button>
                  <button className="btn br"  style={{fontSize:10,padding:"4px 8px"}} onClick={()=>reject(co.id)}>Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Project budget impact */}
      {projImpact.length>0&&(
        <div className="card">
          <div className="section-hdr">Project Budget Impact (approved COs only)</div>
          <div className="tr" style={{gridTemplateColumns:"1.5fr 100px 100px 100px 80px 70px",padding:"8px 18px"}}>
            {["Project","Orig. Budget","Net Change","New Budget","# COs","Status"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {projImpact.map(p=>(
            <div key={p.id} className="tr" style={{gridTemplateColumns:"1.5fr 100px 100px 100px 80px 70px"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{p.name}</div>
                <div style={{fontSize:10,color:"#3d5a7a"}}>{p.client}</div>
              </div>
              <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{fmt(p.budget)}</span>
              <span style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:p.netDelta>=0?"#34d399":"#f87171"}}>{p.netDelta>=0?"+":""}{fmt(p.netDelta)}</span>
              <span style={{fontSize:13,fontFamily:"'DM Mono',monospace",color:"#e2e8f0",fontWeight:700}}>{fmt(p.newBudget)}</span>
              <span className="bdg" style={{background:"#0a1626",color:"#475569",fontSize:9}}>{p.coCount} COs</span>
              <span className="bdg" style={{background:p.health==="Green"?"#021f14":p.health==="Amber"?"#1a1005":"#1a0808",color:p.health==="Green"?"#34d399":p.health==="Amber"?"#f59e0b":"#f87171",fontSize:9}}>{p.health}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Change Log ────────────────────────────────────────────────────────────────
function COLog({ changeOrders, setChangeOrders, projects, roster, finInvoices, setFinInvoices }) {
  const [filter, setFilter]   = useState("all");
  const [detail, setDetail]   = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [form, setForm]       = useState(null);

  const filtered = changeOrders
    .filter(c=>filter==="all"||c.status===filter||c.type===filter)
    .sort((a,b)=>b.number.localeCompare(a.number));

  const approve = (id) => setChangeOrders(cos=>cos.map(c=>c.id===id?{...c,status:"approved",approvedBy:"Manju",clientResponseAt:TODAY_STR,clientSignedBy:"Client"}:c));
  const reject  = (id) => setChangeOrders(cos=>cos.map(c=>c.id===id?{...c,status:"rejected"}:c));
  const submit  = (id) => setChangeOrders(cos=>cos.map(c=>c.id===id?{...c,status:"pending",submittedAt:TODAY_STR}:c));
  const void_co = (id) => setChangeOrders(cos=>cos.map(c=>c.id===id?{...c,status:"voided"}:c));

  const lockInvoice = (co) => {
    const proj = projects?.find(p=>p.id===co.projectId);
    const ref  = "FB-"+(2800+Math.floor(Math.random()*99));
    setFinInvoices(inv=>[...inv,{id:"fi"+uid(),number:ref,clientId:"acc1",description:`Change Order ${co.number} — ${co.title.slice(0,40)}`,amount:co.changeAmount,status:"draft",date:TODAY_STR,dueDate:"2026-04-11",type:"change_order",coId:co.id}]);
    setChangeOrders(cos=>cos.map(c=>c.id===co.id?{...c,invoiced:true,invoiceRef:ref}:c));
  };

  const selCO  = detail ? changeOrders.find(c=>c.id===detail) : null;

  return (
    <div style={{display:"grid",gridTemplateColumns:selCO?"1fr 340px":"1fr",gap:16}}>
      <div>
        {/* Filter bar */}
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {[["all","All"],["draft","Draft"],["pending","Pending"],["approved","Approved"],["rejected","Rejected"],
            ["addition","Additions"],["reduction","Reductions"],["timeline","Timeline"],["scope_change","Scope"]].map(([f,l])=>(
            <button key={f} className="btn bg" style={{fontSize:11,padding:"4px 10px",
              borderColor:filter===f?"#0284c7":"#1a2d45",color:filter===f?"#38bdf8":"#475569"}}
              onClick={()=>setFilter(f)}>{l}</button>
          ))}
        </div>

        <div className="card">
          <div className="tr" style={{gridTemplateColumns:"55px 1fr 100px 100px 80px 90px",padding:"8px 18px"}}>
            {["#","Change Order","Type","Amount","Status","Actions"].map(h=><span key={h} className="th">{h}</span>)}
          </div>
          {filtered.map(co=>{
            const proj = projects?.find(p=>p.id===co.projectId);
            return (
              <div key={co.id} className="tr"
                style={{gridTemplateColumns:"55px 1fr 100px 100px 80px 90px",cursor:"pointer",background:detail===co.id?"#0a1a2e":undefined}}
                onClick={()=>setDetail(detail===co.id?null:co.id)}>
                <span style={{fontSize:11,color:"#3d5a7a",fontFamily:"'DM Mono',monospace"}}>{co.number}</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#cbd5e1"}}>{co.title}</div>
                  <div style={{fontSize:10,color:"#3d5a7a"}}>{proj?.name||"—"} · {co.requestedBy}</div>
                  {co.invoiceRef&&<span className="bdg" style={{background:"#021f14",color:"#34d399",fontSize:8}}>{co.invoiceRef}</span>}
                </div>
                <span className="bdg" style={{background:CO_TYPE_COLOR[co.type]+"22",color:CO_TYPE_COLOR[co.type],fontSize:9}}>{CO_TYPE_LABEL[co.type]?.split(" ")[0]}</span>
                <span style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono',monospace",color:co.changeAmount>=0?"#34d399":"#f87171"}}>
                  {co.changeAmount>=0?"+":""}{fmt(co.changeAmount)}
                </span>
                <span className="bdg" style={{background:CO_STATUS_BG[co.status],color:CO_STATUS_COLOR[co.status],fontSize:9}}>{CO_STATUS_LABEL[co.status]}</span>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  {co.status==="draft"  && <button className="btn bp" style={{fontSize:9,padding:"3px 7px"}} onClick={()=>submit(co.id)}>Submit</button>}
                  {co.status==="pending"&& <button className="btn bs" style={{fontSize:9,padding:"3px 7px"}} onClick={()=>approve(co.id)}>Approve</button>}
                  {co.status==="pending"&& <button className="btn br" style={{fontSize:9,padding:"3px 7px"}} onClick={()=>reject(co.id)}>Reject</button>}
                  {co.status==="approved"&&co.changeAmount>0&&!co.invoiced&&<button className="btn bs" style={{fontSize:9,padding:"3px 7px"}} onClick={()=>lockInvoice(co)}>Invoice</button>}
                  {["draft","rejected"].includes(co.status)&&<button className="btn bg" style={{fontSize:9,padding:"3px 7px"}} onClick={()=>void_co(co.id)}>Void</button>}
                </div>
              </div>
            );
          })}
          {filtered.length===0&&<div style={{padding:"18px",fontSize:11,color:"#1e3a5f",textAlign:"center"}}>No change orders match this filter.</div>}
        </div>
      </div>

      {/* Detail panel */}
      {selCO&&(
        <div className="card" style={{height:"fit-content",position:"sticky",top:0}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #111d2d",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:"#3d5a7a"}}>{selCO.number}</div>
              <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",lineHeight:1.3}}>{selCO.title}</div>
            </div>
            <button className="btn bg" style={{padding:"4px 8px",fontSize:11}} onClick={()=>setDetail(null)}>✕</button>
          </div>
          <div style={{padding:"14px 18px"}}>
            {/* Status + type pills */}
            <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
              <span className="bdg" style={{background:CO_STATUS_BG[selCO.status],color:CO_STATUS_COLOR[selCO.status]}}>{CO_STATUS_LABEL[selCO.status]}</span>
              <span className="bdg" style={{background:CO_TYPE_COLOR[selCO.type]+"22",color:CO_TYPE_COLOR[selCO.type]}}>{CO_TYPE_LABEL[selCO.type]}</span>
              {selCO.invoiceRef&&<span className="bdg" style={{background:"#021f14",color:"#34d399",fontSize:9}}>{selCO.invoiceRef}</span>}
            </div>

            {/* Budget delta */}
            <div style={{background:"#070c18",borderRadius:8,padding:"12px 14px",marginBottom:14,border:"1px solid #1a2d45"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,textAlign:"center"}}>
                <div><div className="lbl">Original</div><div style={{fontSize:14,fontWeight:700,color:"#7dd3fc",fontFamily:"'DM Mono',monospace"}}>{fmt(selCO.originalBudget)}</div></div>
                <div><div className="lbl">Change</div><div style={{fontSize:14,fontWeight:700,color:selCO.changeAmount>=0?"#34d399":"#f87171",fontFamily:"'DM Mono',monospace"}}>{selCO.changeAmount>=0?"+":""}{fmt(selCO.changeAmount)}</div></div>
                <div><div className="lbl">New Total</div><div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",fontFamily:"'DM Mono',monospace"}}>{fmt(selCO.newBudget)}</div></div>
              </div>
              {selCO.originalEndDate!==selCO.newEndDate&&(
                <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #111d2d",display:"flex",justifyContent:"space-between",fontSize:11}}>
                  <span style={{color:"#475569"}}>End date: <b style={{color:"#f87171"}}>{selCO.originalEndDate}</b> → <b style={{color:"#34d399"}}>{selCO.newEndDate}</b></span>
                </div>
              )}
            </div>

            {/* Description */}
            <div className="lbl" style={{marginBottom:4}}>Description</div>
            <div style={{fontSize:11,color:"#64748b",lineHeight:1.5,marginBottom:14}}>{selCO.description}</div>

            {/* Key info */}
            {[
              ["Requested by",   selCO.requestedBy],
              ["Requested",      selCO.requestedAt?fmtDate(selCO.requestedAt):"—"],
              ["Submitted",      selCO.submittedAt?fmtDate(selCO.submittedAt):"—"],
              ["Client response",selCO.clientResponseAt?fmtDate(selCO.clientResponseAt):"Awaiting"],
              ["Approved by",    selCO.approvedBy||"—"],
              ["Client signed",  selCO.clientSignedBy||"—"],
              ["Addtl hours",    selCO.additionalHours?(selCO.additionalHours>0?"+":"")+selCO.additionalHours+"h":"—"],
              ["Affected team",  selCO.affectedRoster?.map(id=>roster?.find(r=>r.id===id)?.name?.split(" ")[0]||id).join(", ")||"—"],
            ].map(([l,v])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #070b14"}}>
                <span style={{fontSize:10,color:"#3d5a7a"}}>{l}</span>
                <span style={{fontSize:11,color:"#94a3b8"}}>{v}</span>
              </div>
            ))}

            {/* Internal notes */}
            {selCO.internalNotes&&<>
              <div className="lbl" style={{marginTop:12,marginBottom:4}}>Internal Notes</div>
              <div style={{fontSize:11,color:"#475569",background:"#070b14",borderRadius:6,padding:"8px 10px",lineHeight:1.4}}>{selCO.internalNotes}</div>
            </>}

            {/* Attachments */}
            {selCO.attachments?.length>0&&<>
              <div className="lbl" style={{marginTop:12,marginBottom:6}}>Attachments</div>
              {selCO.attachments.map(a=>(
                <div key={a} style={{fontSize:11,color:"#38bdf8",padding:"4px 8px",background:"#0c2340",borderRadius:4,marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
                  <span>📎</span>{a}
                </div>
              ))}
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── New Change Order Builder ───────────────────────────────────────────────────
function COBuilder({ projects, contracts, sows, roster, crmAccounts, onSave }) {
  const nextNum = "CO-00" + (CHANGE_ORDERS_SEED.length + 1 + Math.floor(Math.random()*3));
  const [step, setStep] = useState(0);
  const empty = {
    id:"co"+uid(), number:nextNum, projectId:"", contractId:"", sowId:"",
    title:"", description:"", type:"addition", status:"draft",
    originalBudget:0, changeAmount:0, newBudget:0,
    originalEndDate:"", newEndDate:"",
    requestedBy:"Manju", requestedAt:TODAY_STR,
    submittedAt:"", clientResponseAt:"",
    approvedBy:"", clientSignedBy:"",
    affectedRoster:[], additionalHours:0,
    internalNotes:"", attachments:[], invoiced:false, invoiceRef:"",
  };
  const [form, setForm] = useState({...empty});
  const sf = (k,v) => {
    setForm(f=>{
      const updated = {...f,[k]:v};
      if(k==="changeAmount"||k==="originalBudget") updated.newBudget = (+updated.originalBudget)+(+updated.changeAmount);
      if(k==="projectId") {
        const proj = projects?.find(p=>p.id===v);
        if(proj) { updated.originalBudget = proj.budget||0; updated.newBudget = proj.budget+(+f.changeAmount); }
      }
      return updated;
    });
  };
  const steps = ["Project & Contract","Scope & Amount","Team Impact","Review"];
  const proj = projects?.find(p=>p.id===form.projectId);

  const toggleRoster = (id) => sf("affectedRoster", form.affectedRoster.includes(id)?form.affectedRoster.filter(x=>x!==id):[...form.affectedRoster,id]);

  return (
    <div style={{maxWidth:720}}>
      {/* Progress */}
      <div style={{display:"flex",gap:0,marginBottom:24}}>
        {steps.map((s,i)=>(
          <div key={s} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <div style={{display:"flex",alignItems:"center",width:"100%",justifyContent:"center"}}>
              {i>0&&<div style={{flex:1,height:2,background:i<=step?"#0284c7":"#1a2d45"}}/>}
              <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0,
                background:i<step?"#034c8b":i===step?"linear-gradient(135deg,#0369a1,#0284c7)":"#0a1626",
                color:i<=step?"#fff":"#1e3a5f",border:`2px solid ${i<=step?"#0284c7":"#1a2d45"}`}}>
                {i<step?"✓":i+1}
              </div>
              {i<steps.length-1&&<div style={{flex:1,height:2,background:i<step?"#0284c7":"#1a2d45"}}/>}
            </div>
            <span style={{fontSize:10,color:i===step?"#38bdf8":"#3d5a7a",textAlign:"center"}}>{s}</span>
          </div>
        ))}
      </div>

      <div className="card" style={{padding:"22px 24px"}}>
        {step===0&&(
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:16}}>Project & Contract</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <FF label="CO Number"><input className="inp" value={form.number} onChange={e=>sf("number",e.target.value)}/></FF>
              <FF label="Type">
                <select className="inp" value={form.type} onChange={e=>sf("type",e.target.value)}>
                  {Object.entries(CO_TYPE_LABEL).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                </select>
              </FF>
              <FF label="Project" style={{gridColumn:"span 2"}}>
                <select className="inp" value={form.projectId} onChange={e=>sf("projectId",e.target.value)}>
                  <option value="">— Select project —</option>
                  {projects?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </FF>
              <FF label="Contract">
                <select className="inp" value={form.contractId} onChange={e=>sf("contractId",e.target.value)}>
                  <option value="">— Select contract —</option>
                  {contracts?.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </FF>
              <FF label="SOW">
                <select className="inp" value={form.sowId} onChange={e=>sf("sowId",e.target.value)}>
                  <option value="">— None / N/A —</option>
                  {sows?.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
              </FF>
              <FF label="Requested By"><input className="inp" value={form.requestedBy} onChange={e=>sf("requestedBy",e.target.value)} placeholder="Client PM name"/></FF>
              <FF label="Request Date"><input className="inp" type="date" value={form.requestedAt} onChange={e=>sf("requestedAt",e.target.value)}/></FF>
            </div>
          </div>
        )}

        {step===1&&(
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:16}}>Scope & Amount</div>
            <FF label="Change Order Title">
              <input className="inp" value={form.title} onChange={e=>sf("title",e.target.value)} placeholder="e.g. Sprint 2 Scope Expansion — Additional BRIM Configuration"/>
            </FF>
            <FF label="Description" style={{marginTop:12}}>
              <textarea className="inp" rows={4} value={form.description} onChange={e=>sf("description",e.target.value)} placeholder="Describe what changed, why, and what's included in this CO…"/>
            </FF>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginTop:14}}>
              <FF label="Original Budget ($)">
                <input className="inp" type="number" value={form.originalBudget} onChange={e=>sf("originalBudget",+e.target.value)}/>
              </FF>
              <FF label={form.type==="reduction"?"Reduction Amount ($)":"Change Amount ($)"}>
                <input className="inp" type="number" value={form.changeAmount} onChange={e=>sf("changeAmount",form.type==="reduction"?-Math.abs(+e.target.value):+e.target.value)}/>
              </FF>
              <FF label="New Budget (auto)">
                <div className="inp" style={{fontFamily:"'DM Mono',monospace",color:form.newBudget>=form.originalBudget?"#34d399":"#f87171",fontWeight:700,background:"#050910"}}>
                  {fmt(form.newBudget)}
                </div>
              </FF>
              <FF label="Original End Date"><input className="inp" type="date" value={form.originalEndDate} onChange={e=>sf("originalEndDate",e.target.value)}/></FF>
              <FF label="New End Date (if changed)"><input className="inp" type="date" value={form.newEndDate} onChange={e=>sf("newEndDate",e.target.value)}/></FF>
              <FF label="Additional Hours">
                <input className="inp" type="number" value={form.additionalHours} onChange={e=>sf("additionalHours",+e.target.value)} placeholder="0"/>
              </FF>
            </div>
          </div>
        )}

        {step===2&&(
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:6}}>Team Impact</div>
            <div style={{fontSize:11,color:"#475569",marginBottom:14}}>Select consultants affected by this change order. Their allocations may need updating in Project Tracker.</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:16}}>
              {roster?.map(r=>{
                const sel = form.affectedRoster.includes(r.id);
                return (
                  <div key={r.id}
                    onClick={()=>toggleRoster(r.id)}
                    style={{padding:"10px 14px",borderRadius:8,border:`1px solid ${sel?"#0284c7":"#1a2d45"}`,
                      background:sel?"#0c2340":"#070b14",cursor:"pointer",display:"flex",alignItems:"center",gap:10,transition:"all 0.15s"}}>
                    <div style={{width:10,height:10,borderRadius:"50%",border:`2px solid ${sel?"#38bdf8":"#1a2d45"}`,background:sel?"#38bdf8":"transparent",flexShrink:0}}/>
                    <div>
                      <div style={{fontSize:12,fontWeight:600,color:sel?"#e2e8f0":"#64748b"}}>{r.name}</div>
                      <div style={{fontSize:10,color:"#3d5a7a"}}>{r.role} · ${r.billRate}/hr</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <FF label="Internal Notes">
              <textarea className="inp" rows={3} value={form.internalNotes} onChange={e=>sf("internalNotes",e.target.value)} placeholder="Notes for internal reference — not shared with client…"/>
            </FF>
          </div>
        )}

        {step===3&&(
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:16}}>Review & Create</div>
            <div style={{background:"#070c18",borderRadius:8,padding:"16px 18px",border:"1px solid #1a2d45",marginBottom:14}}>
              <div style={{fontSize:16,fontWeight:700,color:"#e2e8f0",marginBottom:4}}>{form.number} — {form.title||"(no title)"}</div>
              <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                <span className="bdg" style={{background:CO_TYPE_COLOR[form.type]+"22",color:CO_TYPE_COLOR[form.type]}}>{CO_TYPE_LABEL[form.type]}</span>
                <span className="bdg" style={{background:"#0a1626",color:"#475569"}}>Draft</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
                <div><div className="lbl">Original</div><div style={{fontSize:14,fontWeight:700,color:"#7dd3fc",fontFamily:"'DM Mono',monospace"}}>{fmt(form.originalBudget)}</div></div>
                <div><div className="lbl">Change</div><div style={{fontSize:14,fontWeight:700,color:form.changeAmount>=0?"#34d399":"#f87171",fontFamily:"'DM Mono',monospace"}}>{form.changeAmount>=0?"+":""}{fmt(form.changeAmount)}</div></div>
                <div><div className="lbl">New Budget</div><div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",fontFamily:"'DM Mono',monospace"}}>{fmt(form.newBudget)}</div></div>
              </div>
              <div style={{fontSize:11,color:"#64748b",lineHeight:1.4}}>{form.description||"(no description)"}</div>
            </div>
            {form.affectedRoster.length>0&&(
              <div style={{marginBottom:12}}>
                <div className="lbl" style={{marginBottom:4}}>Affected Consultants</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {form.affectedRoster.map(id=>{
                    const r = roster?.find(x=>x.id===id);
                    return <span key={id} className="bdg" style={{background:"#0c2340",color:"#38bdf8"}}>{r?.name}</span>;
                  })}
                </div>
              </div>
            )}
            <div className="lbl" style={{marginBottom:4}}>Next step: Submit to client after saving as Draft</div>
          </div>
        )}

        {/* Nav */}
        <div style={{display:"flex",gap:10,justifyContent:"space-between",marginTop:20}}>
          <button className="btn bg" onClick={()=>setStep(s=>Math.max(0,s-1))} style={{visibility:step===0?"hidden":"visible"}}>← Back</button>
          {step<steps.length-1
            ? <button className="btn bp" onClick={()=>setStep(s=>s+1)}>Next →</button>
            : <button className="btn bs" onClick={()=>onSave({...form})}><I d={ICONS.check} s={13}/>Create Change Order</button>
          }
        </div>
      </div>
    </div>
  );
}

// ── Budget Impact Analysis ────────────────────────────────────────────────────
function COImpact({ changeOrders, projects, roster }) {
  const [selectedProj, setSelectedProj] = useState("all");

  const projsWithCOs = projects?.filter(p=>changeOrders.some(c=>c.projectId===p.id))||[];

  const getImpact = (projId) => {
    const cos = projId==="all" ? changeOrders : changeOrders.filter(c=>c.projectId===projId);
    const proj = projId!=="all" ? projects?.find(p=>p.id===projId) : null;
    const approved  = cos.filter(c=>c.status==="approved");
    const pending   = cos.filter(c=>c.status==="pending");
    const net       = approved.reduce((s,c)=>s+c.changeAmount,0);
    const pendingNet= pending.reduce((s,c)=>s+c.changeAmount,0);
    const origBudget= projId==="all" ? projects?.reduce((s,p)=>s+(p.budget||0),0)||0 : proj?.budget||0;
    return { cos, approved, pending, net, pendingNet, origBudget, newBudget:origBudget+net };
  };

  const impact = getImpact(selectedProj);

  // Timeline — changes ordered by date
  const timeline = [...changeOrders]
    .filter(c=>selectedProj==="all"||c.projectId===selectedProj)
    .filter(c=>["approved","pending"].includes(c.status))
    .sort((a,b)=>(a.requestedAt||"").localeCompare(b.requestedAt||""));

  let running = impact.origBudget;
  const timelineWithRunning = timeline.map(co=>{
    if(co.status==="approved") running += co.changeAmount;
    return {...co, runningTotal:running};
  });

  return (
    <div>
      {/* Project filter */}
      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        <button className="btn bg" style={{fontSize:11,borderColor:selectedProj==="all"?"#0284c7":"#1a2d45",color:selectedProj==="all"?"#38bdf8":"#475569"}}
          onClick={()=>setSelectedProj("all")}>All Projects</button>
        {projsWithCOs.map(p=>(
          <button key={p.id} className="btn bg" style={{fontSize:11,borderColor:selectedProj===p.id?"#0284c7":"#1a2d45",color:selectedProj===p.id?"#38bdf8":"#475569"}}
            onClick={()=>setSelectedProj(p.id)}>{p.name.slice(0,20)}</button>
        ))}
      </div>

      {/* Impact summary */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16}}>
        {[
          {l:"Original Budget",    v:fmt(impact.origBudget),              c:"#7dd3fc"},
          {l:"Approved Changes",   v:(impact.net>=0?"+":"")+fmt(impact.net),c:impact.net>=0?"#34d399":"#f87171"},
          {l:"Current Budget",     v:fmt(impact.newBudget),               c:"#e2e8f0"},
          {l:"Pending (if approved)",v:(impact.pendingNet>=0?"+":"")+fmt(impact.pendingNet),c:"#f59e0b"},
        ].map(k=>(
          <div key={k.l} className="card" style={{padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:800,color:k.c,fontFamily:"'DM Mono',monospace"}}>{k.v}</div>
            <div style={{fontSize:10,color:"#475569",marginTop:2}}>{k.l}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* Running budget chart */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div className="section-hdr">Budget Evolution</div>
          {timelineWithRunning.length===0&&<div style={{fontSize:11,color:"#1e3a5f",padding:"12px 0"}}>No approved changes yet for this filter.</div>}
          {timelineWithRunning.length>0&&(
            <div>
              {/* Baseline */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0a1626"}}>
                <span style={{fontSize:11,color:"#475569"}}>Baseline budget</span>
                <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"#7dd3fc",fontWeight:700}}>{fmt(impact.origBudget)}</span>
              </div>
              {timelineWithRunning.map((co,i)=>(
                <div key={co.id} style={{padding:"8px 0",borderBottom:"1px solid #0a1626"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:3}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>{co.number} — {co.title.slice(0,35)}</div>
                      <div style={{fontSize:9,color:"#3d5a7a"}}>{co.requestedAt} · {CO_TYPE_LABEL[co.type]}</div>
                    </div>
                    <div style={{textAlign:"right",marginLeft:12}}>
                      <div style={{fontSize:12,fontWeight:700,fontFamily:"'DM Mono',monospace",color:co.changeAmount>=0?"#34d399":"#f87171"}}>
                        {co.changeAmount>=0?"+":""}{fmt(co.changeAmount)}
                      </div>
                      {co.status==="approved"&&<div style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:"#e2e8f0"}}>{fmt(co.runningTotal)}</div>}
                      {co.status==="pending"&&<div style={{fontSize:9,color:"#f59e0b"}}>pending</div>}
                    </div>
                  </div>
                  {/* Bar */}
                  {co.status==="approved"&&(
                    <div style={{height:4,background:"#0a1626",borderRadius:2,overflow:"hidden"}}>
                      <div style={{height:4,background:"#0284c7",borderRadius:2,width:`${Math.min(100,(co.runningTotal/Math.max(impact.newBudget,impact.origBudget))*100)}%`,transition:"width 0.4s"}}/>
                    </div>
                  )}
                </div>
              ))}
              {/* Final */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",marginTop:4}}>
                <span style={{fontSize:12,fontWeight:700,color:"#e2e8f0"}}>Current approved budget</span>
                <span style={{fontSize:14,fontFamily:"'DM Mono',monospace",color:"#38bdf8",fontWeight:800}}>{fmt(impact.newBudget)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Consultant cost impact */}
        <div className="card" style={{padding:"18px 20px"}}>
          <div className="section-hdr">Hours Impact by Consultant</div>
          {(() => {
            const coList = selectedProj==="all" ? changeOrders : changeOrders.filter(c=>c.projectId===selectedProj);
            const approvedCOs = coList.filter(c=>c.status==="approved");
            // Aggregate additional hours per consultant
            const hourMap = {};
            approvedCOs.forEach(co=>{
              if(!co.affectedRoster?.length) return;
              const hrsEach = Math.round((co.additionalHours||0)/co.affectedRoster.length);
              co.affectedRoster.forEach(rid=>{ hourMap[rid]=(hourMap[rid]||0)+hrsEach; });
            });
            const entries = Object.entries(hourMap);
            if(entries.length===0) return <div style={{fontSize:11,color:"#1e3a5f",padding:"12px 0"}}>No consultant impacts recorded yet.</div>;
            return entries.map(([rid,hrs])=>{
              const r = roster?.find(x=>x.id===rid);
              const rev = hrs*(r?.billRate||0);
              return (
                <div key={rid} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0a1626"}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:600,color:"#cbd5e1"}}>{r?.name||rid}</div>
                    <div style={{fontSize:10,color:"#3d5a7a"}}>{r?.role} · ${r?.billRate}/hr</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:12,fontWeight:700,color:hrs>=0?"#34d399":"#f87171"}}>{hrs>=0?"+":""}{hrs}h</div>
                    <div style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:"#7dd3fc"}}>{hrs>=0?"+":""}{fmt(rev)}</div>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENDOR / AP MODULE

