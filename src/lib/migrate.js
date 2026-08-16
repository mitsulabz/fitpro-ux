// @ts-nocheck
/* Migration V13 : le sport estimé par le Programme (activités à valeurs fixes)
   est converti une seule fois en kcal réelles dans day.extraKcal (champ « Sport cal »).
   Réplique exactement la résolution de l'ancienne timeline (j.activity prioritaire,
   puis day.progActivity, puis j.type ; kcal via la table programme.activites) pour
   que l'historique des déficits soit identique avant/après. Les jours « Libre »
   sont figés via day.libre. Idempotente grâce au flag _sportV13. */

const MOIS = {
  janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11,
};

function parseJour(str) {
  if (!str) return null;
  if (String(str).includes('/')) {
    const [d, m, y] = String(str).split('/');
    return new Date(+y, +m - 1, +d);
  }
  const parts = String(str).trim().toLowerCase().split(/\s+/);
  const dayNum = parts.find((p) => /^\d+$/.test(p));
  const monthStr = parts.find((p) => MOIS[p] !== undefined);
  if (!dayNum || !monthStr) return null;
  return new Date(2026, MOIS[monthStr], +dayNum);
}

export function migrateSportV13(data) {
  if (!data || data._sportV13) return { data, changed: false };
  const prog = data.programme ?? {};
  const acts = prog.activites ?? {};
  const jours = Array.isArray(prog.jours) ? prog.jours : [];
  const jByDs = {};
  for (const j of jours) {
    const d = parseJour(j?.jour);
    if (!d) continue;
    d.setHours(0, 0, 0, 0);
    jByDs[d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })] = j;
  }
  const days = data.days ?? {};
  const newDays = { ...days };
  let changed = false;
  for (const ds of Object.keys(days)) {
    const dd = days[ds] ?? {};
    const j = jByDs[ds];
    let act = '';
    if (typeof j?.activity === 'string') act = j.activity;
    else if (dd.progActivity === false) act = '';
    else if (dd.progActivity?.name) act = dd.progActivity.name;
    else {
      const ty = j?.type ?? '';
      act = /libre/i.test(ty) ? 'Libre' : ty;
    }
    const libre = act === 'Libre';
    const num = (x) => parseFloat(String(x ?? '').replace(',', '.')) || 0;
    const sport = (act && !libre) ? num(acts[act]) : 0;
    const extra = num(dd.extraKcal);
    const total = Math.round(sport + extra);
    const nd = { ...dd };
    if (total > 0 || dd.extraKcal !== undefined) nd.extraKcal = total;
    if (libre) nd.libre = true;
    if (nd.extraKcal !== dd.extraKcal || !!nd.libre !== !!dd.libre) changed = true;
    newDays[ds] = nd;
  }
  // Le flag _sportV13 reste en mémoire même sans changement ; il sera persisté
  // par la prochaine sauvegarde naturelle. On n'écrit immédiatement que si un
  // jour a réellement été modifié (évite une écriture cloud gratuite).
  return { data: { ...data, days: newDays, _sportV13: true }, changed };
}

/* V13.1 : le J1 passe au 22/06/2026 — la compétition du 20/06 (dépense non
   mesurable, pesées manquantes) polluait le bilan énergétique. Purge one-shot
   de tous les jours antérieurs au 22/06 (sauvegardés dans les exports de
   l'utilisateur). Idempotente via le flag _trimJ1_2206. */
export function trimPreJ1(data) {
  if (!data || data._trimJ1_2206) return { data, changed: false };
  const J1 = new Date(2026, 5, 22).getTime();
  const days = data.days ?? {};
  const newDays = {};
  let changed = false;
  for (const ds of Object.keys(days)) {
    const p = String(ds).split('/').map(Number);
    const t = p.length === 3 ? new Date(p[2], p[1] - 1, p[0]).getTime() : NaN;
    if (!isNaN(t) && t < J1) { changed = true; continue; }
    newDays[ds] = days[ds];
  }
  return { data: { ...data, days: newDays, _trimJ1_2206: true }, changed };
}
