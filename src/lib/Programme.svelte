<script lang="ts">
  import { appData, session, persistSession } from './store';
  import { saveAppState, refreshToken } from './supabase';
  import { get } from 'svelte/store';
  import { onMount, onDestroy } from 'svelte';

  const ACT_LEVELS = [
    { key:'1.10', label:'Bloqué au lit',                    desc:'×1.10 · maladie, < 2 000 pas/j' },
    { key:'1.20', label:'Canap / bureau / voiture',         desc:'×1.20 · très sédentaire · 2–4k pas/j' },
    { key:'1.30', label:'Courses, tâches ménagères légères',desc:'×1.30 · bouge un peu · 4–6k pas/j' },
    { key:'1.40', label:"S'active quotidiennement",         desc:'×1.40 · beaucoup de déplacements · 6–9k pas/j' },
    { key:'1.50', label:'Travail debout / bouge tout le temps', desc:'×1.50 · marche régulière · 9–12k pas/j' },
    { key:'1.60', label:'Métier physique léger',            desc:'×1.60 · très actif · >12k pas/j' },
    { key:'1.75', label:'Métier physique dur',              desc:'×1.75 · artisan, manutention, serveur actif' },
    { key:'2.00', label:"Bouge autant qu'un sportif pro",   desc:'×2.00 · agriculture, chantier, sport pro' },
  ];

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

  const currentAct = $derived(profile?.act ?? '1.30');
  const bmrLive = $derived(calcBMR(profile));
  const minIntakeLive = $derived(Math.max(Math.round(bmrLive), profile.sex === 'f' ? 1200 : 1500));
  // Projection poids + MG au dernier jour : historique reel (passe loggé) + cibles du programme (futur)
  const endProj = $derived.by(() => {
    const data = $appData as any;
    const w = nf(profile.weight), bf = nf(profile.bf);
    if (!w || !bf || progJours.length === 0) return null;
    const bmr = calcBMR(profile);
    const actF = nf(profile.act) || 1.4;
    const sexFloor = profile.sex === 'f' ? 1200 : 1500;
    const minIntake = Math.max(Math.round(bmr), sexFloor);
    let totalDef = 0;
    progJours.forEach((j: any) => {
      const jd = parseJour(j.jour); if (!jd) return;
      const ds = jd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      const act = daySelections[ds] ?? selectionFor(data, j, ds);
      const sportK = (act && act !== 'Libre') ? (acts[act] ?? 0) : 0;
      const tdee = Math.round(bmr * actF + sportK);
      const cible = act === 'Libre' ? 0 : Math.round(Math.min(tdee * 0.25, tdee - minIntake));
      const dd = (data?.days ?? {})[ds] ?? {};
      const eaten = (dd.foods ?? []).reduce((s: number, f: any) => s + (f.k||0), 0);
      const jd0 = new Date(jd); jd0.setHours(0,0,0,0);
      if (jd0 < todayDate && eaten > 0) totalDef += (tdee + (dd.extraKcal ?? 0)) - eaten; // reel passe
      else totalDef += cible; // cible programme (aujourd'hui + futur + passe non loggé)
    });
    const fatKg = Math.max(0, totalDef) / 7700;
    const fatInit = w * bf / 100;
    const endW = w - fatKg;
    const endBf = endW > 0 ? (fatInit - fatKg) / endW * 100 : bf;
    const last = progJours[progJours.length - 1];
    const endD = last ? parseJour(last.jour) : null;
    const endStr = endD ? endD.toLocaleDateString('fr-FR', { day:'numeric', month:'short', year:'numeric' }) : '—';
    return { endStr, kg: endW.toFixed(1), bf: endBf.toFixed(1), lost: fatKg.toFixed(1) };
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

  async function saveActLevel(key: string) {
    const data = get(appData) as any;
    await persist({ ...data, profile: { ...data.profile, act: key } });
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
  function nf(v: any): number { return parseFloat(String(v ?? '').replace(',', '.')) || 0; }

  function calcBMR(p: any): number {
    const w = nf(p.weight) || 100, h = nf(p.height) || 180, age = nf(p.age) || 40;
    const bf = nf(p.bf);
    if (bf > 0) return 370 + 21.6 * w * (1 - bf / 100);
    const sex = p.sex === 'f' ? -161 : 5;
    return 10 * w + 6.25 * h - 5 * age + sex;
  }

  function calcTDEE(bmr: number, actKey: string, sportKcal: number): number {
    return bmr * (nf(actKey) || 1.4) + sportKcal;
  }

  // Edition LOCALE uniquement : on memorise le choix. Le calcul + la sauvegarde se font au clic "Recalculer".
  function setDaySelection(ds: string, value: string) {
    daySelections = { ...daySelections, [ds]: value };
  }

  // Applique les choix (daySelections) + recalcule tous les jours + sauvegarde, EN UNE FOIS
  async function recalcAll() {
    const data = get(appData) as any;
    const curActs = (data.programme?.activites ?? {}) as Record<string, number>;
    const jours: any[] = data.programme?.jours ?? [];
    const bmr = calcBMR(data.profile ?? {});
    const actKey = data.profile?.act ?? '1.40';
    const sexFloor = (data.profile?.sex === 'f') ? 1200 : 1500;
    const minIntake = Math.max(Math.round(bmr), sexFloor);
    const newDays = { ...(data.days ?? {}) };
    const newJours = jours.map((j: any) => {
      const ds = dsOf(j);
      const value = daySelections[ds] ?? selectionFor(data, j, ds); // choix en attente, sinon etat courant
      // applique le choix sur le jour (progActivity = source de verite)
      const progAct = value === '' ? false : { name: value, kcal: value === 'Libre' ? 0 : (curActs[value] ?? 0) };
      newDays[ds] = { ...(newDays[ds] ?? {}), progActivity: progAct };
      if (value === 'Libre') {
        const brulees = Math.round(calcTDEE(bmr, actKey, 0));
        return { ...j, activity: 'Libre', type: 'Libre — journée neutre', deficit: 0, calories: brulees, calories_brulees: brulees };
      }
      const sportKcal = value === '' ? 0 : (curActs[value] ?? 0);
      const tdee = Math.round(calcTDEE(bmr, actKey, sportKcal));
      const deficit = Math.round(Math.min(tdee * 0.25, tdee - minIntake));
      const calories = tdee - deficit;
      return { ...j, activity: value, type: value || j.type, calories_brulees: tdee, deficit, calories };
    });
    // sauvegarde la selection d'activite par jour pour le programme actif
    const selMap: Record<string, string> = {};
    jours.forEach((j: any) => { const ds = dsOf(j); if (ds) selMap[ds] = daySelections[ds] ?? selectionFor(data, j, ds); });
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
    const bmr = calcBMR(data.profile ?? {});
    const actKey = data.profile?.act ?? '1.40';
    const sexFloor = (data.profile?.sex === 'f') ? 1200 : 1500;
    const minIntake = Math.max(Math.round(bmr), sexFloor);
    const newDays = { ...(data.days ?? {}) };
    const newJours = jours.map((j: any) => {
      const ds = dsOf(j);
      const value = selMap[ds] ?? selectionFor(data, j, ds);
      const progAct = value === '' ? false : { name: value, kcal: value === 'Libre' ? 0 : (curActs[value] ?? 0) };
      newDays[ds] = { ...(newDays[ds] ?? {}), progActivity: progAct };
      if (value === 'Libre') {
        const brulees = Math.round(calcTDEE(bmr, actKey, 0));
        return { ...j, activity: 'Libre', type: 'Libre — journée neutre', deficit: 0, calories: brulees, calories_brulees: brulees };
      }
      const sportKcal = value === '' ? 0 : (curActs[value] ?? 0);
      const tdee = Math.round(calcTDEE(bmr, actKey, sportKcal));
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
    const targetSel: Record<string, string> = progSel[id] ?? { ...curSel };
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
        {#each PROGRAMS as pg}
          <button class="prog-cell" class:active={activeProg === pg.id} onclick={() => selectProgram(pg.id)}>{pg.label}</button>
        {/each}
      </div>
    </div>
  </div>
  {/if}

  <!-- Niveau d'activité de base -->
  <div class="section-card">
    <div class="section-title">Niveau d'activité de base</div>
    <p class="section-hint">Ton métabolisme hors sport, utilisé pour les jours sans activité dans le programme.</p>
    <select class="act-select" value={currentAct} onchange={(e) => saveActLevel((e.target as HTMLSelectElement).value)}>
      {#each ACT_LEVELS as l}
        <option value={l.key}>{l.label} — {l.desc}</option>
      {/each}
    </select>
  </div>

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
      {@const tdeeLive = Math.round(bmrLive * nf(profile.act) + sportK)}
      {@const cibleLive = sel === 'Libre' ? 0 : Math.round(Math.min(tdeeLive * 0.25, tdeeLive - minIntakeLive))}
      {@const intakeLive = sel === 'Libre' ? tdeeLive : tdeeLive - cibleLive}
      {@const exp = tdeeLive + ((days as any)[ds]?.extraKcal ?? 0)}
      {@const realDef = exp - eaten}
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
            <div class="jour-metric"><span class="jm-lbl">dépense</span> {tdeeLive.toLocaleString('fr')}<span class="jm-u"> kcal</span></div>
          {:else if past && eaten > 0}
            <div class="jour-metric">
              <span class="jm-lbl">mangé</span>
              <span style="color:{eaten <= intakeLive ? 'var(--c-green)' : 'var(--c-red)'}">{Math.round(eaten).toLocaleString('fr')}<span class="jm-u"> kcal</span></span>
            </div>
          {:else if past}
            <div class="jour-metric"><span class="jm-lbl">mangé</span> <span class="muted">—</span></div>
          {:else}
            <div class="jour-metric"><span class="jm-lbl">dépense</span> {tdeeLive.toLocaleString('fr')}<span class="jm-u"> kcal</span></div>
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
.prog-cell { flex:1; padding:9px 4px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-bg); color:var(--c-text2); font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font); transition:background .15s, color .15s; }
.prog-cell.active { background:var(--c-accent); color:var(--c-accent-fg); border-color:var(--c-accent); }
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
.jour-eaten { font-size:12px; font-weight:600; }
.muted { color:var(--c-text3) !important; }
.jour-def { font-size:10px; margin-top:2px; }
.jour-tag { background:var(--c-accent); color:var(--c-accent-fg); border-radius:6px; padding:2px 7px; font-size:10px; font-weight:600; }

  .jours-head { display:flex; align-items:center; justify-content:space-between; }
  .recalc-btn { border:1px solid var(--c-accent); background:transparent; color:var(--c-accent); border-radius:20px; padding:5px 12px; font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font); }
  .recalc-btn:active { background:var(--c-accent); color:var(--c-accent-fg); }

  .jour-metric { font-size:14px; font-weight:700; color:var(--c-text); text-align:right; }
  .jm-lbl { font-size:9px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); margin-right:3px; }
  .jm-u { font-size:11px; font-weight:400; color:var(--c-text3); }

  .proj-card { background:var(--c-surface); }
  .proj-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0 6px; }
  .proj-item { text-align:center; padding:10px; background:var(--c-surface2); border-radius:var(--r-md); }
  .proj-val { font-size:24px; font-weight:700; color:var(--c-accent); letter-spacing:-0.5px; }
  .proj-lbl { font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--c-text3); margin-top:2px; }
  .proj-sub { text-align:center; }

  .recalc-btn.dirty { background:var(--c-accent); color:var(--c-accent-fg); }

  .save-status { font-size:12px; font-weight:600; color:var(--c-text3); }

  .proj-sticky { position:sticky; top:env(safe-area-inset-top, 0px); z-index:10; background:var(--c-bg); padding:8px 0 10px; }
  .proj-sticky .proj-card { margin-bottom:0; }
</style>
