<script lang="ts">
  import { t, appData, session, persistSession } from "./store";
  import { nf, calcBMR } from './calc';
  import { buildTimeline, sundayRule, APPORT_FLOOR } from './engine';
  import { saveAppState, refreshToken } from "./supabase";
  import { get } from "svelte/store";
  import FoodModal from "./FoodModal.svelte";

  const MOIS: Record<string, number> = {
    janvier:0, février:1, fevrier:1, mars:2, avril:3, mai:4, juin:5,
    juillet:6, août:7, aout:7, septembre:8, octobre:9, novembre:10, décembre:11, decembre:11
  };

  function parseJour(str: string): Date | null {
    if (!str) return null;
    if (str.includes('/')) {
      const [d, m, y] = str.split('/');
      return new Date(+y, +m - 1, +d);
    }
    const parts = str.trim().toLowerCase().split(/\s+/);
    const dayNum = parts.find(p => /^\d+$/.test(p));
    const monthStr = parts.find(p => MOIS[p] !== undefined);
    if (!dayNum || !monthStr) return null;
    return new Date(2026, MOIS[monthStr], +dayNum);
  }

  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const todayKey = todayDate.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const nowD = new Date();
  const dayFrac = Math.min(1, (nowD.getHours() * 60 + nowD.getMinutes()) / (24 * 60));
  const heureLabel = nowD.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const prog = $derived(($appData as any)?.programme ?? {});
  const progJours = $derived(prog?.jours ?? []);
  const avgMacros = $derived.by(() => {
    const jours: any[] = progJours;
    const j1 = jours.length ? parseJour(jours[0].jour) : null;
    if (j1) j1.setHours(0, 0, 0, 0);
    let sp = 0, sg = 0, sl = 0, n = 0;
    Object.entries((days as any) ?? {}).forEach(([k, d]: [string, any]) => {
      const fds = d?.foods ?? [];
      if (!fds.length) return;
      const parts = k.split('/').map(Number);
      if (parts.length !== 3) return;
      const t = new Date(parts[2], parts[1]-1, parts[0]);
      if (j1 && t < j1) return; // avant le 1er jour de regime
      if (t > todayDate) return;
      sp += fds.reduce((s: number, f: any) => s + (f.p||0), 0);
      sg += fds.reduce((s: number, f: any) => s + (f.g||0), 0);
      sl += fds.reduce((s: number, f: any) => s + (f.l||0), 0);
      n++;
    });
    if (!n) return null;
    return { p: Math.round(sp / n), g: Math.round(sg / n), l: Math.round(sl / n), n };
  });
  const days = $derived(($appData as any)?.days ?? {});
  const today = $derived(days[todayKey] ?? {});
  const foods = $derived(today?.foods ?? []);

  // ── v11 : moteur de dépense mesurée (base datée + dynamique + adaptation) ──
  const settingsLog = $derived.by(() => {
    const log = ($appData as any)?.programme?.settingsLog;
    if (Array.isArray(log) && log.length) return log;
    const j1 = progJours.length ? parseJour(progJours[0].jour) : null;
    const from = j1 ? j1.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) : '16/06/2026';
    return [{ from, baseRef: 2020, poidsRef: 97.92, adaptCoef: 0.12 }];
  });
  const timeline = $derived.by(() => {
    const acts = (prog?.activites ?? {}) as Record<string, number>;
    const jByDs: any = {}; const dateList: any[] = [];
    for (const j of progJours) {
      const jd = parseJour(j.jour); if (!jd) continue; jd.setHours(0,0,0,0);
      const ds = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      jByDs[ds] = j; dateList.push({ ds, t: jd.getTime() });
    }
    dateList.sort((a: any,b: any)=>a.t-b.t);
    const info = (ds: string) => {
      const dd = (days as any)[ds] ?? {}; const j = jByDs[ds];
      const fds = dd.foods ?? [];
      const act = j ? actOf(j, ds) : '';
      const sportKcal = (act && act !== 'Libre') ? (acts[act] ?? 0) : 0;
      return {
        weight: nf(dd.weight), bf: nf(dd.bf),
        eaten: fds.reduce((s: number,f: any)=>s+(f.k||0),0),
        gluc: fds.reduce((s: number,f: any)=>s+(f.g||0),0),
        prot: fds.reduce((s: number,f: any)=>s+(f.p||0),0),
        extraKcal: dd.extraKcal ?? 0, sportKcal, libre: act === 'Libre', logged: fds.length>0,
      };
    };
    return buildTimeline({ dateList, settingsLog, todayTime: todayDate.getTime(), dayFrac, info });
  });
  const todayRec = $derived((timeline.byKey as any)[todayKey] ?? null);
  const sundaySug = $derived(sundayRule(timeline, todayDate.getTime()));

  const macros = $derived(foods.reduce(
    (acc: any, f: any) => ({ k: acc.k+(f.k||0), p: acc.p+(f.p||0), g: acc.g+(f.g||0), l: acc.l+(f.l||0) }),
    { k:0, p:0, g:0, l:0 }
  ));

  const progIdx = $derived(progJours.findIndex((j: any) => {
    const d = parseJour(j.jour);
    if (!d) return false;
    d.setHours(0, 0, 0, 0);
    return d.getTime() === todayDate.getTime();
  }));

  const progDay = $derived(progIdx >= 0 ? progJours[progIdx] : null);
  const tdeeToday = $derived(todayRec ? Math.round(todayRec.base + todayRec.sportK) : 0);
  const tBrulees = $derived(tdeeToday);
  const tIntake = $derived(todayRec
    ? (todayRec.libre ? Math.round(todayRec.base + todayRec.sportK)
       : Math.round(Math.max(APPORT_FLOOR, (todayRec.base + todayRec.sportK) * 0.75)))
    : 1850);
  const deficit = $derived(Math.round(macros.k) - tBrulees);
  const mCible = $derived.by(() => {
    const w = parseFloat(String(($appData as any)?.profile?.weight ?? '').replace(',', '.')) || 100;
    const bf = parseFloat(String(($appData as any)?.profile?.bf ?? '').replace(',', '.')) || 0;
    const lean = bf > 0 ? w * (1 - bf / 100) : w * 0.75; // masse maigre
    const kcal = tIntake > 0 ? tIntake : 1850; // repli si pas de cible du jour
    const p = Math.round(2.2 * lean); // 2,2 g/kg de masse maigre (anti-fonte, contexte cortisone)
    const l = Math.round(0.6 * w);
    const g = Math.max(0, Math.round((kcal - p * 4 - l * 9) / 4));
    return { p, g, l };
  });

  const totalDays = $derived(progJours.length);
  const dayNum = $derived(progIdx >= 0 ? progIdx + 1 : null);
  // ── Progression reelle : kcal reellement brulees / total a bruler jusqu'a la fin ──
  const profile = $derived(($appData as any)?.profile ?? {});
  const activites = $derived((prog?.activites ?? {}) as Record<string, number>);
  const nfp = nf;
  const bmrOf = calcBMR;
  function actOf(j: any, ds: string): string {
    if (typeof j?.activity === 'string') return j.activity;
    const d = (days as any)[ds];
    if (d?.progActivity === false) return '';
    if (d?.progActivity?.name) return d.progActivity.name;
    const t = j.type ?? '';
    return /libre/i.test(t) ? 'Libre' : t;
  }
  const progStats = $derived.by(() => {
    const w = nfp(profile.weight) || 100;
    const pTargetDay = 1.6 * w;
    let totalCible = 0, realBrule = 0, expectedSoFar = 0;
    let fatKcal = 0, leanKcalDef = 0, defKcalPos = 0, protEaten = 0, protTarget = 0, protShortfall = 0;
    for (const r of (timeline as any).list) {
      const dayExp = r.base + r.sportK; // dépense pleine du jour
      const cible = r.libre ? 0 : Math.max(0, Math.round(Math.min(dayExp * 0.25, dayExp - APPORT_FLOOR)));
      totalCible += cible;
      if (r.deficit == null) continue;
      realBrule += r.deficit;
      expectedSoFar += r.isToday ? cible * dayFrac : cible;
      const def = r.deficit;
      if (def > 0) {
        const ratio = pTargetDay > 0 ? Math.max(0, Math.min(1, r.prot / pTargetDay)) : 1;
        const fatFrac = 0.70 + 0.20 * ratio;
        fatKcal += def * fatFrac; leanKcalDef += def * (1 - fatFrac); defKcalPos += def;
        protEaten += r.prot; protTarget += pTargetDay; protShortfall += Math.max(0, pTargetDay - r.prot);
      } else {
        fatKcal += def * 0.85;
      }
    }
    fatKcal = Math.max(0, fatKcal);
    const fatShare = (fatKcal + leanKcalDef) > 0 ? fatKcal / (fatKcal + leanKcalDef) : 0.9;
    const protPct = protTarget > 0 ? protEaten / protTarget : 1;
    return { totalCible, realBrule, expectedSoFar, fatKcal, leanKcalDef, fatShare, protPct, defKcalPos, protShortfall };
  });
  const progressPct = $derived(progStats.totalCible > 0
    ? Math.max(0, Math.min(100, Math.round(progStats.realBrule / progStats.totalCible * 100)))
    : 0);

  // Estimation MG perdue (meilleur cas : suppose assez de proteines pour preserver le muscle)
  function fmtG(g: number): string {
    return g >= 1000 ? (g / 1000).toFixed(2).replace('.', ',') + ' kg' : Math.round(g) + ' g';
  }
  const fatLost = $derived.by(() => {
    // ancré sur les pesées MESURÉES (poids + %MG saisis) : vérité, pas modèle
    const meas: any[] = [];
    for (const k of Object.keys(days as any)) {
      const d: any = (days as any)[k]; const w = nfp(d?.weight), bf = nfp(d?.bf);
      if (w > 0 && bf > 0) { const pr = k.split('/').map(Number); if (pr.length === 3) meas.push({ t: new Date(pr[2], pr[1]-1, pr[0]).getTime(), w, bf, fat: w * bf / 100 }); }
    }
    meas.sort((a, b) => a.t - b.t);
    if (meas.length < 1) return null;
    const start = meas[0], now = meas[meas.length - 1];
    const fatLostKg = Math.max(0, start.fat - now.fat);
    const leanLostKg = Math.max(0, (start.w - now.w) - (start.fat - now.fat));
    const ratio = Math.max(0, Math.min(1, progStats.protPct));
    let muscleKg = leanLostKg * (0.20 + 0.40 * (1 - ratio));
    let waterKg = leanLostKg - muscleKg;
    if (waterKg > 1.75) { muscleKg += waterKg - 1.75; waterKg = 1.75; }
    return {
      g: Math.round(fatLostKg * 1000), leanG: Math.round(leanLostKg * 1000),
      realMuscleG: Math.round(muscleKg * 1000), waterG: Math.round(waterKg * 1000),
      bf: +start.bf.toFixed(1), bfNow: +now.bf.toFixed(1),
      startW: start.w, nowW: now.w, startFat: start.fat, nowFat: now.fat,
    };
  });
  // Parse tolerant a la virgule + deficit EFFECTIF : reel (mange-depense) pour les jours passes loggés, cible sinon
  function effDeficit(j: any): number {
    const jd = parseJour(j.jour); if (!jd) return j.deficit || 0;
    const key = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
    const dd = (days as any)[key] ?? {};
    const eaten = (dd.foods ?? []).reduce((a: number, f: any) => a + (f.k||0), 0);
    const jd0 = new Date(jd); jd0.setHours(0,0,0,0);
    if (jd0 < todayDate && eaten > 0) {
      const exp = (j.calories_brulees ?? 0) + (dd.extraKcal ?? 0);
      return exp - eaten; // deficit reellement realise (signe)
    }
    return j.deficit || 0; // jour futur / non loggé : cible planifiee
  }

  const bfProjected = $derived.by(() => {
    const p = ($appData as any)?.profile;
    if (!p) return null;
    const w = nf(p.weight);
    const bf = nf(p.bf);
    if (!w || !bf) return null;
    const totalDef = progJours.reduce((s: number, j: any) => s + effDeficit(j), 0);
    if (!totalDef) return null;
    const kgLost = totalDef / 7700;
    const fatInit = w * bf / 100;
    const fatFinal = Math.max(0, fatInit - kgLost);
    const wFinal = w - kgLost;
    return wFinal > 0 ? +((fatFinal / wFinal) * 100).toFixed(1) : null;
  });

  const cumul = $derived(progJours.reduce((acc: number, j: any, idx: number) => {
    if (idx >= Math.max(0, progIdx)) return acc;
    const jd = parseJour(j.jour);
    if (!jd) return acc;
    const key = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
    const dayData = days[key] ?? {};
    const eaten = (dayData.foods ?? []).reduce((s: number, f: any) => s + (f.k||0), 0);
    if (!eaten) return acc;
    const exp = (j.calories_brulees ?? 0) + (dayData.extraKcal ?? 0);
    return acc + (eaten - exp);
  }, 0));

  // Sum of programme deficits for past logged days (what the plan expected)
  const expectedDeficit = $derived(progJours.reduce((acc: number, j: any, idx: number) => {
    if (idx >= Math.max(0, progIdx)) return acc;
    const jd = parseJour(j.jour);
    if (!jd) return acc;
    const key = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
    const dayData = (days as any)[key] ?? {};
    const eaten = (dayData.foods ?? []).reduce((s: number, f: any) => s + (f.k||0), 0);
    if (!eaten) return acc; // only count days with food logged
    return acc + (j.deficit ?? 0);
  }, 0));

  // retard = how many kcal short of the plan (positive = behind, negative = ahead)
  const retard = $derived(Math.round(progStats.expectedSoFar - progStats.realBrule));
  // Cumul reel = identique a la barre (deficit live, J1, jour en cours au prorata)
  const cumulReal = $derived(-Math.round(progStats.realBrule));

  const recentDays = $derived(() => {
    const result: any[] = [];
    // plancher : premier jour effectivement loggé (on ne remonte pas avant)
    let floorTime = Infinity;
    for (const k of Object.keys(days)) {
      if (!(days as any)[k]?.foods?.length) continue;
      const parts = k.split('/').map(Number);
      if (parts.length === 3) {
        const t = new Date(parts[2], parts[1]-1, parts[0]).getTime();
        if (t < floorTime) floorTime = t;
      }
    }
    // plancher J1 : on ne montre rien avant le premier jour du programme
    const j1 = progJours.length ? parseJour(progJours[0].jour) : null;
    const j1Time = j1 ? j1.getTime() : -Infinity;
    for (let i = 1; i <= 366; i++) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - i);
      if (d.getTime() < j1Time) break; // avant le J1 du programme
      const key = d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      const dayData = (days as any)[key];
      const hasFood = !!dayData?.foods?.length;
      const within7 = i <= 7 && d.getTime() >= floorTime;
      // on garde les 7 derniers jours (>= 1er jour loggé) meme vides, + tout jour loggé au-dela
      if (!hasFood && !within7) continue;
      const foods = dayData?.foods ?? [];
      const total = (foods as any[]).reduce((s: number, f: any) => s + (f.k||0), 0);
      const label = d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' });
      const jIdx = progJours.findIndex((j: any) => {
        const pd = parseJour(j.jour);
        if (!pd) return false;
        return pd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) === key;
      });
      const jd = jIdx >= 0 ? progJours[jIdx] : null;
      const jNum = jIdx >= 0 ? jIdx + 1 : null;
      const cible = jd?.calories ?? 0;
      const extraKcal = dayData?.extraKcal ?? 0;
      const sp = (foods as any[]).reduce((s: number, f: any) => s + (f.p||0), 0);
      const sg = (foods as any[]).reduce((s: number, f: any) => s + (f.g||0), 0);
      const sl = (foods as any[]).reduce((s: number, f: any) => s + (f.l||0), 0);
      // deficit reel du jour = depense - mange
      const rec = (timeline.byKey as any)[key];
      const expend = rec ? rec.exp : 0;
      const adaptation = rec ? rec.adaptation : 0;
      const deficit = hasFood ? (rec ? rec.deficit : null) : null; // null si rien loggé
      const neutre = deficit !== null && Math.abs(deficit) <= 50; // neutre = mange ~ depense
      // detail des grammes perdus/pris ce jour (meme modele que les cellules kg perdus)
      // signe : negatif = perdu, positif = pris
      let gMuscle: number | null = null, gFat: number | null = null, gWater: number | null = null;
      if (deficit !== null) {
        if (deficit > 0) {
          // perte : part gras (proteines) + part masse maigre (muscle vs eau)
          const pTargetDay = 1.6 * (nfp(profile.weight) || 100);
          const ratio = pTargetDay > 0 ? Math.max(0, Math.min(1, sp / pTargetDay)) : 1;
          const fatFrac = 0.70 + 0.20 * ratio;
          const leanG = deficit * (1 - fatFrac) / 1850 * 1000;
          const muscleFrac = 0.20 + 0.40 * (1 - ratio);
          gFat = -Math.round(deficit * fatFrac / 7700 * 1000);
          gMuscle = -Math.round(leanG * muscleFrac);
          gWater = -Math.round(leanG * (1 - muscleFrac));
        } else {
          // prise : le durable = gras. L'eau/glycogene est transitoire, on ne la compte pas.
          gFat = Math.round(-deficit / 7700 * 1000);
          gWater = 0;
          gMuscle = 0;
        }
      }
      result.push({ key, label, jNum, foods, total, cible, expend, adaptation, extraKcal, p: sp, g: sg, l: sl, deficit, neutre, gMuscle, gFat, gWater });
    }
    return result;
  });


  function pct(a: number, b: number) { return b > 0 ? Math.min(100, Math.round(a/b*100)) : 0; }
  function fmt(n: number) { return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('fr'); }

  const BUILD = "V11.4";
  const dateLabel = $derived((() => { const s = todayDate.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' }); return s.charAt(0).toUpperCase() + s.slice(1); })());

  let showModal = $state(false);
  let modalDayKey = $state(todayKey);

  function openModal(key: string) { modalDayKey = key; showModal = true; }

  async function saveExtraKcal(val: string, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const kcal = parseInt(val) || 0;
    const dayData = data.days?.[dayKey] ?? {};
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, extraKcal: kcal } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  async function saveWeight(val: string, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const w = parseFloat(String(val).replace(',', '.')) || 0;
    const dayData = data.days?.[dayKey] ?? {};
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, weight: w || undefined } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  async function saveBf(val: string, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const bf = parseFloat(String(val).replace(',', '.')) || 0;
    const dayData = data.days?.[dayKey] ?? {};
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, bf: bf || undefined } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  // ---- Graphe de poids : points saisis + moyenne glissante 7 jours ----
  const weightSeries = $derived.by(() => {
    const entries: { t: number; w: number }[] = [];
    Object.entries((days as any) ?? {}).forEach(([k, d]: [string, any]) => {
      const w = nf(d?.weight);
      if (!w) return;
      const parts = k.split('/').map(Number);
      if (parts.length !== 3) return;
      entries.push({ t: new Date(parts[2], parts[1]-1, parts[0]).getTime(), w });
    });
    entries.sort((a, b) => a.t - b.t);
    if (entries.length < 2) return null;
    // moyenne glissante 7 jours (fenêtre calendaire)
    const avg = entries.map((e) => {
      const win = entries.filter((x) => e.t - x.t >= 0 && e.t - x.t < 7 * 86400000);
      return { t: e.t, w: win.reduce((s, x) => s + x.w, 0) / win.length };
    });
    const all = entries.map(e => e.w).concat(avg.map(a => a.w));
    const min = Math.min(...all), max = Math.max(...all);
    const pad = Math.max(0.4, (max - min) * 0.15);
    const lo = min - pad, hi = max + pad;
    const t0 = entries[0].t, t1 = entries[entries.length - 1].t || t0 + 1;
    const X = (t: number) => t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 300;
    const Y = (w: number) => 80 - ((w - lo) / (hi - lo)) * 80;
    const pts = entries.map(e => `${X(e.t).toFixed(1)},${Y(e.w).toFixed(1)}`).join(' ');
    const avgPts = avg.map(a => `${X(a.t).toFixed(1)},${Y(a.w).toFixed(1)}`).join(' ');
    const last = entries[entries.length - 1];
    const lastAvg = avg[avg.length - 1];
    const delta = +(last.w - entries[0].w).toFixed(1);
    // serie masse grasse (echelle propre, superposee)
    const bfE: { t: number; v: number }[] = [];
    Object.entries((days as any) ?? {}).forEach(([k, d]: [string, any]) => {
      const v = nf(d?.bf);
      if (!v) return;
      const parts = k.split('/').map(Number);
      if (parts.length !== 3) return;
      bfE.push({ t: new Date(parts[2], parts[1]-1, parts[0]).getTime(), v });
    });
    bfE.sort((a, b) => a.t - b.t);
    let bfPts = '', lastBf = 0;
    if (bfE.length >= 2) {
      const bmin = Math.min(...bfE.map(e => e.v)), bmax = Math.max(...bfE.map(e => e.v));
      const bpad = Math.max(0.3, (bmax - bmin) * 0.15);
      const blo = bmin - bpad, bhi = bmax + bpad;
      const YB = (v: number) => 80 - ((v - blo) / (bhi - blo)) * 80;
      bfPts = bfE.map(e => `${X(e.t).toFixed(1)},${YB(e.v).toFixed(1)}`).join(' ');
      lastBf = bfE[bfE.length - 1].v;
    } else if (bfE.length === 1) {
      lastBf = bfE[0].v;
    }
    return { pts, avgPts, last: last.w, lastAvg: +lastAvg.w.toFixed(1), delta, n: entries.length,
             lastX: X(last.t).toFixed(1), lastY: Y(last.w).toFixed(1), bfPts, lastBf };
  });

  const SUPPS = [
    { key: 'folic', label: 'Folic Expert' },
    { key: 'omega3', label: 'Oméga 3' },
    { key: 'b12', label: 'B12' },
    { key: 'mag1', label: 'Magnésium 1' },
    { key: 'mag2', label: 'Magnésium 2' },
    { key: 'curcumine', label: 'Curcumine' },
    { key: 'coq10', label: 'CoQ10' },
    { key: 'vitc', label: 'Vitamine C' },
  ];
  async function toggleSupp(key: string) {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data) return;
    const dayData = data.days?.[todayKey] ?? {};
    const supps = { ...(dayData.supps ?? {}) };
    supps[key] = !supps[key];
    const newData = { ...data, days: { ...data.days, [todayKey]: { ...dayData, supps } } };
    appData.set(newData);
    let token = s.access_token;
    try { const fresh = await refreshToken(s.refresh_token); token = fresh.access_token; } catch {}
    await saveAppState(token, s.user.id, newData);
  }

  async function removeFood(idx: number, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const dayData = data.days?.[dayKey] ?? {};
    const newFoods = [...(dayData.foods ?? [])];
    newFoods.splice(idx, 1);
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, foods: newFoods } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  const SUPABASE_URL = 'https://arydsxswhbgpfayjgtak.supabase.co';
  let coachLoading = $state(false);
  let coachText = $state('');
  let coachError = $state('');

  function buildCoachSummary() {
    const p = profile as any;
    const bft = nfp(p.bft) || 20;
    // état mesuré actuel (dernière pesée) + départ
    const meas: any[] = [];
    for (const k of Object.keys(days as any)) {
      const d: any = (days as any)[k]; const w = nfp(d?.weight), bf = nfp(d?.bf);
      if (w > 0 && bf > 0) { const pr = k.split('/').map(Number); if (pr.length === 3) meas.push({ t: new Date(pr[2], pr[1]-1, pr[0]).getTime(), w, bf }); }
    }
    meas.sort((a, b) => a.t - b.t);
    const nowM = meas.length ? meas[meas.length - 1] : null;
    const curW = nowM ? nowM.w : nfp(p.weight);
    const curBf = nowM ? nowM.bf : nfp(p.bf);
    const loggedDays = (timeline as any).list.filter((r: any) => r.logged && !r.isFuture).length;
    const cumulReel = Math.round(progStats.realBrule);
    const avgDef = loggedDays ? Math.round(cumulReel / loggedDays) : 0;
    const lean = curW * (1 - curBf / 100);
    const targetW = bft > 0 ? lean / (1 - bft / 100) : curW;
    const kgFatToLose = Math.max(0, curW - targetW);
    const kcalToLose = Math.round(kgFatToLose * 7700);
    const joursEstimes = avgDef > 0 ? Math.round(kcalToLose / avgDef) : null;
    const avg = avgMacros;
    const lastJ = progJours.length ? progJours[progJours.length - 1] : null;
    const y = todayDate.getFullYear(), m = String(todayDate.getMonth()+1).padStart(2,'0'), d2 = String(todayDate.getDate()).padStart(2,'0');
    return {
      date_aujourdhui: `${y}-${m}-${d2}`,
      profil: { sexe: p.sex, age: nfp(p.age), taille_cm: nfp(p.height) },
      etat_actuel_mesure: { poids_kg: +curW.toFixed(1), masse_grasse_pct: +curBf.toFixed(1) },
      objectif: { masse_grasse_cible_pct: bft, kg_gras_a_perdre: +kgFatToLose.toFixed(1), date_fin_programme: lastJ?.jour ?? null },
      progression: {
        jours_logges: loggedDays,
        deficit_cumule_reel_kcal: cumulReel,
        deficit_moyen_par_jour_kcal: avgDef,
        jours_estimes_pour_objectif: joursEstimes,
      },
      macros_moyennes_par_jour: avg ? { proteines_g: avg.p, glucides_g: avg.g, lipides_g: avg.l } : null,
      cible_proteines_g: Math.round(2.2 * lean),
    };
  }

  async function runCoach() {
    coachLoading = true; coachText = ''; coachError = '';
    try {
      const s = get(session);
      let token = s?.access_token ?? '';
      try {
        const fresh = await refreshToken(s!.refresh_token);
        persistSession(fresh);
        token = fresh.access_token;
      } catch {}
      const r = await fetch(`${SUPABASE_URL}/functions/v1/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ summary: buildCoachSummary() }),
      });
      const d = await r.json();
      if (d.text) coachText = d.text;
      else coachError = d.error ?? 'Erreur coach';
    } catch { coachError = 'Erreur réseau'; }
    coachLoading = false;
  }


</script>

<div class="scroll-area">
  <div class="header">
    <div>
      <div class="label">{$t.dashboard.today}</div>
      <div class="date">{dateLabel} <span class="heure-tag">{heureLabel}</span><span class="build-tag">{BUILD}</span></div>
    </div>
    <div class="app-title">FitPro<span class="x">X</span></div>
  </div>

  {#if totalDays > 0}
  <div class="card progress-card">
    <div class="prog-top">
      <span class="label">{$t.dashboard.progress}{#if dayNum} · J{dayNum} / J{totalDays}{/if}</span>
      <span class="badge-accent">{progressPct}%</span>
    </div>
    <div class="progress-bar" style="margin-top:10px">
      <div class="progress-fill" style="width:{progressPct}%"></div>
    </div>
    <div class="caption" style="margin-top:6px">{Math.max(0, Math.round(progStats.realBrule)).toLocaleString('fr')} sur {Math.round(progStats.totalCible).toLocaleString('fr')} kcal brûlées</div>
  </div>
  {/if}

  {#if sundaySug?.show && sundaySug.delta !== 0}
  <div class="card sunday-card">
    <span class="sunday-ico">📅</span>
    <span class="sunday-msg">{sundaySug.msg}</span>
  </div>
  {/if}

  <!-- Coach IA -->
  <div class="card hero-card hero-eat">
      <div class="label">Journée à</div>
      {#if tIntake > 0}
        {@const reste = tIntake - macros.k}
        <div class="hero-num" style="color:var(--c-text)">{Math.round(tIntake).toLocaleString('fr')}<span class="hero-unit"> / {tdeeToday.toLocaleString('fr')} kcal</span></div>
        <div class="caption hero-eat-sub" style="margin-top:6px">
          {reste >= 0 ? `reste ${Math.round(reste).toLocaleString('fr')} kcal à manger` : `dépassé de ${Math.round(-reste).toLocaleString('fr')} kcal`}
        </div>
      {:else}
        <div class="hero-num no-data">—</div>
        <div class="caption" style="margin-top:6px">Aucune cible programme</div>
      {/if}
    </div>


  <div class="card coach-card">
    <button class="coach-btn" onclick={runCoach} disabled={coachLoading}>
      {coachLoading ? '⏳ Analyse en cours…' : '🤖 Demander un bilan au coach'}
    </button>
    {#if coachText}
      <div class="coach-out">
        <div class="coach-text">{coachText}</div>
        <button class="coach-close" onclick={() => coachText = ''}>✕ Fermer</button>
      </div>
    {/if}
    {#if coachError}
      <div class="coach-error">{coachError}</div>
    {/if}
  </div>

  {#if avgMacros}
  <div class="section-label" style="margin-top:0">Moyenne / jour depuis le début ({avgMacros.n} j)</div>
  <div class="macro-row">
    {#each [
      { key: 'p', label: $t.dashboard.proteins, color: 'var(--c-accent)', cible: mCible.p },
      { key: 'g', label: $t.dashboard.carbs,    color: 'var(--c-blue)',   cible: mCible.g },
      { key: 'l', label: $t.dashboard.fats,     color: 'var(--c-red)',    cible: mCible.l },
    ] as m}
    {@const avg = (avgMacros as any)[m.key]}
    <div class="card macro-card">
      <div class="label">{m.label}</div>
      <div class="progress-bar" style="margin:10px 0 8px">
        <div class="progress-fill" style="width:{pct(avg, m.cible)}%;background:{m.color};opacity:.65"></div>
      </div>
      <div class="macro-val">{avg}<span class="macro-target">/{m.cible}g</span></div>
    </div>
    {/each}
  </div>
  {/if}

  {#if fatLost}
  {@const totalLostG = fatLost.g + fatLost.leanG}
  <div class="card lost-card">
    <div class="lost-grid">
      <div class="lost-item">
        <div class="lost-val">−{(totalLostG / 1000).toFixed(2).replace('.', ',')} kg</div>
        <div class="lost-lbl">Poids perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-green)">−{(fatLost.g / 1000).toFixed(2).replace('.', ',')} kg</div>
        <div class="lost-lbl">Gras perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-blue)">{fatLost.nowW.toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Poids</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-green)">−{(fatLost.bf - fatLost.bfNow).toFixed(1).replace('.', ',')} %</div>
        <div class="lost-lbl">% MG perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-red)">−{(fatLost.realMuscleG / 1000).toFixed(2).replace('.', ',')} kg</div>
        <div class="lost-lbl">Muscle perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-blue)">{fatLost.bfNow.toFixed(1).replace('.', ',')} %</div>
        <div class="lost-lbl">% MG</div>
      </div>
    </div>
    <div class="caption" style="margin-top:8px">Mesuré depuis J1 (tes pesées + %MG) · masse maigre dont eau/glycogène −{(fatLost.waterG / 1000).toFixed(2).replace('.', ',')} kg</div>
  </div>
  {/if}

  {#if fatLost && progStats.expectedSoFar > 0 && progStats.totalCible > 0}
  {@const futFrac = Math.max(0, (progStats.totalCible - progStats.expectedSoFar) / progStats.expectedSoFar)}
  {@const ratioP = Math.max(0, Math.min(1, progStats.protPct))}
  {@const futFatG = fatLost.g * futFrac}
  {@const futLeanG = fatLost.leanG * futFrac}
  {@const futMuscG = futLeanG * (0.20 + 0.40 * (1 - ratioP))}
  {@const pFat = fatLost.g + futFatG}
  {@const pMusc = fatLost.realMuscleG + futMuscG}
  {@const pWater = Math.min(fatLost.waterG + (futLeanG - futMuscG), 1750)}
  {@const pWEnd = fatLost.nowW - (futFatG + futLeanG) / 1000}
  {@const pBfEnd = pWEnd > 0 ? Math.max(0, (fatLost.nowFat - futFatG / 1000) / pWEnd * 100) : fatLost.bfNow}
  {@const pLostG = Math.round((fatLost.startW - pWEnd) * 1000)}
  <div class="card lost-card">
    <div class="section-title-inline">Projection à mes macros actuelles (J{totalDays})</div>
    <div class="lost-grid">
      <div class="lost-item">
        <div class="lost-val">−{(pLostG / 1000).toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Poids perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-green)">−{(pFat / 1000).toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Gras perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-blue)">{pWEnd.toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Poids</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-green)">−{(fatLost.bf - pBfEnd).toFixed(1).replace('.', ',')} %</div>
        <div class="lost-lbl">% MG perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-red)">−{(pMusc / 1000).toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Muscle perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-blue)">{pBfEnd.toFixed(1).replace('.', ',')} %</div>
        <div class="lost-lbl">% MG</div>
      </div>
    </div>
    <div class="caption" style="margin-top:8px">Si je garde ce rythme et mes macros actuelles jusqu'à la fin du programme · dont eau/glycogène −{(pWater / 1000).toFixed(1).replace('.', ',')} kg</div>
  </div>

  {@const oFutFatG = fatLost.g * futFrac}
  {@const oFat = fatLost.g + oFutFatG}
  {@const oMusc = fatLost.realMuscleG}
  {@const oWater = fatLost.waterG}
  {@const oWEnd = fatLost.nowW - oFutFatG / 1000}
  {@const oBfEnd = oWEnd > 0 ? Math.max(0, (fatLost.nowFat - oFutFatG / 1000) / oWEnd * 100) : fatLost.bfNow}
  {@const oLostG = Math.round((fatLost.startW - oWEnd) * 1000)}
  <div class="card lost-card">
    <div class="section-title-inline">Projection si je passe à 152 g dès maintenant (J{totalDays})</div>
    <div class="lost-grid">
      <div class="lost-item">
        <div class="lost-val">−{(oLostG / 1000).toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Poids perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-green)">−{(oFat / 1000).toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Gras perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-blue)">{oWEnd.toFixed(1).replace('.', ',')} kg</div>
        <div class="lost-lbl">Poids</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-green)">−{(fatLost.bf - oBfEnd).toFixed(1).replace('.', ',')} %</div>
        <div class="lost-lbl">% MG perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-red)">−{(oMusc / 1000).toFixed(2).replace('.', ',')} kg</div>
        <div class="lost-lbl">Muscle perdu</div>
      </div>
      <div class="lost-item">
        <div class="lost-val" style="color:var(--c-blue)">{oBfEnd.toFixed(1).replace('.', ',')} %</div>
        <div class="lost-lbl">% MG</div>
      </div>
    </div>
    <div class="caption" style="margin-top:8px">Même rythme de gras, mais protéines à 152 g/j → 0 perte de muscle jusqu'à la fin (le muscle conservé fait baisser le %MG)</div>
  </div>
  {/if}

  <div class="section-label" style="margin-top:0">Aujourd'hui</div>
  <div class="macro-row">
    {#each [
      { key: 'p', label: $t.dashboard.proteins, color: 'var(--c-accent)', cible: mCible.p },
      { key: 'g', label: $t.dashboard.carbs,    color: 'var(--c-blue)',   cible: mCible.g },
      { key: 'l', label: $t.dashboard.fats,     color: 'var(--c-red)',    cible: mCible.l },
    ] as m}
    {@const actual = Math.round(macros[m.key as keyof typeof macros])}
    <div class="card macro-card">
      <div class="label">{m.label}</div>
      <div class="progress-bar" style="margin:10px 0 8px">
        <div class="progress-fill" style="width:{pct(actual, m.cible)}%;background:{m.color}"></div>
      </div>
      <div class="macro-val">{actual}<span class="macro-target">/{m.cible}g</span></div>
    </div>
    {/each}
  </div>


  <!-- Repas du jour -->
  <div class="card foods-card">
    <div class="foods-header">
      <span class="label">Repas du jour</span>
      <button class="add-food-btn" onclick={() => openModal(todayKey)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Ajouter
      </button>
    </div>

    {#if foods.length === 0}
      <div class="foods-empty">Rien de loggé — ajoute ton premier repas !</div>
    {:else}
      <div class="foods-list">
        {#each foods as food, i}
          <div class="food-item">
            <div class="food-nm">
              <span class="food-n">{food.n}</span>
              <span class="food-m">P {Math.round(food.p ?? 0)}g · G {Math.round(food.g ?? 0)}g · L {Math.round(food.l ?? 0)}g</span>
            </div>
            <span class="food-k">{Math.round(food.k)} kcal</span>
            <button class="food-del" onclick={() => removeFood(i)} aria-label="Supprimer">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        {/each}
        <div class="foods-total">
          <span>Total</span>
          <span class="total-k">{Math.round(macros.k)} kcal</span>
        </div>
      </div>
    {/if}

    <!-- Sport supplémentaire -->
    <div class="sport-extra-row">
      <span class="sport-extra-label">🏃 Sport supplémentaire</span>
      <input class="sport-extra-inp" type="number" min="0" step="50"
        placeholder="0"
        value={today?.extraKcal ?? 0}
        onblur={(e) => saveExtraKcal((e.target as HTMLInputElement).value)}
      />
      <span class="sport-extra-unit">kcal brûlées</span>
    </div>
    <div class="supp-row">
      {#each SUPPS as sp}
        <button class="supp-chip" class:on={today?.supps?.[sp.key]} onclick={() => toggleSupp(sp.key)}><span class="supp-box">{today?.supps?.[sp.key] ? '✓' : ''}</span> {sp.label}</button>
      {/each}
    </div>
    <div class="sport-extra-row" style="border-top:0.5px solid var(--c-border);margin-top:8px;padding-top:10px">
      <span class="sport-extra-label">⚖️ Poids du jour</span>
      <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" step="0.1"
        placeholder="—"
        value={today?.weight ?? ''}
        onblur={(e) => saveWeight((e.target as HTMLInputElement).value)}
      />
      <span class="sport-extra-unit">kg</span>
    </div>
    <div class="sport-extra-row">
      <span class="sport-extra-label">📊 Masse grasse</span>
      <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" max="60" step="0.1"
        placeholder="—"
        value={today?.bf ?? ''}
        onblur={(e) => saveBf((e.target as HTMLInputElement).value)}
      />
      <span class="sport-extra-unit">%</span>
    </div>
  </div>

  <!-- Courbe de poids -->
  {#if weightSeries}
  <div class="card foods-card">
    <div class="foods-header">
      <span class="label">Poids</span>
      <span class="weight-badge">{weightSeries.last.toLocaleString('fr')} kg · moy. 7j {weightSeries.lastAvg.toLocaleString('fr')} kg{#if weightSeries.lastBf} · <span style="color:var(--c-blue)">{weightSeries.lastBf.toLocaleString('fr')}% MG</span>{/if}</span>
    </div>
    <svg viewBox="-4 -6 312 92" class="weight-chart" preserveAspectRatio="none">
      <polyline points={weightSeries.pts} fill="none" stroke="var(--c-border2)" stroke-width="1.5" />
      <polyline points={weightSeries.avgPts} fill="none" stroke="var(--c-accent)" stroke-width="2.5" stroke-linecap="round" />
      {#if weightSeries.bfPts}<polyline points={weightSeries.bfPts} fill="none" stroke="var(--c-blue)" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round" />{/if}
      <circle cx={weightSeries.lastX} cy={weightSeries.lastY} r="3" fill="var(--c-accent)" />
    </svg>
    <div class="caption" style="margin-top:6px">{weightSeries.n} pesées · {weightSeries.delta <= 0 ? '' : '+'}{weightSeries.delta.toLocaleString('fr')} kg depuis le début · ligne épaisse = poids moy. 7 j · fine = pesées brutes · pointillés bleus = % MG</div>
  </div>
  {/if}


  <!-- Historique des jours passés -->
  <div class="section-label">Historique</div>
  {#each recentDays() as day}
  <details class="card hist-card">
    <summary class="hist-summary">
      <div class="hist-top">
        <span class="hist-date">{day.label}{#if day.jNum} (J{day.jNum}){/if}</span>
        <span class="hist-kcal" style="color:{day.foods.length ? (day.total <= day.expend ? 'var(--c-green)' : 'var(--c-red)') : 'var(--c-text2)'}">
          {Math.round(day.total).toLocaleString('fr')} kcal
        </span>
        {#if day.foods.length}
        <span class="hist-cible">/ {Math.round(day.expend).toLocaleString('fr')}</span>
        {/if}
      </div>
      {#if day.foods.length}
      <div class="hist-macros">P {Math.round(day.p)}g · G {Math.round(day.g)}g · L {Math.round(day.l)}g{#if day.deficit !== null} · <span style="font-weight:600;color:{day.neutre ? 'var(--c-blue)' : (day.deficit >= 0 ? 'var(--c-green)' : 'var(--c-red)')}">{day.neutre ? 'neutre' : (day.deficit >= 0 ? 'déficit −' + day.deficit.toLocaleString('fr') : 'surplus +' + Math.abs(day.deficit).toLocaleString('fr'))}</span>{#if !day.neutre && day.gFat !== null}<span class="grams-detail"><span style="color:var(--c-green)">{day.gFat < 0 ? '−' : day.gFat > 0 ? '+' : ''}{Math.abs(day.gFat)}g gras</span>{#if day.gMuscle !== 0} · <span style="color:var(--c-red)">{day.gMuscle < 0 ? '−' : '+'}{Math.abs(day.gMuscle)}g muscle</span>{/if}{#if day.gWater !== 0} · <span style="color:var(--c-blue)">{day.gWater < 0 ? '−' : '+'}{Math.abs(day.gWater)}g eau</span>{/if}</span>{/if}{/if}</div>
      {/if}
    </summary>
    <div class="hist-foods">
      {#each day.foods as f, fi}
      <div class="hist-food-row">
        <div class="food-nm">
          <span class="food-n">{f.n}</span>
          <span class="food-m">P {Math.round(f.p ?? 0)}g · G {Math.round(f.g ?? 0)}g · L {Math.round(f.l ?? 0)}g</span>
        </div>
        <span class="food-k">{Math.round(f.k)} kcal</span>
        <button class="food-del" onclick={() => removeFood(fi, day.key)} aria-label="Supprimer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      {/each}
      <!-- Ajouter aliment -->
      <button class="hist-add-btn" onclick={() => openModal(day.key)}>+ Ajouter un aliment</button>
      <!-- Sport supplémentaire -->
      <div class="sport-extra-row" style="border-top:0.5px solid var(--c-border);margin-top:6px;padding-top:10px">
        <span class="sport-extra-label">🏃 Sport sup.</span>
        <input class="sport-extra-inp" type="number" min="0" step="50"
          placeholder="0"
          value={day.extraKcal}
          onblur={(e) => saveExtraKcal((e.target as HTMLInputElement).value, day.key)}
        />
        <span class="sport-extra-unit">kcal</span>
      </div>
      <div class="sport-extra-row">
        <span class="sport-extra-label">⚖️ Poids</span>
        <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" step="0.1"
          placeholder="—"
          value={(days as any)[day.key]?.weight ?? ''}
          onblur={(e) => saveWeight((e.target as HTMLInputElement).value, day.key)}
        />
        <span class="sport-extra-unit">kg</span>
      </div>
      <div class="sport-extra-row">
        <span class="sport-extra-label">📊 Masse grasse</span>
        <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" max="60" step="0.1"
          placeholder="—"
          value={(days as any)[day.key]?.bf ?? ''}
          onblur={(e) => saveBf((e.target as HTMLInputElement).value, day.key)}
        />
        <span class="sport-extra-unit">%</span>
      </div>
      {#if day.adaptation}<div class="caption" style="padding:8px 0 0">🔥 Thermogénèse adaptative comptée ce jour-là : −{day.adaptation} kcal</div>{/if}
    </div>
  </details>
  {/each}

  <div class="stats-row">
    <div class="card stat-card">
      <div class="label">{$t.dashboard.cumul}</div>
      <div class="value-accent" style="color:{cumulReal <= 0 ? 'var(--c-accent)' : 'var(--c-red)'}">
        {fmt(cumulReal)}
      </div>
      <div class="caption">{$t.dashboard.since_start}</div>
    </div>
    <div class="card stat-card">
      <div class="label">{$t.dashboard.goal_nov}</div>
      {#if bfProjected}
        <div class="value-sm">{bfProjected}%</div>
        <div class="caption">{$t.dashboard.body_fat_projected}</div>
      {:else}
        <div class="value-sm">—</div>
      {/if}
    </div>
  </div>

</div>

{#if showModal}
  <FoodModal dayKey={modalDayKey} onclose={() => showModal = false} />
{/if}

<style>
.header { display:flex; align-items:center; justify-content:space-between; padding:20px 0 12px; }
.date { font-size:20px; font-weight:500; color:var(--c-text); margin-top:3px; letter-spacing:-0.3px; display:flex; align-items:baseline; gap:8px; }
.build-tag { font-size:11px; font-weight:500; color:var(--c-text3); letter-spacing:0; text-transform:none; }
.day-badge { font-size:13px; font-weight:600; color:var(--c-text2); }
.day-badge span { font-weight:400; color:var(--c-text3); }
.hero-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
.hero-card { padding:16px; }
.hero-num { font-size:26px; font-weight:700; letter-spacing:-0.5px; line-height:1.1; margin:6px 0 0; }
.hero-num.no-data { color:var(--c-text3); }
.hero-unit { font-size:13px; font-weight:400; letter-spacing:0; margin-left:3px; color:var(--c-text2); }
.macro-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:10px; }
.lost-card { padding:14px; margin-bottom:10px; }
.section-title-inline { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:0.06em; color:var(--c-text3); margin-bottom:10px; }
.lost-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px 6px; }
.lost-item { text-align:center; }
.lost-val { font-size:15px; font-weight:700; color:var(--c-text); white-space:nowrap; }
.lost-lbl { font-size:11px; color:var(--c-text3); margin-top:2px; }
.macro-card { padding:14px; }
.macro-val { font-size:18px; font-weight:600; color:var(--c-text); }
.macro-target { font-size:11px; font-weight:400; color:var(--c-text3); }

/* Foods */
.foods-card { padding:16px; margin-bottom:10px; }
.weight-badge { font-size:12px; font-weight:600; color:var(--c-text2); }
.weight-chart { width:100%; height:88px; display:block; }
.foods-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.add-food-btn { display:flex; align-items:center; gap:5px; padding:6px 12px; border:none; border-radius:20px; background:var(--c-accent); color:var(--c-accent-fg); font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font); }
.foods-empty { font-size:13px; color:var(--c-text3); text-align:center; padding:12px 0; }
.sport-extra-row { display:flex; align-items:center; gap:8px; padding:12px 0 2px; border-top:0.5px solid var(--c-border); margin-top:4px; }
.sport-extra-label { flex:1; font-size:13px; color:var(--c-text2); }
.sport-extra-inp { width:72px; padding:6px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:13px; text-align:right; font-family:var(--font); }
.sport-extra-inp:focus { outline:none; border-color:var(--c-accent); }
.sport-extra-unit { font-size:12px; color:var(--c-text3); white-space:nowrap; }
.foods-list { display:flex; flex-direction:column; gap:0; }
.food-item { display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:0.5px solid var(--c-border); }
.food-nm { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.food-n { font-size:13px; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.food-m { font-size:10px; color:var(--c-text3); white-space:nowrap; }
.food-k { font-size:12px; font-weight:500; color:var(--c-text2); flex-shrink:0; }
.food-del { border:none; background:none; color:var(--c-text3); cursor:pointer; padding:2px; display:flex; align-items:center; }
.food-del:hover { color:var(--c-red,#e05); }
.foods-total { display:flex; justify-content:space-between; padding:8px 0 0; font-size:13px; color:var(--c-text2); font-weight:500; }
.total-k { color:var(--c-accent); font-weight:600; }

.stats-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
.stat-card { display:flex; flex-direction:column; gap:4px; padding:16px; }
.value-accent { font-size:24px; font-weight:500; letter-spacing:-0.5px; }
.value-sm { font-size:24px; font-weight:500; letter-spacing:-0.5px; color:var(--c-text); }
.progress-card { padding:18px; margin-bottom:10px; }
.coach-card { padding:0; margin-bottom:10px; background:transparent; border:none; }
.coach-btn { width:100%; border:1px solid var(--c-accent); background:transparent; color:var(--c-accent); border-radius:var(--r-md); padding:16px; font-weight:700; font-size:15px; cursor:pointer; font-family:var(--font); transition:opacity .15s; }
.coach-btn:disabled { opacity:.6; cursor:not-allowed; }
.coach-out { margin-top:12px; }
.coach-text { font-size:14px; line-height:1.65; color:var(--c-text); white-space:pre-wrap; }
.coach-close { margin-top:10px; border:none; background:none; color:var(--c-text3); font-size:12px; cursor:pointer; padding:0; font-family:var(--font); }
.coach-error { margin-top:10px; font-size:13px; color:#e05; }

.prog-top { display:flex; align-items:center; justify-content:space-between; }

.section-label { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); margin:14px 0 8px; }
.hist-card { padding:0; margin-bottom:6px; overflow:hidden; }
.hist-summary { display:flex; flex-direction:column; gap:3px; padding:12px 14px; cursor:pointer; list-style:none; }
.hist-top { display:flex; align-items:center; gap:8px; }
.hist-macros { font-size:11px; color:var(--c-text3); }
.grams-detail { display:block; margin-top:2px; font-weight:600; }
.hist-summary::-webkit-details-marker { display:none; }
.hist-date { flex:1; font-size:13px; font-weight:500; color:var(--c-text); text-transform:capitalize; }
.hist-kcal { font-size:13px; font-weight:600; flex-shrink:0; }
.hist-cible { font-size:11px; color:var(--c-text3); flex-shrink:0; }
.hist-foods { padding:0 14px 12px; display:flex; flex-direction:column; gap:0; border-top:0.5px solid var(--c-border); }
.hist-food-row { display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:0.5px solid var(--c-border); }
.hist-food-row:last-child { border-bottom:none; }
.hist-add-btn { width:100%; padding:8px; border:1px dashed var(--c-border); border-radius:8px; background:none; color:var(--c-accent); font-size:13px; cursor:pointer; font-family:var(--font); margin-top:6px; }
.hist-add-btn:hover { background:var(--c-surface); }


  /* Cellules colorees (mode clair) — palette FitNoobX */
  :global(html[data-theme='light']) .progress-card { background:#FFE98A; border-color:rgba(0,0,0,0.05); }
  :global(html[data-theme='light']) .hero-eat { background:#79E8B3; border-color:rgba(0,0,0,0.05); }
  :global(html[data-theme='light']) .hero-retard { background:#BBEFFF; border-color:rgba(0,0,0,0.05); }
  :global(html[data-theme='light']) .progress-card .label,
  :global(html[data-theme='light']) .progress-card .caption,
  :global(html[data-theme='light']) .hero-eat .label,
  :global(html[data-theme='light']) .hero-retard .label,
  :global(html[data-theme='light']) .hero-eat .hero-eat-sub { color:#1a1a1a; }

.app-title { font-size:22px; font-weight:700; color:var(--c-text); letter-spacing:-0.5px; }
.app-title .x { color:var(--c-accent); }

  /* Polices uniformisees des cellules (style FitNoobX) */
  .progress-card .label { font-size:14px; font-weight:700; letter-spacing:.05em; }
  .hero-card .label { font-size:11px; font-weight:600; }
  .hero-card .caption { font-size:13px; font-weight:500; }
  .macro-card .label { font-weight:600; }
  :global(html[data-theme='light']) .coach-btn { background:#FFC2DF; border-color:#FFC2DF; color:#1a1a1a; }

  /* Uniformisation avec FitNoobX */
  .header .label { font-weight:600; letter-spacing:.07em; }
  .progress-card .progress-bar { height:6px; border-radius:3px; background:var(--c-surface2); }
  .progress-card .progress-fill { border-radius:3px; }

  /* Alignement exact sur le design FitNoobX (onglet Suivi) */
  .progress-card { padding:16px; margin-bottom:8px; }
  .hero-row { margin-bottom:8px; }
  .macro-row { margin-bottom:8px; }
  .coach-card { margin-bottom:8px; }
  .progress-card .caption { font-size:13px; color:var(--c-text3); }
  .progress-card .badge-accent { border-radius:20px; padding:3px 9px; font-weight:700; }
  .coach-btn { border-width:2px; }

  .fat-note { font-size:11px; color:var(--c-text3); font-style:italic; margin-top:2px; }

  .heure-tag { font-size:14px; font-weight:400; color:var(--c-text2); letter-spacing:0; }

.supp-row { display:flex; flex-wrap:wrap; gap:6px; border-top:0.5px solid var(--c-border); margin-top:8px; padding-top:10px; }
.supp-chip { display:flex; align-items:center; gap:5px; border:0.5px solid var(--c-border); background:var(--c-bg); color:var(--c-text2); border-radius:20px; padding:5px 10px; font-size:12px; cursor:pointer; font-family:var(--font); }
.supp-chip.on { background:var(--c-green); border-color:var(--c-green); color:#fff; }
.supp-box { width:14px; height:14px; border-radius:4px; border:1px solid currentColor; display:inline-flex; align-items:center; justify-content:center; font-size:10px; line-height:1; flex-shrink:0; }
.supp-chip.on .supp-box { background:#fff; color:var(--c-green); border-color:#fff; }
.sunday-card { display:flex; align-items:flex-start; gap:9px; padding:12px 14px; margin-bottom:10px; background:var(--c-surface); border:1px solid var(--c-accent); border-radius:var(--r-md); }
.sunday-ico { font-size:16px; flex-shrink:0; }
.sunday-msg { font-size:13px; color:var(--c-text); line-height:1.4; }
</style>
