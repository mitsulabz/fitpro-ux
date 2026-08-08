<script lang="ts">
  import { appData, session, persistSession } from './store';
  import { nf } from './calc';
  import { settingsFor, dsToMs, buildTimeline } from './engine';
  import { saveAppState, refreshToken } from './supabase';
  import { get } from 'svelte/store';
  import { onMount, onDestroy } from 'svelte';


  const MOIS: Record<string, number> = {
    janvier:0, février:1, fevrier:1, mars:2, avril:3, mai:4, juin:5,
    juillet:6, août:7, aout:7, septembre:8, octobre:9, novembre:10, décembre:11, decembre:11
  };

  function parseJour(str: string): Date | null {
    if (!str) return null;
    if (str.includes('/')) { const [d, m, y] = str.split('/'); return new Date(+y, +m-1, +d); }
    const parts = str.trim().toLowerCase().split(/\s+/);
    const dayNum = parts.find(p => /^\d+$/.test(p));
    const monthStr = parts.find(p => MOIS[p] !== undefined);
    if (!dayNum || !monthStr) return null;
    return new Date(2026, MOIS[monthStr], +dayNum);
  }

  function dsOf(j: any): string {
    const d = parseJour(j.jour);
    if (!d) return '';
    return d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  const todayDate = new Date(); todayDate.setHours(0,0,0,0);

  const prog     = $derived(($appData as any)?.programme ?? {});
  const progJours= $derived(prog?.jours ?? []);
  const days     = $derived(($appData as any)?.days ?? {});
  const profile  = $derived(($appData as any)?.profile ?? {});
  const acts     = $derived((prog?.activites ?? {}) as Record<string, number>);
  const PROGRAMS = [
    { id: 'chill', label: 'Chill' },
    { id: 'classique', label: 'Classique' },
    { id: 'hardcore', label: 'Hardcore' },
  ];
  const activeProg = $derived((prog?.active as string) ?? 'classique');
  const progSummary = $derived.by(() => {
    const jours: any[] = progJours;
    if (!jours.length) return null;
    const total = jours.reduce((s: number, j: any) => s + (j.deficit ?? 0), 0);
    return { total: Math.round(total), avg: Math.round(total / jours.length), days: jours.length };
  });

  // Preset initial d'un programme jamais ouvert, dérivé de la sélection courante :
  // chill = dimanches en Libre (recup) ; hardcore = aucun jour Libre ; classique = copie.
  function presetSel(id: string, baseSel: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...baseSel };
    if (id === 'chill') {
      Object.keys(out).forEach((ds) => {
        const p = ds.split('/').map(Number);
        if (p.length === 3 && new Date(p[2], p[1]-1, p[0]).getDay() === 0) out[ds] = 'Libre';
      });
    } else if (id === 'hardcore') {
      Object.keys(out).forEach((ds) => { if (out[ds] === 'Libre') out[ds] = ''; });
    }
    return out;
  }

  // Résumé (total deficit + kg) d'une selection donnée, sans toucher aux données
  function summarizeSel(data: any, selMap: Record<string, string>) {
    const curActs = (data.programme?.activites ?? {}) as Record<string, number>;
    const jours: any[] = data.programme?.jours ?? [];
    const base = baseAt(data, nf(data.profile?.weight));
    const minIntake = 1700;
    let total = 0;
    jours.forEach((j: any) => {
      const ds = dsOf(j);
      const value = selMap[ds] ?? selectionFor(data, j, ds);
      if (value === 'Libre') return;
      const tdee = Math.round(base + (value === '' ? 0 : (curActs[value] ?? 0)));
      total += Math.round(Math.min(tdee * 0.25, tdee - minIntake));
    });
    return { total: Math.round(total), kg: +(total / 7700).toFixed(1) };
  }

  // Comparateur : total & kg de chaque programme (stocké, sinon preset dérivé du courant)
  const progCompare = $derived.by(() => {
    const data = $appData as any;
    if (!data?.programme?.jours?.length) return [];
    const jours: any[] = data.programme.jours;
    const curSel: Record<string, string> = {};
    jours.forEach((j: any) => { const ds = dsOf(j); if (ds) curSel[ds] = daySelections[ds] ?? selectionFor(data, j, ds); });
    const stored = (data.programme?.progSel ?? {}) as Record<string, Record<string, string>>;
    return PROGRAMS.map((pg) => {
      const sel = pg.id === activeProg ? curSel : (stored[pg.id] ?? presetSel(pg.id, curSel));
      return { ...pg, ...summarizeSel(data, sel) };
    });
  });
  const progCells = $derived((progCompare.length ? progCompare : PROGRAMS) as any[]);

  function effLog(data: any) {
    const log = data?.programme?.settingsLog;
    if (Array.isArray(log) && log.length) return log;
    let from = '16/06/2026', minT = Infinity;
    for (const k of Object.keys(data?.days ?? {})) { const t = dsToMs(k); if (!isNaN(t) && t < minT) { minT = t; from = k; } }
    return [{ from, baseRef: 2020, poidsRef: 97.92, adaptCoef: 0.12 }];
  }
  function baseAt(data: any, weight: number) {
    const st: any = settingsFor(effLog(data), todayDate.getTime());
    return st.baseRef - 12 * (st.poidsRef - (weight || st.poidsRef));
  }
  const baseLive = $derived(baseAt($appData as any, nf(profile.weight)));
  const minIntakeLive = $derived(1700);
  const timeline = $derived.by(() => {
    const data = $appData as any;
    const A = (data?.programme?.activites ?? {}) as Record<string, number>;
    const jByDs: any = {}; const dateList: any[] = [];
    for (const j of progJours) { const jd = parseJour(j.jour); if (!jd) continue; jd.setHours(0,0,0,0); const ds = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }); jByDs[ds] = j; dateList.push({ ds, t: jd.getTime() }); }
    dateList.sort((a: any,b: any)=>a.t-b.t);
    const info = (ds: string) => {
      const dd = (days as any)[ds] ?? {}; const j = jByDs[ds]; const fds = dd.foods ?? [];
      const sel = daySelections[ds] ?? selectionFor(data, j, ds);
      const sportKcal = (sel && sel !== 'Libre') ? (A[sel] ?? 0) : 0;
      return { weight: nf(dd.weight), bf: nf(dd.bf), eaten: fds.reduce((s: number,f: any)=>s+(f.k||0),0), gluc: fds.reduce((s: number,f: any)=>s+(f.g||0),0), prot: fds.reduce((s: number,f: any)=>s+(f.p||0),0), extraKcal: dd.extraKcal ?? 0, sportKcal, libre: sel === 'Libre', logged: fds.length > 0 };
    };
    return buildTimeline({ dateList, settingsLog: effLog(data), todayTime: todayDate.getTime(), dayFrac: 1, info });
  });
  // Projection poids + MG au dernier jour : historique reel (passe loggé) + cibles du programme (futur)
  const endProj = $derived.by(() => {
    if (progJours.length === 0) return null;
    const data = $appData as any;
    const dd = data?.days ?? {};
    // pesées mesurées (poids + %MG) — même base que la projection du Suivi
    const meas: any[] = [];
    for (const k of Object.keys(dd)) {
      const d: any = dd[k]; const w = nf(d?.weight), bf = nf(d?.bf);
      if (w > 0 && bf > 0) { const pr = k.split('/').map(Number); if (pr.length === 3) meas.push({ t: new Date(pr[2], pr[1]-1, pr[0]).getTime(), w, bf, fat: w * bf / 100 }); }
    }
    meas.sort((a, b) => a.t - b.t);
    if (meas.length < 1) return null;
    const start = meas[0], now = meas[meas.length - 1];
    const fatLostKg = start.fat - now.fat;
    // futFrac = déficit programme restant / réalisé
    let done = 0, total = 0;
    for (const r of (timeline as any).list) {
      const dayExp = r.base + r.sportK;
      const cible = r.libre ? 0 : Math.max(0, Math.round(Math.min(dayExp * 0.25, dayExp - 1700)));
      total += cible;
      if (!r.isFuture && r.deficit != null) done += cible;
    }
    const futFrac = done > 0 ? Math.max(0, (total - done) / done) : 0;
    const futFatKg = Math.max(0, fatLostKg) * futFrac;
    const endW = now.w - futFatKg;
    const endFat = now.fat - futFatKg;
    const endBf = endW > 0 ? Math.max(0, endFat / endW * 100) : now.bf;
    const totFatKg = start.fat - endFat;
    const last = progJours[progJours.length - 1];
    const endD = last ? parseJour(last.jour) : null;
    const endStr = endD ? endD.toLocaleDateString('fr-FR', { day:'numeric', month:'short', year:'numeric' }) : '—';
    return { endStr, kg: endW.toFixed(1), bf: endBf.toFixed(1), lost: totFatKg.toFixed(1) };
  });
  const totalDays  = $derived(progJours.length);
  const progIdx    = $derived(progJours.findIndex((j: any) => {
    const d = parseJour(j.jour); if (!d) return false;
    d.setHours(0,0,0,0); return d.getTime() === todayDate.getTime();
  }));
  const dayNum = $derived(progIdx >= 0 ? progIdx + 1 : null);

  // Local editable state for activities (loaded once on mount, managed locally after)
  let actEntries = $state<{ name: string; kcal: number }[]>([]);
  let newActName = $state('');
  let newActKcal = $state('');

  // Per-day selection state: ds → selected value ('' = sans sport, 'Libre', or activity name)
  let daySelections = $state<Record<string, string>>({});

  // Source de verite : determine l'activite d'un jour depuis la donnee persistee
  function selectionFor(data: any, j: any, ds: string): string {
    if (typeof j?.activity === 'string') return j.activity; // champ explicite = source de verite
    const d = (data?.days ?? {})[ds];
    if (d?.progActivity === false) return '';
    if (d?.progActivity?.name) return d.progActivity.name;
    const t = j.type ?? '';
    if (/libre/i.test(t)) return 'Libre';
    const actNames = new Set(Object.keys(data?.programme?.activites ?? {}));
    return actNames.has(t) ? t : '';
  }

  function initDaySelections(data: any) {
    const jours: any[] = data?.programme?.jours ?? [];
    const sel: Record<string, string> = {};
    jours.forEach((j: any) => {
      const ds = dsOf(j);
      if (!ds) return;
      sel[ds] = selectionFor(data, j, ds);
    });
    daySelections = sel;
  }

  onMount(() => {
    const data = get(appData) as any;
    const a = { ...(data?.programme?.activites ?? {}) };
    // Activites par defaut, semees une seule fois (restent editables/supprimables ensuite)
    let changed = false;
    if (!data?.programme?._seededDefaults) {
      if (!('Compétition' in a)) { a['Compétition'] = 3500; changed = true; }
      if (!('Autre' in a)) { a['Autre'] = 0; changed = true; }
    }
    // v2 : ajoute Muscu une fois
    if (!data?.programme?._seededV2) {
      if (!('Muscu' in a)) { a['Muscu'] = 250; changed = true; }
    }
    // v3 : activites combinees muscu + velo elliptique
    if (!data?.programme?._seededV3) {
      if (!('Muscu + vélo 30mn' in a)) { a['Muscu + vélo 30mn'] = 500; changed = true; }
      if (!('Muscu + vélo 45mn' in a)) { a['Muscu + vélo 45mn'] = 625; changed = true; }
      if (!('Muscu + vélo 1h' in a)) { a['Muscu + vélo 1h'] = 750; changed = true; }
    }
    actEntries = Object.entries(a).map(([name, kcal]) => ({ name, kcal: kcal as number }));
    initDaySelections(data);
    if (changed || !data?.programme?._seededDefaults || !data?.programme?._seededV2 || !data?.programme?._seededV3) {
      persist({ ...data, programme: { ...(data.programme ?? {}), activites: a, _seededDefaults: true, _seededV2: true, _seededV3: true } });
    }
  });

  async function persist(newData: any) {
    const s = get(session);
    if (!s) return;
    appData.set(newData); // update UI immediately, before any network await
    let token = s.access_token;
    try { const fresh = await refreshToken(s.refresh_token); persistSession(fresh); token = fresh.access_token; } catch {}
    saveAppState(token, s.user.id, newData);
  }

  async function flushActivities(entries: { name: string; kcal: number }[]) {
    const data = get(appData) as any;
    const newActs: Record<string, number> = {};
    entries.forEach(e => { if (e.name.trim()) newActs[e.name.trim()] = e.kcal; });
    await persist({ ...data, programme: { ...data.programme, activites: newActs } });
  }

  async function addActivity() {
    if (!newActName.trim()) return;
    const next = [...actEntries, { name: newActName.trim(), kcal: parseInt(newActKcal) || 0 }];
    actEntries = next;
    newActName = ''; newActKcal = '';
    await flushActivities(next);
  }

  async function removeActivity(i: number) {
    const next = actEntries.filter((_, idx) => idx !== i);
    actEntries = next;
    await flushActivities(next);
  }

  async function saveKcal(i: number, val: string) {
    actEntries[i] = { ...actEntries[i], kcal: parseInt(val) || 0 };
    await flushActivities(actEntries);
  }

  // BMR + TDEE helpers (mirror FitPro logic)
  // Parse tolerant a la virgule francaise (32,9 -> 32.9)


  // Edition LOCALE uniquement : on memorise le choix. Le calcul + la sauvegarde se font au clic "Recalculer".
  function setDaySelection(ds: string, value: string) {
    daySelections = { ...daySelections, [ds]: value };
  }

  // Applique les choix (daySelections) + recalcule tous les jours + sauvegarde, EN UNE FOIS
  async function recalcAll() {
    const data = get(appData) as any;
    const jours: any[] = data.programme?.jours ?? [];
    // selection effective : choix en attente, sinon etat courant
    const selMap: Record<string, string> = {};
    jours.forEach((j: any) => { const ds = dsOf(j); if (ds) selMap[ds] = daySelections[ds] ?? selectionFor(data, j, ds); });
    const { newDays, newJours } = computeProgram(data, selMap);
    const active = (data.programme?.active as string) ?? 'classique';
    const progSel = { ...(data.programme?.progSel ?? {}), [active]: selMap };
    const newData = { ...data, days: newDays, programme: { ...data.programme, jours: newJours, progSel } };
    // MAJ UI synchrone (en 1 clic), sauvegarde reseau en arriere-plan
    appData.set(newData);
    saveStatus = '✓ Enregistré';
    const s = get(session);
    if (s) {
      refreshToken(s.refresh_token)
        .then((fresh) => { persistSession(fresh); saveAppState(fresh.access_token, s.user.id, newData); })
        .catch(() => saveAppState(s.access_token, s.user.id, newData));
    }
  }

  // Recalcule jours + days pour une selection donnée (sans sauvegarde)
  function computeProgram(data: any, selMap: Record<string, string>) {
    const curActs = (data.programme?.activites ?? {}) as Record<string, number>;
    const jours: any[] = data.programme?.jours ?? [];
    const base = baseAt(data, nf(data.profile?.weight));
    const minIntake = 1700;
    const newDays = { ...(data.days ?? {}) };
    const newJours = jours.map((j: any) => {
      const ds = dsOf(j);
      const value = selMap[ds] ?? selectionFor(data, j, ds);
      const progAct = value === '' ? false : { name: value, kcal: value === 'Libre' ? 0 : (curActs[value] ?? 0) };
      newDays[ds] = { ...(newDays[ds] ?? {}), progActivity: progAct };
      if (value === 'Libre') {
        const brulees = Math.round(base);
        return { ...j, activity: 'Libre', type: 'Libre — journée neutre', deficit: 0, calories: brulees, calories_brulees: brulees };
      }
      const sportKcal = value === '' ? 0 : (curActs[value] ?? 0);
      const tdee = Math.round(base + sportKcal);
      const deficit = Math.round(Math.min(tdee * 0.25, tdee - minIntake));
      const calories = tdee - deficit;
      return { ...j, activity: value, type: value || j.type, calories_brulees: tdee, deficit, calories };
    });
    return { newDays, newJours };
  }

  // Bascule entre les 3 programmes (chill / classique / hardcore)
  async function selectProgram(id: string) {
    if (id === activeProg) return;
    clearTimeout(_saveTimer);
    const data = get(appData) as any;
    const jours: any[] = data.programme?.jours ?? [];
    // 1. fige la selection courante (choix en attente sinon etat des jours)
    const curSel: Record<string, string> = {};
    jours.forEach((j: any) => { const ds = dsOf(j); if (ds) curSel[ds] = daySelections[ds] ?? selectionFor(data, j, ds); });
    const progSel = { ...(data.programme?.progSel ?? {}), [activeProg]: curSel };
    // 2. selection cible : celle du programme demandé, sinon clone du courant
    const targetSel: Record<string, string> = progSel[id] ?? presetSel(id, curSel);
    // 3. recompute pour la cible
    const { newDays, newJours } = computeProgram(data, targetSel);
    const finalProgSel = { ...progSel, [id]: targetSel };
    const newData = { ...data, days: newDays, programme: { ...data.programme, jours: newJours, progSel: finalProgSel, active: id } };
    // une seule ecriture synchrone + sauvegarde SANS persistSession (sinon rechargement cloud qui ecrase)
    appData.set(newData);
    _suppressSave = true;
    daySelections = { ...targetSel };
    saveStatus = '✓ Enregistré';
    const s = get(session);
    if (s) {
      let token = s.access_token;
      try { const fresh = await refreshToken(s.refresh_token); token = fresh.access_token; } catch {}
      saveAppState(token, s.user.id, newData);
    }
  }

  // Enregistrement automatique (debounce) quand les choix changent
  let saveStatus = $state('');
  let _firstSave = true;
  let _suppressSave = false;
  let _saveTimer: any;
  $effect(() => {
    JSON.stringify(daySelections); // dependance reactive
    if (_firstSave) { _firstSave = false; return; }
    if (_suppressSave) { _suppressSave = false; return; }
    clearTimeout(_saveTimer);
    saveStatus = 'Enregistrement…';
    _saveTimer = setTimeout(() => recalcAll(), 1000);
  });
  // En quittant l'onglet : on force la sauvegarde si une modif est en attente
  onDestroy(() => { if (_saveTimer) { clearTimeout(_saveTimer); recalcAll(); } });

  function isToday(j: any) { const d=parseJour(j.jour); if(!d)return false; d.setHours(0,0,0,0); return d.getTime()===todayDate.getTime(); }
  function isPast(j: any)  { const d=parseJour(j.jour); if(!d)return false; d.setHours(0,0,0,0); return d.getTime()<todayDate.getTime(); }
  function getEaten(j: any): number {
    const ds = dsOf(j); const dayData = (days as any)[ds] ?? {};
    return (dayData.foods ?? []).reduce((s: number, f: any) => s + (f.k||0), 0);
  }
  function typeColor(type: string): string {
    if (/libre/i.test(type??'')) return 'var(--c-blue)';
    if (/repos/i.test(type??'')) return 'var(--c-text3)';
    return 'var(--c-accent)';
  }
</script>

<div class="scroll-area">
  {#if endProj}
  <div class="proj-sticky">
    <div class="section-card proj-card">
      <div class="section-title" style="margin-top:0">Objectif au {endProj.endStr}</div>
      <div class="proj-row">
        <div class="proj-item"><div class="proj-val">{endProj.kg} kg</div><div class="proj-lbl">Poids estimé</div></div>
        <div class="proj-item"><div class="proj-val">{endProj.bf}%</div><div class="proj-lbl">Masse grasse</div></div>
      </div>
      <div class="caption proj-sub">−{endProj.lost} kg de gras · historique réel + cibles du programme</div>
      {#if progSummary}
        <div class="caption proj-sub proj-sum">{progSummary.total.toLocaleString('fr')} kcal brûlées au total · déficit moyen {progSummary.avg.toLocaleString('fr')} kcal/j</div>
      {/if}
      <div class="prog-switch">
        {#each progCells as pg}
          <button class="prog-cell" class:active={activeProg === pg.id} onclick={() => selectProgram(pg.id)}>
            <span class="prog-cell-name">{pg.label}</span>
            {#if 'kg' in pg}<span class="prog-cell-kg">−{pg.kg.toLocaleString('fr')} kg</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
  {/if}


  <!-- Activités du programme -->
  <div class="section-card">
    <div class="section-title">Activités du programme</div>
    <p class="section-hint">Ajuste les calories brûlées par activité. Ces valeurs s'appliquent à tous les jours correspondants.</p>

    {#each actEntries as entry, i}
      <div class="act-row">
        <span class="act-name">{entry.name}</span>
        <input class="act-kcal" type="number" min="0" step="10"
          value={entry.kcal}
          onblur={(e) => saveKcal(i, (e.target as HTMLInputElement).value)}
        />
        <span class="act-unit">kcal</span>
        <button class="act-del" onclick={() => removeActivity(i)} aria-label="Supprimer">✕</button>
      </div>
    {/each}

    <!-- Ajouter activité -->
    <div class="act-add-row">
      <input class="act-name-inp" type="text" placeholder="Nouvelle activité" bind:value={newActName} />
      <input class="act-kcal" type="number" min="0" step="10" placeholder="0" bind:value={newActKcal} />
      <span class="act-unit">kcal</span>
      <button class="act-add-btn" onclick={addActivity} disabled={!newActName.trim()}>+</button>
    </div>
  </div>

  <!-- Liste des jours -->
  {#if progJours.length === 0}
    <div class="empty">Aucun programme chargé</div>
  {:else}
    <div class="jours-head">
      <span class="section-title-flat">Jours du programme</span>
      {#if saveStatus}<span class="save-status">{saveStatus}</span>{/if}
    </div>
    <div class="jour-list">
      {#each progJours as j, i}
      {@const ds = dsOf(j)}
      {@const eaten = getEaten(j)}
      {@const today = isToday(j)}
      {@const past = isPast(j)}
      {@const sel = daySelections[ds] ?? ''}
      {@const sportK = (sel && sel !== 'Libre') ? (acts[sel] ?? 0) : 0}
      {@const rec = (timeline.byKey as any)[ds]}
      {@const dep = rec ? rec.exp : Math.round(baseLive + sportK)}
      {@const cibleLive = sel === 'Libre' ? 0 : Math.max(0, Math.round(Math.min(dep * 0.25, dep - minIntakeLive)))}
      {@const intakeLive = sel === 'Libre' ? dep : dep - cibleLive}
      {@const realDef = rec && rec.deficit != null ? rec.deficit : (dep - eaten)}
      <div class="jour-card" class:today class:past>
        <div class="jour-num">{i + 1}</div>
        <div class="jour-info">
          <div class="jour-name">{j.jour}</div>
          <!-- Sélecteur activité du jour -->
          <select class="jour-act-sel"
            value={daySelections[ds] ?? ''}
            onchange={(e) => setDaySelection(ds, (e.target as HTMLSelectElement).value)}
          >
            <option value="">Régime sans sport</option>
            <option value="Libre">Libre — journée neutre</option>
            {#each actEntries as a}
              <option value={a.name}>{a.name}</option>
            {/each}
          </select>
        </div>
        <div class="jour-right">
          {#if today}
            <div class="jour-tag">aujourd'hui</div>
            <div class="jour-metric"><span class="jm-lbl">dépense</span> {dep.toLocaleString('fr')}<span class="jm-u"> kcal</span></div>
          {:else if past && eaten > 0}
            <div class="jour-metric">
              <span class="jm-lbl">mangé</span>
              <span style="color:{eaten <= intakeLive ? 'var(--c-green)' : 'var(--c-red)'}">{Math.round(eaten).toLocaleString('fr')}<span class="jm-u"> kcal</span></span>
            </div>
          {:else if past}
            <div class="jour-metric"><span class="jm-lbl">mangé</span> <span class="muted">—</span></div>
          {:else}
            <div class="jour-metric"><span class="jm-lbl">dépense</span> {dep.toLocaleString('fr')}<span class="jm-u"> kcal</span></div>
          {/if}
          {#if past && eaten > 0}
            <div class="jour-def caption" style="color:{realDef >= 0 ? 'var(--c-green)' : 'var(--c-red)'}">
              {realDef >= 0 ? 'déficit réel −' + Math.round(realDef).toLocaleString('fr') : 'surplus +' + Math.round(-realDef).toLocaleString('fr')}
            </div>
          {:else if sel === 'Libre'}
            <div class="jour-def caption" style="color:var(--c-blue)">journée neutre</div>
          {:else}
            <div class="jour-def caption" style="color:{typeColor(j.type ?? '')}">cible −{cibleLive.toLocaleString('fr')}</div>
          {/if}
        </div>
      </div>
      {/each}
    </div>
  {/if}
</div>

<style>
.pheader { display:flex; align-items:center; justify-content:space-between; padding:20px 0 14px; }
.ptitle { font-size:14px; color:var(--c-text2); margin-top:3px; }
.day-badge { font-size:13px; font-weight:600; color:var(--c-text2); flex-shrink:0; }
.day-badge span { font-weight:400; color:var(--c-text3); }

.section-card { background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-lg); padding:16px; margin-bottom:10px; display:flex; flex-direction:column; gap:10px; }
.section-title { font-size:14px; font-weight:600; color:var(--c-text); }
.section-title-flat { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); margin:8px 0 8px; }
.section-hint { font-size:13px; color:var(--c-text2); margin:0; }

.proj-sum { font-weight:600; color:var(--c-text); margin-top:2px; }
.prog-switch { display:flex; gap:6px; margin-top:12px; }
.prog-cell { display:flex; flex-direction:column; gap:2px; align-items:center; flex:1; padding:8px 4px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-bg); color:var(--c-text2); font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font); transition:background .15s, color .15s; }
.prog-cell.active { background:var(--c-accent); color:var(--c-accent-fg); border-color:var(--c-accent); }
.prog-cell-name { font-size:12px; font-weight:600; }
.prog-cell-kg { font-size:10px; font-weight:500; opacity:.75; }
.act-select { width:100%; padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-bg); color:var(--c-text); font-size:13px; font-family:var(--font); }
.act-select:focus { outline:none; border-color:var(--c-accent); }

.act-row { display:flex; align-items:center; gap:8px; }
.act-name { flex:1; font-size:13px; color:var(--c-text); }
.act-kcal { width:80px; padding:6px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:13px; text-align:right; font-family:var(--font); }
.act-kcal:focus { outline:none; border-color:var(--c-accent); }
.act-unit { font-size:12px; color:var(--c-text3); flex-shrink:0; }
.act-del { border:none; background:none; color:var(--c-text3); cursor:pointer; font-size:14px; padding:4px; flex-shrink:0; }
.act-del:hover { color:var(--c-red, #e05); }

.act-add-row { display:flex; align-items:center; gap:8px; padding-top:4px; border-top:0.5px solid var(--c-border); }
.act-name-inp { flex:1; padding:7px 10px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:13px; font-family:var(--font); }
.act-name-inp:focus { outline:none; border-color:var(--c-accent); }
.act-add-btn { width:30px; height:30px; border:none; border-radius:50%; background:var(--c-accent); color:var(--c-accent-fg); font-size:20px; font-weight:300; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.act-add-btn:disabled { opacity:.4; cursor:not-allowed; }


.empty { text-align:center; padding:60px 0; color:var(--c-text3); font-size:14px; }
.jour-list { display:flex; flex-direction:column; gap:6px; padding-bottom:20px; }
.jour-card { background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); padding:10px 12px; display:flex; align-items:center; gap:10px; }
.jour-card.today { border-color:var(--c-accent); }
.jour-card.past { opacity:0.7; }

.jour-num { font-size:11px; font-weight:600; color:var(--c-text3); min-width:22px; }
.jour-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.jour-name { font-size:12px; font-weight:500; color:var(--c-text); text-transform:capitalize; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.jour-act-sel { width:100%; padding:4px 6px; border:1px solid var(--c-border); border-radius:6px; background:var(--c-bg); color:var(--c-text); font-size:11px; font-family:var(--font); }
.jour-act-sel:focus { outline:none; border-color:var(--c-accent); }

.jour-right { text-align:right; flex-shrink:0; min-width:70px; }
.jour-cible { font-size:12px; font-weight:500; color:var(--c-text2); }
.jour-cible span { font-size:10px; color:var(--c-text3); }
.muted { color:var(--c-text3) !important; }
.jour-def { font-size:10px; margin-top:2px; }
.jour-tag { background:var(--c-accent); color:var(--c-accent-fg); border-radius:6px; padding:2px 7px; font-size:10px; font-weight:600; }

  .jours-head { display:flex; align-items:center; justify-content:space-between; }

  .jour-metric { font-size:14px; font-weight:700; color:var(--c-text); text-align:right; }
  .jm-lbl { font-size:9px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); margin-right:3px; }
  .jm-u { font-size:11px; font-weight:400; color:var(--c-text3); }

  .proj-card { background:var(--c-surface); }
  .proj-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0 6px; }
  .proj-item { text-align:center; padding:10px; background:var(--c-surface2); border-radius:var(--r-md); }
  .proj-val { font-size:24px; font-weight:700; color:var(--c-accent); letter-spacing:-0.5px; }
  .proj-lbl { font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--c-text3); margin-top:2px; }
  .proj-sub { text-align:center; }

  .save-status { font-size:12px; font-weight:600; color:var(--c-text3); }

  .proj-sticky { position:sticky; top:env(safe-area-inset-top, 0px); z-index:10; background:var(--c-bg); padding:8px 0 10px; }
  .proj-sticky .proj-card { margin-bottom:0; }
</style>
