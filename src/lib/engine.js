// @ts-nocheck
/* FitProX v11 — moteur de dépense dynamique.
   Modèle mesuré (remplace BMR×facteur) : base datée + ajustement poids + thermogénèse adaptative,
   + modèle glycogène/eau pour le "poids ajusté". Tout est causal (le passé ne se réécrit pas
   quand on change un réglage aujourd'hui : chaque jour utilise les réglages EN VIGUEUR ce jour-là). */

export const K_POIDS = 12;        // kcal/j perdus par kg perdu (tissu + coût déplacement)
export const ADAPT_DEFAULT = 0.12;
export const ADAPT_MAX = 0.15;
export const GLYCO_ABSORB = 0.8;
export const GLYCO_STOCK_MAX = 500;
export const GLYCO_STOCK_INIT = 250;
export const KCAL_PER_KG = 7300;  // pour le recalibrage (perte de poids ≈ 7300 kcal/kg)
export const APPORT_FLOOR = 1700;

export function nf(v) { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; }

// "DD/MM/YYYY" -> ms (minuit local)
export function dsToMs(ds) {
  const p = String(ds).split('/').map(Number);
  if (p.length !== 3) return NaN;
  return new Date(p[2], p[1] - 1, p[0], 0, 0, 0, 0).getTime();
}
export function msToDs(ms) {
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

// réglage en vigueur à une date (le plus récent dont from <= jour)
export function settingsFor(settingsLog, t) {
  let best = null;
  for (const s of settingsLog || []) {
    const ft = typeof s.fromT === 'number' ? s.fromT : dsToMs(s.from);
    if (ft <= t && (!best || ft >= best._ft)) best = { ...s, _ft: ft };
  }
  return best || { baseRef: 2020, poidsRef: 97.92, adaptCoef: ADAPT_DEFAULT, _ft: -Infinity };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/* dateList : [{ds, t}] trié ascendant (jours du programme, J1 -> fin).
   info(ds) -> { weight, bf, eaten, gluc, prot, extraKcal, sportKcal, logged }
   Renvoie { list:[record], byKey:{ds:record} }. Chaque record est CAUSAL. */
export function buildTimeline({ dateList, settingsLog, todayTime, dayFrac, info }) {
  // pesées réelles (par valeur), pour la moyenne glissante 7 pesées
  const weighIns = [];
  for (const { ds, t } of dateList) {
    const w = nf(info(ds).weight);
    if (w > 0) weighIns.push({ t, w });
  }
  weighIns.sort((a, b) => a.t - b.t);
  const pm7At = (t) => {
    const upto = weighIns.filter(x => x.t <= t);
    if (!upto.length) return null;
    const last7 = upto.slice(-7);
    return mean(last7.map(x => x.w));
  };

  const recentDef = [];   // déficits réels des 14 derniers jours loggés
  const recentGluc = [];  // glucides des 14 derniers jours loggés
  let stock = GLYCO_STOCK_INIT;
  const list = [];
  const byKey = {};

  for (const { ds, t } of dateList) {
    const di = info(ds);
    const st = settingsFor(settingsLog, t);
    const pm7 = pm7At(t);
    const pm7v = pm7 != null ? pm7 : st.poidsRef;

    // thermogénèse adaptative : sur le déficit moyen des 14 j PRÉCÉDENTS (causal)
    const defAvg14 = mean(recentDef);
    const adaptCoef = clamp(nf(st.adaptCoef) || ADAPT_DEFAULT, 0, ADAPT_MAX);
    const adaptation = Math.round(adaptCoef * Math.max(0, defAvg14));

    const base = st.baseRef - K_POIDS * (st.poidsRef - pm7v) - adaptation;
    const isToday = t === todayTime;
    const isFuture = t > todayTime;
    const frac = isToday ? dayFrac : 1;
    const sportK = nf(di.sportKcal) + nf(di.extraKcal);
    const exp = Math.round(base * frac) + sportK;            // dépense (base prorata aujourd'hui, sport plein)
    const eaten = nf(di.eaten);
    const logged = !!di.logged && !isFuture;
    const deficit = logged ? (exp - eaten) : null;

    // glycogène / eau (seulement sur jours loggés ; sinon on reporte le stock)
    if (logged) {
      const glucoEq = recentGluc.length ? mean(recentGluc) : nf(di.gluc);
      stock = clamp(stock + (nf(di.gluc) - glucoEq) * GLYCO_ABSORB, 0, GLYCO_STOCK_MAX);
    }
    const eauGlyco = Math.round(3 * (stock - GLYCO_STOCK_INIT)); // g
    const poidsAjuste = pm7 != null ? +(pm7 - eauGlyco / 1000).toFixed(2) : null;

    const rec = {
      ds, t, weight: nf(di.weight) || null, bf: nf(di.bf) || null,
      libre: !!di.libre,
      pm7: pm7 != null ? +pm7.toFixed(2) : null,
      base: Math.round(base), adaptation, exp, sportK,
      eaten, gluc: nf(di.gluc), prot: nf(di.prot),
      deficit, logged, isToday, isFuture,
      stock: Math.round(stock), eauGlyco, poidsAjuste,
    };
    list.push(rec); byKey[ds] = rec;

    // alimente les fenêtres glissantes APRÈS calcul (causalité), seulement jours passés loggés complets
    if (logged && !isToday) {
      recentDef.push(deficit); if (recentDef.length > 14) recentDef.shift();
      recentGluc.push(nf(di.gluc)); if (recentGluc.length > 14) recentGluc.shift();
    }
  }
  return { list, byKey };
}

/* Recalibrage mensuel : régression sur les N derniers jours loggés.
   perte_mm7 × 7300 = Σ(base + sport − apport). On résout baseRef mesurée.
   Renvoie { ok, baseRef, poidsRef, days, reason }. Ne s'applique jamais seul. */
export function recalibrate(timeline) {
  const logged = timeline.list.filter(r => r.logged && !r.isToday && r.pm7 != null);
  const window = logged.slice(-28);
  if (window.length < 24) return { ok: false, reason: `Pas assez de jours (${window.length}/24)` };
  const first = window[0], last = window[window.length - 1];
  const perteMM7 = first.pm7 - last.pm7; // kg perdus (mm7)
  // écart glucides début/fin (7 j) < 25 g
  const g0 = mean(window.slice(0, 7).map(r => r.gluc));
  const g1 = mean(window.slice(-7).map(r => r.gluc));
  if (Math.abs(g0 - g1) >= 25) return { ok: false, reason: `Glucides début/fin trop différents (${Math.round(Math.abs(g0 - g1))} g) — reporte de 2-3 j` };
  // Σ(sport − apport) sur la fenêtre ; base résolue : perte×7300 = n·base + Σ(sport−apport)
  const sumSportMinusApport = window.reduce((s, r) => s + (r.sportK - r.eaten), 0);
  const n = window.length;
  const baseRef = Math.round((perteMM7 * KCAL_PER_KG - sumSportMinusApport) / n);
  return { ok: true, baseRef, poidsRef: +last.pm7.toFixed(2), days: n, perteMM7: +perteMM7.toFixed(2) };
}

/* Règle des dimanches. Renvoie { show, kg7, delta, msg } pour le dernier dimanche <= today. */
export function sundayRule(timeline, todayTime) {
  const rec = timeline.list;
  const at = (t) => { const r = rec.find(x => x.t === t); return r && r.pm7 != null ? r.pm7 : null; };
  // dimanches (getDay()===0) <= today avec pm7 dispo
  const sundays = rec.filter(r => new Date(r.t).getDay() === 0 && r.t <= todayTime && r.pm7 != null);
  if (!sundays.length) return { show: false };
  const evalSunday = (r) => {
    const p0 = at(r.t), p3 = at(r.t - 21 * 86400000);
    if (p0 == null || p3 == null) return null;
    const v = (p3 - p0) / 3; // taux de PERTE kg/sem sur 3 semaines (positif = on perd)
    return v;
  };
  const lastS = sundays[sundays.length - 1];
  const v = evalSunday(lastS);
  if (v == null) return { show: false };
  const kg7 = +v.toFixed(2); const kg7s = String(kg7).replace(".", ",");
  if (v > 0.7) return { show: true, kg7, delta: +100, msg: `Perte rapide (${kg7s} kg/sem) — tu peux ajouter +100 kcal.` };
  if (v >= 0.35) return { show: true, kg7, delta: 0, msg: `Rythme idéal (${kg7s} kg/sem) — ne change rien.` };
  // v < 0.35 : suggérer -100 seulement si 2 dimanches consécutifs sous 0.35
  const prevS = sundays.length >= 2 ? sundays[sundays.length - 2] : null;
  const vPrev = prevS ? evalSunday(prevS) : null;
  if (vPrev != null && vPrev < 0.35) return { show: true, kg7, delta: -100, msg: `Perte lente 2 dim. de suite (${kg7s} kg/sem) — envisage −100 kcal (plancher ${APPORT_FLOOR}).` };
  return { show: true, kg7, delta: 0, msg: `Perte lente (${kg7s} kg/sem) — on attend un 2ᵉ dimanche avant d'ajuster.` };
}
