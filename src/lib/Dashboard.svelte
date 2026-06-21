<script lang="ts">
  import { t, appData, session, persistSession } from "./store";
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
  const deficit = $derived(Math.round(macros.k) - tBrulees);
  const mCible = $derived({ p: progDay?.proteines_g ?? 170, g: progDay?.glucides_g ?? 178, l: progDay?.lipides_g ?? 70 });

  const totalDays = $derived(progJours.length);
  const dayNum = $derived(progIdx >= 0 ? progIdx + 1 : null);
  const progressPct = $derived(totalDays > 0 ? Math.round(Math.max(0, progIdx) / totalDays * 100) : 0);
  const bfProjected = $derived.by(() => {
    const p = ($appData as any)?.profile;
    if (!p) return null;
    const w = parseFloat(p.weight) || 0;
    const bf = parseFloat(p.bf) || 0;
    if (!w || !bf) return null;
    const totalDef = progJours.reduce((s: number, j: any) => s + (j.deficit || 0), 0);
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
  const retard = $derived(expectedDeficit + cumul);

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
    for (let i = 1; i <= 30; i++) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      const dayData = (days as any)[key];
      const hasFood = !!dayData?.foods?.length;
      const within7 = i <= 7 && d.getTime() >= floorTime;
      // on garde les 7 derniers jours (>= 1er jour loggé) meme vides, + tout jour loggé au-dela
      if (!hasFood && !within7) continue;
      const foods = dayData?.foods ?? [];
      const total = (foods as any[]).reduce((s: number, f: any) => s + (f.k||0), 0);
      const label = d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' });
      const jd = progJours.find((j: any) => {
        const pd = parseJour(j.jour);
        if (!pd) return false;
        return pd.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) === key;
      });
      const cible = jd?.calories ?? 0;
      const extraKcal = dayData?.extraKcal ?? 0;
      result.push({ key, label, foods, total, cible, extraKcal });
      if (result.length >= 14) break;
    }
    return result;
  });


  function pct(a: number, b: number) { return b > 0 ? Math.min(100, Math.round(a/b*100)) : 0; }
  function fmt(n: number) { return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('fr'); }

  const BUILD = "V2.1";
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
      const totalDef = jours.reduce((s: number, j: any) => s + (j.deficit || 0), 0);
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

</script>

<div class="scroll-area">
  <div class="header">
    <div>
      <div class="label">{$t.dashboard.today}</div>
      <div class="date">{dateLabel}<span class="build-tag">{BUILD}</span></div>
    </div>
    <div class="app-title">FitPro<span class="x">X</span></div>
  </div>

  {#if totalDays > 0}
  <div class="card progress-card">
    <div class="prog-top">
      <span class="label">{$t.dashboard.progress}</span>
      <span class="badge-accent">{progressPct}%</span>
    </div>
    <div class="progress-bar" style="margin-top:10px">
      <div class="progress-fill" style="width:{progressPct}%"></div>
    </div>
    <div class="caption" style="margin-top:6px">J{dayNum} sur {totalDays}</div>
  </div>
  {/if}

  <!-- Coach IA -->
  <div class="hero-row">
    <!-- Cible du jour -->
    <div class="card hero-card hero-eat">
      <div class="label">Journée à</div>
      {#if tIntake > 0}
        {@const reste = tIntake - macros.k}
        <div class="hero-num" style="color:var(--c-text)">{Math.round(tIntake).toLocaleString('fr')}<span class="hero-unit">kcal</span></div>
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
  </div>


  <!-- Historique des jours passés -->
  <div class="section-label">Historique</div>
  {#each recentDays() as day}
  <details class="card hist-card">
    <summary class="hist-summary">
      <span class="hist-date">{day.label}</span>
      <span class="hist-kcal" style="color:{day.cible > 0 ? (day.total <= day.cible ? 'var(--c-green)' : 'var(--c-red)') : 'var(--c-text2)'}">
        {Math.round(day.total).toLocaleString('fr')} kcal
      </span>
      {#if day.cible > 0}
      <span class="hist-cible">/ {Math.round(day.cible).toLocaleString('fr')}</span>
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
      <div class="value-accent" style="color:{cumul <= 0 ? 'var(--c-accent)' : 'var(--c-red)'}">
        {fmt(cumul)}
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
.hist-summary { display:flex; align-items:center; gap:8px; padding:12px 14px; cursor:pointer; list-style:none; }
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
</style>
