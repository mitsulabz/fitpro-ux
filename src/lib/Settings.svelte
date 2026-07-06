<script lang="ts">
  import { theme, t, session, appData, persistSession } from "./store";
  import { saveAppState } from "./supabase";

  function toggleTheme() { theme.update(v => v === "dark" ? "light" : "dark"); }

  function exportData() {
    const data = $appData;
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fitpro-export-${new Date().toLocaleDateString('fr-FR').replace(/\//g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportProgramme() {
    const prog = ($appData as any)?.programme;
    if (!prog) { alert('Aucun programme trouvé'); return; }
    const blob = new Blob([JSON.stringify(prog, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fitpro-programme-${new Date().toLocaleDateString('fr-FR').replace(/\//g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  let importStatus = $state('');
  let fileInput: HTMLInputElement;

  // ── Profil editable ──
  let pf = $state({ weight: '', bf: '', bft: '', height: '', age: '', sex: 'h', act: '1.2' });
  let pfLoaded = false;
  let profileStatus = $state('');
  $effect(() => {
    const p = ($appData as any)?.profile;
    if (p && !pfLoaded) {
      pf = {
        weight: String(p.weight ?? ''), bf: String(p.bf ?? ''), bft: String(p.bft ?? ''),
        height: String(p.height ?? ''), age: String(p.age ?? ''),
        sex: p.sex ?? 'h', act: String(p.act ?? '1.2'),
      };
      pfLoaded = true;
    }
  });
  async function saveProfile() {
    const s = $session; const data = $appData as any;
    if (!s || !data) return;
    profileStatus = 'Sauvegarde…';
    const newData = { ...data, profile: { ...(data.profile ?? {}),
      weight: pf.weight, bf: pf.bf, bft: pf.bft, height: pf.height, age: pf.age, sex: pf.sex } };
    appData.set(newData);
    try { await saveAppState(s.access_token, s.user.id, newData); profileStatus = '✓ Profil enregistré'; }
    catch { profileStatus = 'Erreur de sauvegarde'; }
    setTimeout(() => profileStatus = '', 2500);
  }

  function triggerImport() { fileInput.click(); }

  async function onFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    importStatus = 'Lecture…';
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      const s = $session;
      if (!s) { importStatus = 'Non connecté'; return; }

      let newData: Record<string, unknown>;

      if (json.jours && Array.isArray(json.jours)) {
        newData = { ...($appData as any), programme: json };
        // Debug : affiche le type du jour 18 juin
        const j18 = json.jours.find((j: any) => (j.jour ?? '').includes('18 juin') || (j.jour ?? '').includes('18/06'));
        console.log('Import — 18 juin type:', j18?.type, 'jour:', j18?.jour);
      } else {
        newData = json;
      }

      importStatus = 'Sauvegarde…';
      const r = await fetch(`https://arydsxswhbgpfayjgtak.supabase.co/rest/v1/app_state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyeWRzeHN3aGJncGZheWpndGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODU1NzcsImV4cCI6MjA5Njk2MTU3N30.JwhGPqopTzi74jv-1zM5JSOAZ0O78p1Q667pB4ZMcH8',
          'Authorization': `Bearer ${s.access_token}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ user_id: s.user.id, data: newData, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        const err = await r.text();
        console.error('saveAppState error:', r.status, err);
        importStatus = `Erreur sauvegarde (${r.status})`;
        return;
      }

      appData.set(newData);
      importStatus = '✓ Importé — rechargement…';
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      console.error('Import error:', err);
      importStatus = 'Erreur : fichier invalide';
    }
    fileInput.value = '';
  }

  function signout() {
    persistSession(null);
    appData.set(null);
  }
</script>

<div class="scroll-area">
  <div class="sheader">
    <div class="label">{$t.nav.reglages}</div>
    <div class="stitle">{$t.nav.reglages}</div>
  </div>

  <div class="section-title">Profil</div>
  <div class="section profile-form">
    <label class="pf-row"><span>Poids (kg)</span><input type="number" inputmode="decimal" step="0.1" bind:value={pf.weight} /></label>
    <label class="pf-row"><span>Masse grasse (%)</span><input type="number" inputmode="decimal" step="0.1" bind:value={pf.bf} /></label>
    <label class="pf-row"><span>Taille (cm)</span><input type="number" bind:value={pf.height} /></label>
    <label class="pf-row"><span>Âge</span><input type="number" bind:value={pf.age} /></label>
    <label class="pf-row"><span>Sexe</span><select bind:value={pf.sex}><option value="h">Homme</option><option value="f">Femme</option></select></label>
    <button class="card save-btn" onclick={saveProfile}>Enregistrer le profil</button>
    {#if profileStatus}<div class="import-status" class:success={profileStatus.startsWith('✓')}>{profileStatus}</div>{/if}
  </div>

  <div class="section-title">Apparence</div>
  <div class="section">
    <button class="card setting-row" onclick={toggleTheme}>
      <span class="body">Thème</span>
      <div class="pill">{$theme === "dark" ? "Sombre" : "Clair"}</div>
    </button>
  </div>

  <div class="section-title">Données</div>
  <div class="section">
    <button class="card setting-row" onclick={exportData}>
      <span class="body">Exporter tout (JSON)</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="card setting-row" onclick={exportProgramme}>
      <span class="body">Exporter le programme</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="card setting-row" onclick={triggerImport}>
      <span class="body">Importer un programme / JSON</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="transform:scaleY(-1)" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <input bind:this={fileInput} type="file" accept=".json" onchange={onFileChange} style="display:none" />
    {#if importStatus}
      <div class="import-status" class:success={importStatus.startsWith('✓')}>{importStatus}</div>
    {/if}
  </div>

  <div class="section-title">Compte</div>
  <div class="section">
    <div class="card setting-row info-row">
      <span class="body">Connecté</span>
      <span class="caption">{$session?.user?.email ?? ''}</span>
    </div>
    <button class="card setting-row danger-btn" onclick={signout}>
      <span class="body">Se déconnecter</span>
    </button>
  </div>

  <div class="version caption">FitProX · V8.9</div>
</div>

<style>
.sheader { padding:20px 0 14px; }
.stitle { font-size:20px; font-weight:500; color:var(--c-text); margin-top:3px; }
.section-title { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:0.06em; color:var(--c-text3); margin:20px 0 8px; }
.section { display:flex; flex-direction:column; gap:8px; }
.setting-row { display:flex; align-items:center; justify-content:space-between; cursor:pointer; width:100%; text-align:left; font-family:var(--font); color:var(--c-text); }
.setting-row svg { color:var(--c-text3); flex-shrink:0; }
.pill { background:var(--c-surface2); border:0.5px solid var(--c-border2); border-radius:20px; padding:4px 12px; font-size:12px; font-weight:500; color:var(--c-text2); }
.import-status { font-size:13px; color:var(--c-text2); padding:8px 4px; }
.import-status.success { color:var(--c-green); }
.info-row { cursor:default; }
.danger-btn { color:var(--c-red); }
.version { text-align:center; margin-top:32px; color:var(--c-text3); }

.profile-form { display:flex; flex-direction:column; gap:6px; }
.pf-row { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); padding:10px 14px; }
.pf-row span { font-size:14px; color:var(--c-text); }
.pf-row input, .pf-row select { width:110px; padding:6px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:14px; text-align:right; font-family:var(--font); }
.pf-row input:focus, .pf-row select:focus { outline:none; border-color:var(--c-accent); }
.save-btn { text-align:center; justify-content:center; padding:12px; background:var(--c-accent); color:var(--c-accent-fg); border:none; font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font); border-radius:var(--r-md); }
</style>
