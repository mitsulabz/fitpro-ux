<script lang="ts">
  import { t, appData, session, persistSession } from "./store";
  import { nf, calcBMR } from './calc';
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
  const days = $derived(($appData as any)?.days ?? {});
  const today = $derived(days[todayKey] ?? {});
  const foods = $derived(today?.foods ?? []);

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
  const tBrulees = $derived((progDay?.calories_brulees ?? 0) + (today?.extraKcal ?? 0));
  const tIntake = $derived(progDay?.calories ?? 0);
  const tdeeToday = $derived.by(() => {
    const bmr = bmrOf(profile); const actF = nfp(profile.act) || 1.4;
    const act = progDay ? actOf(progDay, todayKey) : '';
    const sportK = (act && act !== 'Libre') ? (activites[act] ?? 0) : 0;
    return Math.round(bmr * actF + sportK + (today?.extraKcal ?? 0));
  });
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
    const bmr = bmrOf(profile);
    const actF = nfp(profile.act) || 1.4;
    const w = nfp(profile.weight) || 100;
    const pTargetDay = 1.6 * w; // g de proteines/jour pour preserver le muscle
    const sexFloor = profile.sex === 'f' ? 1200 : 1500;
    const minIntake = Math.max(Math.round(bmr), sexFloor);
    let totalCible = 0, realBrule = 0, expectedSoFar = 0;
    let fatKcal = 0, defKcalPos = 0, protEaten = 0, protTarget = 0, protShortfall = 0;
    progJours.forEach((j: any) => {
      const jd = parseJour(j.jour); if (!jd) return;
      const ds = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      const act = actOf(j, ds);
      const sportK = (act && act !== 'Libre') ? (activites[act] ?? 0) : 0;
      const tdee = Math.round(bmr * actF + sportK);
      const cible = act === 'Libre' ? 0 : Math.round(Math.min(tdee * 0.25, tdee - minIntake));
      totalCible += cible;
      const dd = (days as any)[ds] ?? {};
      const fds = dd.foods ?? [];
      const eaten = fds.reduce((s: number, f: any) => s + (f.k||0), 0);
      const jd0 = new Date(jd); jd0.setHours(0,0,0,0);
      if (jd0.getTime() === todayDate.getTime()) {
        // jour en cours : prorata horaire (depense au prorata de l'heure - mange jusqu'a maintenant)
        // depense du jour (base + activite du jour) au prorata de l'heure ; sport sup. compte en entier ; - mange aujourd'hui
        realBrule += (Math.round(tdee * dayFrac) + (dd.extraKcal ?? 0)) - eaten;
        expectedSoFar += cible * dayFrac;
      }
      if (jd0 < todayDate && eaten > 0) {
        const def = (tdee + (dd.extraKcal ?? 0)) - eaten;
        realBrule += def;
        expectedSoFar += cible;
        if (def > 0) {
          const pDay = fds.reduce((s: number, f: any) => s + (f.p||0), 0);
          const ratio = pTargetDay > 0 ? Math.max(0, Math.min(1, pDay / pTargetDay)) : 1;
          const fatFrac = 0.70 + 0.20 * ratio; // 0.70 (0 proteines) -> 0.90 (cible atteinte)
          fatKcal += def * fatFrac;
          defKcalPos += def;
          protEaten += pDay;
          protTarget += pTargetDay;
          protShortfall += Math.max(0, pTargetDay - pDay); // g de proteines manquantes (jours en deficit)
        }
      }
    });
    const fatShare = defKcalPos > 0 ? fatKcal / defKcalPos : 0.9;
    const protPct = protTarget > 0 ? protEaten / protTarget : 1;
    return { totalCible, realBrule, expectedSoFar, fatKcal, fatShare, protPct, defKcalPos, protShortfall };
  });
  const progressPct = $derived(progStats.totalCible > 0
    ? Math.max(0, Math.min(100, Math.round(progStats.realBrule / progStats.totalCible * 100)))
    : 0);

  // Estimation MG perdue (meilleur cas : suppose assez de proteines pour preserver le muscle)
  function fmtG(g: number): string {
    return g >= 1000 ? (g / 1000).toFixed(2).replace('.', ',') + ' kg' : Math.round(g) + ' g';
  }
  const fatLost = $derived.by(() => {
    const w = nfp(profile.weight), bf = nfp(profile.bf);
    const fatKcal = Math.max(0, progStats.fatKcal);
    const defPos = Math.max(0, progStats.defKcalPos);
    if (!w || !bf || fatKcal <= 0) return null;
    const kg = fatKcal / 7700;
    const fatInit = w * bf / 100;
    const fatNow = Math.max(0, fatInit - kg);
    const wNow = w - kg;
    const bfNow = wNow > 0 ? fatNow / wNow * 100 : bf;
    const idealG = Math.round((defPos * 0.90) / 7700 * 1000); // macros parfaites : ~90% en gras
    // Muscle reel = energie du gras NON perdu (vs macros optimales), convertie en muscle humide.
    // Couple directement a l'ecart de gras -> toujours coherent energetiquement.
    const muscleKcal = Math.max(0, defPos * 0.90 - fatKcal); // kcal venus de la masse maigre au lieu du gras
    const leanG = Math.round(muscleKcal / 1850 * 1000); // masse maigre humide (muscle + eau/glycogene)
    // Part de VRAI muscle : depend de l'apport proteique (bas -> plus de muscle, haut -> surtout eau)
    const ratio = Math.max(0, Math.min(1, progStats.protPct));
    const realMuscleG = Math.round(leanG * (0.10 + 0.25 * (1 - ratio)));
    const waterG = leanG - realMuscleG;
    return { g: Math.round(kg * 1000), idealG, leanG, realMuscleG, waterG, bf, bfNow: +bfNow.toFixed(1) };
  });
  // Projection a la fin du programme (extrapolation du rythme actuel)
  const proj = $derived.by(() => {
    if (!fatLost) return null;
    const w = nfp(profile.weight), bf = nfp(profile.bf);
    const defPos = Math.max(0, progStats.defKcalPos);
    if (!w || !bf || defPos <= 0 || progStats.totalCible <= 0) return null;
    const last = progJours[progJours.length - 1];
    const endD = last ? parseJour(last.jour) : null;
    const endStr = endD ? endD.toLocaleDateString('fr-FR', { day:'numeric', month:'short', year:'numeric' }) : '—';
    const scale = progStats.totalCible / defPos; // du realise-so-far au total programme
    const fatInit = w * bf / 100;
    // reel
    const fatR = (fatLost.g / 1000) * scale, muscR = (fatLost.realMuscleG / 1000) * scale;
    const wR = w - fatR - muscR, bfR = wR > 0 ? (fatInit - fatR) / wR * 100 : bf;
    // optimal
    const fatO = (fatLost.idealG / 1000) * scale;
    const wO = w - fatO, bfO = wO > 0 ? (fatInit - fatO) / wO * 100 : bf;
    return { endStr, wR: wR.toFixed(1), bfR: bfR.toFixed(1), wO: wO.toFixed(1), bfO: bfO.toFixed(1) };
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
    for (let i = 1; i <= 30; i++) {
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
      const act = jd ? actOf(jd, key) : '';
      const sportK = (act && act !== 'Libre') ? (activites[act] ?? 0) : 0;
      const tdee = Math.round(bmrOf(profile) * (nfp(profile.act) || 1.4) + sportK);
      const expend = tdee + extraKcal;
      const deficit = hasFood ? Math.round(expend - total) : null; // null si rien loggé
      const neutre = deficit !== null && Math.abs(deficit) <= 50; // neutre = mange ~ depense
      result.push({ key, label, jNum, foods, total, cible, expend, extraKcal, p: sp, g: sg, l: sl, deficit, neutre });
      if (result.length >= 14) break;
    }
    return result;
  });


  function pct(a: number, b: number) { return b > 0 ? Math.min(100, Math.round(a/b*100)) : 0; }
  function fmt(n: number) { return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('fr'); }

  const BUILD = "V8.1";
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
    return { pts, avgPts, last: last.w, lastAvg: +lastAvg.w.toFixed(1), delta, n: entries.length,
             lastX: X(last.t).toFixed(1), lastY: Y(last.w).toFixed(1) };
  });

  const SUPPS = [
    { key: 'folic', label: 'Folic Expert' },
    { key: 'omega3', label: 'Oméga 3' },
    { key: 'b12', label: 'B12' },
    { key: 'mag1', label: 'Magnésium 1' },
    { key: 'mag2', label: 'Magnésium 2' },
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
  let sosLoading = $state(false);
  let sosText = $state('');
  let sosError = $state('');

  function buildCoachSummary() {
    const data = get(appData) as any;
    const p = data?.profile ?? {};
    const jours: any[] = progJours;
    const w = parseFloat(p.weight) || 0;
    const bf = parseFloat(p.bf) || 0;
    const bft = parseFloat(p.bft) || 0;
    const todayD = new Date(); todayD.setHours(0,0,0,0);

    // Projection MG finale
    let mgFinale: number | null = null;
    if (w && bf) {
      const totalDef = jours.reduce((s: number, j: any) => s + effDeficit(j), 0);
      if (totalDef > 0) {
        const kgLost = totalDef / 7700;
        const fatInit = w * bf / 100;
        const fatFinal = Math.max(0, fatInit - kgLost);
        const wFinal = w - kgLost;
        mgFinale = wFinal > 0 ? +((fatFinal / wFinal) * 100).toFixed(1) : null;
      }
    }

    // Objectif kcal total
    let deficitCibleTotal: number | null = null;
    if (w && bf && bft && bft < bf) {
      const lean = w * (1 - bf / 100);
      const targetW = lean / (1 - bft / 100);
      deficitCibleTotal = Math.round((w - targetW) * 7700);
    }

    // Jours loggés + macros vs cibles
    let jLogged = 0, retardKcal = 0;
    let sumP = 0, sumG = 0, sumL = 0;
    let cibP = 0, cibG = 0, cibL = 0;
    jours.forEach((j: any) => {
      const jd = parseJour(j.jour);
      if (!jd) return;
      jd.setHours(0,0,0,0);
      if (jd >= todayD) return;
      const key = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      const day = (days as any)[key];
      if (!day?.foods?.length) return;
      if (/libre/i.test(j.type || '')) return;
      jLogged++;
      const eaten = Math.round(day.foods.reduce((s: number, f: any) => s + f.k, 0));
      retardKcal += eaten - (j.calories || 0);
      sumP += day.foods.reduce((s: number, f: any) => s + (f.p || 0), 0);
      sumG += day.foods.reduce((s: number, f: any) => s + (f.g || 0), 0);
      sumL += day.foods.reduce((s: number, f: any) => s + (f.l || 0), 0);
      cibP += j.proteines_g || 0; cibG += j.glucides_g || 0; cibL += j.lipides_g || 0;
    });

    const lastJ = jours[jours.length - 1];
    return {
      profil: { sexe: p.sex, age: parseFloat(p.age) || 0, poids_kg: w, masse_grasse_pct: bf },
      programme: {
        date_fin: lastJ?.jour ?? null,
        masse_grasse_finale_projetee_pct: mgFinale,
        jours_logges: jLogged,
        retard_kcal: Math.round(retardKcal),
        heures_velo_a_rattraper: retardKcal > 0 ? +(retardKcal / 500).toFixed(1) : 0,
        macros_reelles: { proteines_g: Math.round(sumP), glucides_g: Math.round(sumG), lipides_g: Math.round(sumL) },
        macros_cibles: { proteines_g: Math.round(cibP), glucides_g: Math.round(cibG), lipides_g: Math.round(cibL) },
      },
      progression: {
        deficit_cumule: Math.round(cumul),
        deficit_cible_total: deficitCibleTotal,
        pct_objectif: deficitCibleTotal ? +((cumul / deficitCibleTotal) * 100).toFixed(1) : null,
      },
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

  async function runSos() {
    sosLoading = true; sosText = ''; sosError = '';
    try {
      const s = get(session);
      let token = s?.access_token ?? '';
      try { const fresh = await refreshToken(s!.refresh_token); persistSession(fresh); token = fresh.access_token; } catch {}
      const eaten = { p: Math.round(macros.p), g: Math.round(macros.g), l: Math.round(macros.l), k: Math.round(macros.k) };
      const cible = { p: mCible.p, g: mCible.g, l: mCible.l };
      const rp = Math.max(0, cible.p - eaten.p), rg = Math.max(0, cible.g - eaten.g), rl = Math.max(0, cible.l - eaten.l); const reste = { p: rp, g: rg, l: rl, kcal: Math.round(rp*4 + rg*4 + rl*9) };
      const data = { deja_mange: eaten, cibles: cible, reste, contraintes: 'Ne mange pas de viande SAUF steak hache et blanc de poulet. Pas de poisson sauf si propose explicitement comme option. Privilegie oeufs, laitages 0%, legumineuses, tofu, fromage, whey.' };
      const r = await fetch(`${SUPABASE_URL}/functions/v1/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'sos-macros', data }),
      });
      const d = await r.json();
      if (d.text) sosText = d.text;
      else sosError = d.error ?? 'Erreur S.O.S';
    } catch { sosError = 'Erreur réseau'; }
    sosLoading = false;
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

  <!-- Coach IA -->
  <div class="hero-row">
    <!-- Cible du jour -->
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
    <!-- Retard programme -->
    <div class="card hero-card hero-retard">
      <div class="label">Retard programme</div>
      {#if expectedDeficit === 0}
        <div class="hero-num no-data">—</div>
        <div class="caption" style="margin-top:6px">Pas encore de données</div>
      {:else if retard > 0}
        {@const heures = Math.ceil(retard / 500)}
        <div class="hero-num" style="color:var(--c-red)">+{Math.round(retard).toLocaleString('fr')}<span class="hero-unit">kcal</span></div>
        <div class="caption" style="margin-top:6px">≈ {heures}h de vélo à rattraper</div>
      {:else}
        <div class="hero-num" style="color:var(--c-green)">{Math.round(retard).toLocaleString('fr')}<span class="hero-unit">kcal</span></div>
        <div class="caption" style="margin-top:6px">En avance sur le programme</div>
      {/if}
    </div>
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

  <!-- S.O.S Macros -->
  <div class="card sos-card">
    <button class="sos-btn" onclick={runSos} disabled={sosLoading}>
      {sosLoading ? '⏳ Analyse en cours…' : '🆘 S.O.S Macros'}
    </button>
    {#if sosText}
      <div class="coach-out">
        <div class="coach-text">{sosText}</div>
        <button class="coach-close" onclick={() => sosText = ''}>✕ Fermer</button>
      </div>
    {/if}
    {#if sosError}<div class="coach-error">{sosError}</div>{/if}
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
            <span class="food-n">{food.n}</span>
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
  </div>

  <!-- Courbe de poids -->
  {#if weightSeries}
  <div class="card foods-card">
    <div class="foods-header">
      <span class="label">Poids</span>
      <span class="weight-badge">{weightSeries.last.toLocaleString('fr')} kg · moy. 7j {weightSeries.lastAvg.toLocaleString('fr')} kg</span>
    </div>
    <svg viewBox="-4 -6 312 92" class="weight-chart" preserveAspectRatio="none">
      <polyline points={weightSeries.pts} fill="none" stroke="var(--c-border2)" stroke-width="1.5" />
      <polyline points={weightSeries.avgPts} fill="none" stroke="var(--c-accent)" stroke-width="2.5" stroke-linecap="round" />
      <circle cx={weightSeries.lastX} cy={weightSeries.lastY} r="3" fill="var(--c-accent)" />
    </svg>
    <div class="caption" style="margin-top:6px">{weightSeries.n} pesées · {weightSeries.delta <= 0 ? '' : '+'}{weightSeries.delta.toLocaleString('fr')} kg depuis le début · la ligne épaisse = moyenne 7 j (fiable), la fine = pesées brutes</div>
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
      <div class="hist-macros">P {Math.round(day.p)}g · G {Math.round(day.g)}g · L {Math.round(day.l)}g{#if day.deficit !== null} · <span style="font-weight:600;color:{day.neutre ? 'var(--c-blue)' : (day.deficit >= 0 ? 'var(--c-green)' : 'var(--c-red)')}">{day.neutre ? 'neutre' : (day.deficit >= 0 ? 'déficit −' + day.deficit.toLocaleString('fr') : 'surplus +' + Math.abs(day.deficit).toLocaleString('fr'))}</span>{/if}</div>
      {/if}
    </summary>
    <div class="hist-foods">
      {#each day.foods as f, fi}
      <div class="hist-food-row">
        <span class="food-n">{f.n}</span>
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
.food-n { flex:1; font-size:13px; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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

  .sos-card { padding:0; margin-bottom:10px; background:transparent; border:none; }
  .sos-btn { width:100%; border:2px solid var(--c-blue); background:transparent; color:var(--c-blue); border-radius:var(--r-md); padding:16px; font-weight:700; font-size:15px; cursor:pointer; font-family:var(--font); }
  .sos-btn:disabled { opacity:.6; cursor:not-allowed; }
  :global(html[data-theme='light']) .sos-btn { background:#BBEFFF; border-color:#BBEFFF; color:#1a1a1a; }

  .heure-tag { font-size:14px; font-weight:400; color:var(--c-text2); letter-spacing:0; }

.supp-row { display:flex; flex-wrap:wrap; gap:6px; border-top:0.5px solid var(--c-border); margin-top:8px; padding-top:10px; }
.supp-chip { display:flex; align-items:center; gap:5px; border:0.5px solid var(--c-border); background:var(--c-bg); color:var(--c-text2); border-radius:20px; padding:5px 10px; font-size:12px; cursor:pointer; font-family:var(--font); }
.supp-chip.on { background:var(--c-green); border-color:var(--c-green); color:#fff; }
.supp-box { width:14px; height:14px; border-radius:4px; border:1px solid currentColor; display:inline-flex; align-items:center; justify-content:center; font-size:10px; line-height:1; flex-shrink:0; }
.supp-chip.on .supp-box { background:#fff; color:var(--c-green); border-color:#fff; }
</style>
