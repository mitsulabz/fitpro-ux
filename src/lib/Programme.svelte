<script lang="ts">
  import { appData, session, persistSession } from './store';
  import { saveAppState, refreshToken } from './supabase';
  import { get } from 'svelte/store';
  import { onMount } from 'svelte';

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

  const currentAct = $derived(profile?.act ?? '1.30');
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
    actEntries = Object.entries(a).map(([name, kcal]) => ({ name, kcal: kcal as number }));
    initDaySelections(data);
    if (changed || !data?.programme?._seededDefaults) {
      persist({ ...data, programme: { ...(data.programme ?? {}), activites: a, _seededDefaults: true } });
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
  function calcBMR(p: any): number {
    const w = +p.weight || 100, h = +p.height || 180, age = +p.age || 40;
    const bf = +p.bf;
    if (bf > 0) return 370 + 21.6 * w * (1 - bf / 100);
    const sex = p.sex === 'f' ? -161 : 5;
    return 10 * w + 6.25 * h - 5 * age + sex;
  }

  function calcTDEE(bmr: number, actKey: string, sportKcal: number): number {
    return bmr * (parseFloat(actKey) || 1.4) + sportKcal;
  }

  // Per-day override — recalculates the jour's calories/deficit
  async function setDayActivity(ds: string, value: string) {
    daySelections = { ...daySelections, [ds]: value };

    const data = get(appData) as any;
    const dayData = (data.days ?? {})[ds] ?? {};
    const curActs = (data.programme?.activites ?? {}) as Record<string, number>;
    const progAct = value === '' ? false : { name: value, kcal: curActs[value] ?? 0 };
    const newDays = { ...(data.days ?? {}), [ds]: { ...dayData, progActivity: progAct } };

    // Recalculate programme jours
    const jours: any[] = data.programme?.jours ?? [];
    const newJours = jours.map((j: any) => {
      if (dsOf(j) !== ds) return j;
      if (value === 'Libre') {
        const brulees = j.calories_brulees ?? j.calories ?? 0;
        return { ...j, type: 'Libre — journée neutre', deficit: 0, calories: brulees, calories_brulees: brulees };
      }
      const bmr = calcBMR(data.profile ?? {});
      const sportKcal = value === '' ? 0 : (curActs[value] ?? 0);
      const tdee = Math.round(calcTDEE(bmr, data.profile?.act ?? '1.40', sportKcal));
      const sexFloor = (data.profile?.sex === 'f') ? 1200 : 1500;
      // Plancher sante : ne jamais manger sous le BMR
      const minIntake = Math.max(Math.round(bmr), sexFloor);
      const deficit = Math.round(Math.min(tdee * 0.20, tdee - minIntake));
      const calories = tdee - deficit;
      return { ...j, type: value || j.type, calories_brulees: tdee, deficit, calories };
    });

    await persist({ ...data, days: newDays, programme: { ...data.programme, jours: newJours } });
  }

  // Recalcule TOUS les jours avec le profil + activites + regle BMR actuels
  async function recalcAll() {
    const data = get(appData) as any;
    const curActs = (data.programme?.activites ?? {}) as Record<string, number>;
    const jours: any[] = data.programme?.jours ?? [];
    const bmr = calcBMR(data.profile ?? {});
    const sexFloor = (data.profile?.sex === 'f') ? 1200 : 1500;
    const minIntake = Math.max(Math.round(bmr), sexFloor);
    const newJours = jours.map((j: any) => {
      const ds = dsOf(j);
      const value = selectionFor(data, j, ds);
      if (value === 'Libre') {
        const brulees = Math.round(calcTDEE(bmr, data.profile?.act ?? '1.40', 0));
        return { ...j, type: 'Libre — journée neutre', deficit: 0, calories: brulees, calories_brulees: brulees };
      }
      const sportKcal = value === '' ? 0 : (curActs[value] ?? 0);
      const tdee = Math.round(calcTDEE(bmr, data.profile?.act ?? '1.40', sportKcal));
      const deficit = Math.round(Math.min(tdee * 0.20, tdee - minIntake));
      const calories = tdee - deficit;
      return { ...j, type: value || j.type, calories_brulees: tdee, deficit, calories };
    });
    await persist({ ...data, programme: { ...data.programme, jours: newJours } });
  }

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
  <div class="pheader">
    <div>
      <div class="label">Programme</div>
      <div class="ptitle">{prog?.date_debut ?? ''} → {prog?.date_fin ?? ''}</div>
    </div>
    {#if dayNum}
    <div class="day-badge">J{dayNum}<span>/{totalDays}</span></div>
    {/if}
  </div>

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
      <button class="recalc-btn" onclick={recalcAll}>↻ Recalculer</button>
    </div>
    <div class="jour-list">
      {#each progJours as j, i}
      {@const ds = dsOf(j)}
      {@const eaten = getEaten(j)}
      {@const today = isToday(j)}
      {@const past = isPast(j)}
      <div class="jour-card" class:today class:past>
        <div class="jour-num">{i + 1}</div>
        <div class="jour-info">
          <div class="jour-name">{j.jour}</div>
          <!-- Sélecteur activité du jour -->
          <select class="jour-act-sel"
            value={daySelections[ds] ?? j.type ?? ''}
            onchange={(e) => setDayActivity(ds, (e.target as HTMLSelectElement).value)}
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
            <div class="jour-metric"><span class="jm-lbl">cible</span> {(j.calories ?? 0).toLocaleString('fr')}<span class="jm-u"> kcal</span></div>
          {:else if past && eaten > 0}
            <div class="jour-metric">
              <span class="jm-lbl">mangé</span>
              <span style="color:{eaten <= (j.calories??0) ? 'var(--c-green)' : 'var(--c-red)'}">{Math.round(eaten).toLocaleString('fr')}<span class="jm-u"> kcal</span></span>
            </div>
          {:else if past}
            <div class="jour-metric"><span class="jm-lbl">mangé</span> <span class="muted">—</span></div>
          {:else}
            <div class="jour-metric"><span class="jm-lbl">cible</span> {(j.calories ?? 0).toLocaleString('fr')}<span class="jm-u"> kcal</span></div>
          {/if}
          {#if (j.deficit ?? 0) === 0}
            <div class="jour-def caption" style="color:var(--c-blue)">journée neutre</div>
          {:else}
            <div class="jour-def caption" style="color:{typeColor(j.type ?? '')}">déficit −{(j.deficit ?? 0).toLocaleString('fr')}</div>
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
</style>
