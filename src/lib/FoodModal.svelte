<script lang="ts">
  import { appData, session, persistSession } from './store';
  import { saveAppState, refreshToken } from './supabase';
  import { get } from 'svelte/store';


  async function getFreshToken(): Promise<string | null> {
    const s = get(session);
    if (!s) return null;
    try {
      const fresh = await refreshToken(s.refresh_token);
      persistSession(fresh);
      return fresh.access_token;
    } catch {
      return s.access_token;
    }
  }
  const SUPABASE_URL = 'https://arydsxswhbgpfayjgtak.supabase.co';

  type Food = { n: string; k: number; p: number; g: number; l: number };
  type OFFProd = { n: string; k100: number; p100: number; g100: number; l100: number };

  let { dayKey, onclose }: { dayKey: string; onclose: () => void } = $props();

  let tab = $state<'search' | 'scan' | 'favorites' | 'manual' | 'ai'>('search');

  // Recherche OFF
  let query = $state('');
  let searching = $state(false);
  let offResults = $state<OFFProd[]>([]);
  let quantities = $state<Record<number, number>>({});

  // Manuel
  let manName = $state('');
  let manKcal = $state('');
  let manP = $state('');
  let manG = $state('');
  let manL = $state('');

  // IA
  let aiText = $state('');
  let aiLoading = $state(false);
  let aiResults = $state<Food[]>([]);
  let aiError = $state('');

  // Scan
  let scanCode = $state('');
  let scanLoading = $state(false);
  let scanResult = $state<OFFProd | null>(null);
  let scanQty = $state(100);
  let scanError = $state('');

  const favorites = $derived(
    [...(Array.isArray(($appData as any)?.favorites) ? ($appData as any).favorites : [])]
      .sort((a: any, b: any) => (a.name ?? '').localeCompare(b.name ?? '', 'fr'))
  );

  function favKey(name: string, per: string) {
    return (name ?? '').trim().toLowerCase() + '|' + (per ?? '100');
  }

  async function commitFood(food: Food, closeAfter = true) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;

    const days = data.days ?? {};
    const day = days[dayKey] ?? {};
    const foods = Array.isArray(day.foods) ? [...day.foods] : [];
    foods.push({ n: food.n, k: Math.round(food.k), p: +food.p.toFixed(1), g: +food.g.toFixed(1), l: +food.l.toFixed(1) });

    // Auto-add to favorites
    const favs: any[] = Array.isArray(data.favorites) ? [...data.favorites] : [];
    const key = favKey(food.n, '100');
    if (!favs.some((f: any) => favKey(f.name, f.per) === key)) {
      favs.unshift({ name: food.n, per: '100', kcal: Math.round(food.k), p: +food.p.toFixed(1), g: +food.g.toFixed(1), l: +food.l.toFixed(1), img: '' });
    }

    const newData = { ...data, favorites: favs, days: { ...days, [dayKey]: { ...day, foods } } };
    appData.set(newData);
    // Rafraichit le jeton avant de sauvegarder (sinon, fenetre ouverte longtemps -> jeton expire -> perte de donnees)
    let token = s.access_token;
    try { const fresh = await refreshToken(s.refresh_token); persistSession(fresh); token = fresh.access_token; } catch {}
    await saveAppState(token, s.user.id, newData);
    if (closeAfter) onclose();
  }

  function addFromFav(fav: any) {
    commitFood({ n: fav.name, k: fav.kcal ?? 0, p: fav.p ?? 0, g: fav.g ?? 0, l: fav.l ?? 0 });
  }

  function addOFF(prod: OFFProd, idx: number, qty: number) {
    const r = qty / 100;
    commitFood({ n: `${prod.n} (${qty}g)`, k: prod.k100 * r, p: prod.p100 * r, g: prod.g100 * r, l: prod.l100 * r });
  }

  async function searchOFF() {
    if (!query.trim()) return;
    searching = true; offResults = []; quantities = {};
    try {
      const r = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=1&page_size=20&fields=product_name,nutriments&lc=fr`);
      const d = await r.json();
      offResults = (d.products ?? [])
        .filter((p: any) => p.product_name?.trim() && p.nutriments?.['energy-kcal_100g'] != null)
        .slice(0, 12)
        .map((p: any) => ({
          n: p.product_name.trim(),
          k100: Math.round(p.nutriments['energy-kcal_100g'] ?? 0),
          p100: Math.round((p.nutriments.proteins_100g ?? 0) * 10) / 10,
          g100: Math.round((p.nutriments.carbohydrates_100g ?? 0) * 10) / 10,
          l100: Math.round((p.nutriments.fat_100g ?? 0) * 10) / 10,
        }));
    } catch {}
    searching = false;
  }

  async function searchBarcode(code: string) {
    if (!code.trim()) return;
    scanLoading = true; scanResult = null; scanError = '';
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code.trim())}.json`);
      const d = await r.json();
      if (d.status !== 1 || !d.product) { scanError = 'Produit introuvable'; scanLoading = false; return; }
      const p = d.product;
      const nut = p.nutriments ?? {};
      if (nut['energy-kcal_100g'] == null) { scanError = 'Pas de données nutritionnelles'; scanLoading = false; return; }
      scanResult = {
        n: p.product_name?.trim() ?? code,
        k100: Math.round(nut['energy-kcal_100g'] ?? 0),
        p100: Math.round((nut.proteins_100g ?? 0) * 10) / 10,
        g100: Math.round((nut.carbohydrates_100g ?? 0) * 10) / 10,
        l100: Math.round((nut.fat_100g ?? 0) * 10) / 10,
      };
    } catch { scanError = 'Erreur réseau'; }
    scanLoading = false;
  }

  function addManual() {
    if (!manName.trim() || !manKcal) return;
    commitFood({ n: manName.trim(), k: +manKcal, p: +(manP || 0), g: +(manG || 0), l: +(manL || 0) });
  }

  async function estimateAI() {
    if (!aiText.trim()) return;
    aiLoading = true; aiResults = []; aiError = '';
    try {
      const token = await getFreshToken();
      const r = await fetch(`${SUPABASE_URL}/functions/v1/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'estimate-food', text: aiText }),
      });
      const d = await r.json();
      if (d.foods) aiResults = d.foods.map((f: any) => ({ n: f.name, k: f.kcal ?? 0, p: f.p ?? 0, g: f.g ?? 0, l: f.l ?? 0 }));
      else aiError = d.error ?? d.message ?? JSON.stringify(d);
    } catch { aiError = 'Erreur réseau'; }
    aiLoading = false;
  }
</script>

<div class="overlay" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title">Ajouter un aliment</span>
      <button class="close-btn" onclick={onclose}>✕</button>
    </div>

    <div class="tabs">
      <button class:active={tab === 'search'}    onclick={() => tab = 'search'}>Recherche</button>
      <button class:active={tab === 'scan'}      onclick={() => tab = 'scan'}>Scan</button>
      <button class:active={tab === 'favorites'} onclick={() => tab = 'favorites'}>Favoris</button>
      <button class:active={tab === 'manual'}    onclick={() => tab = 'manual'}>Manuel</button>
      <button class:active={tab === 'ai'}        onclick={() => tab = 'ai'}>IA</button>
    </div>

    <div class="modal-body">

      {#if tab === 'search'}
        <form class="search-bar" onsubmit={(e) => { e.preventDefault(); searchOFF(); }}>
          <input type="search" placeholder="Nom d'aliment, marque…" bind:value={query} autocomplete="off" />
          <button type="submit" class="btn-accent" disabled={searching}>{searching ? '…' : '🔍'}</button>
        </form>
        {#if offResults.length === 0 && !searching && query}
          <div class="empty">Aucun résultat pour "{query}"</div>
        {:else}
          {#each offResults as prod, i}
            <div class="food-row">
              <div class="food-info">
                <span class="food-name">{prod.n}</span>
                <span class="food-macros">{prod.k100} kcal · P {prod.p100}g · G {prod.g100}g · L {prod.l100}g <span class="muted">/100g</span></span>
              </div>
              <div class="qty-row">
                <input type="number" min="1" max="2000" step="10"
                  value={quantities[i] ?? 100}
                  oninput={(e) => { quantities = { ...quantities, [i]: +(e.target as HTMLInputElement).value }; }}
                />
                <span class="muted">g</span>
                <button class="btn-add" onclick={() => addOFF(prod, i, quantities[i] ?? 100)}>+</button>
              </div>
            </div>
          {/each}
        {/if}

      {:else if tab === 'scan'}
        <p class="hint">Saisis le code-barres manuellement ou utilise la caméra.</p>
        <form class="search-bar" onsubmit={(e) => { e.preventDefault(); searchBarcode(scanCode); }}>
          <input type="text" placeholder="Code-barres (ex: 3017620429484)" bind:value={scanCode} inputmode="numeric" />
          <button type="submit" class="btn-accent" disabled={scanLoading}>{scanLoading ? '…' : '→'}</button>
        </form>
        <label class="scan-camera-label" for="scan-file-input">
          <input type="file" accept="image/*" capture="environment" id="scan-file-input" class="scan-file"
            onchange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              // BarcodeDetector API (Chrome/Android)
              if ('BarcodeDetector' in window) {
                try {
                  const bd = new (window as any).BarcodeDetector({ formats: ['ean_13','ean_8','upc_a','upc_e'] });
                  const img = await createImageBitmap(f);
                  const codes = await bd.detect(img);
                  if (codes.length > 0) { scanCode = codes[0].rawValue; searchBarcode(scanCode); }
                  else { scanError = 'Aucun code-barres détecté'; }
                } catch { scanError = 'Erreur de lecture'; }
              } else {
                scanError = 'Détection auto non supportée — saisis le code manuellement';
              }
            }}
          />
          📷 Prendre une photo
        </label>
        {#if scanError}<div class="error">{scanError}</div>{/if}
        {#if scanResult}
          <div class="food-row">
            <div class="food-info">
              <span class="food-name">{scanResult.n}</span>
              <span class="food-macros">{scanResult.k100} kcal · P {scanResult.p100}g · G {scanResult.g100}g · L {scanResult.l100}g <span class="muted">/100g</span></span>
            </div>
            <div class="qty-row">
              <input type="number" min="1" max="2000" step="10" bind:value={scanQty} />
              <span class="muted">g</span>
              <button class="btn-add" onclick={() => addOFF(scanResult!, 0, scanQty)}>+</button>
            </div>
          </div>
        {/if}

      {:else if tab === 'favorites'}
        {#if favorites.length === 0}
          <div class="empty">Aucun favori. Ajoute des aliments via Recherche, Scan ou IA.</div>
        {:else}
          {#each favorites as fav}
            <button class="food-row fav-btn" onclick={() => addFromFav(fav)}>
              <div class="food-info">
                <span class="food-name">{fav.name}</span>
                <span class="food-macros">{Math.round(fav.kcal ?? 0)} kcal · P {+(fav.p??0).toFixed(1)}g · G {+(fav.g??0).toFixed(1)}g · L {+(fav.l??0).toFixed(1)}g <span class="muted">{fav.per === 'unit' ? '/portion' : '/100g'}</span></span>
              </div>
              <span class="add-icon">+</span>
            </button>
          {/each}
        {/if}

      {:else if tab === 'manual'}
        <form class="manual-form" onsubmit={(e) => { e.preventDefault(); addManual(); }}>
          <div class="field">
            <label>Nom</label>
            <input type="text" placeholder="Ex : Yaourt nature" bind:value={manName} required />
          </div>
          <div class="field-row">
            <div class="field">
              <label>Kcal</label>
              <input type="number" min="0" step="1" placeholder="0" bind:value={manKcal} required />
            </div>
            <div class="field">
              <label>Protéines (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manP} />
            </div>
            <div class="field">
              <label>Glucides (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manG} />
            </div>
            <div class="field">
              <label>Lipides (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manL} />
            </div>
          </div>
          <button type="submit" class="btn-accent full" disabled={!manName.trim() || !manKcal}>
            Ajouter au journal
          </button>
        </form>

      {:else}
        <p class="hint">Décris ce que tu as mangé en texte libre, l'IA estime les macros.</p>
        <form onsubmit={(e) => { e.preventDefault(); estimateAI(); }}>
          <textarea placeholder="Ex : 2 œufs brouillés, une tranche de pain complet avec du beurre, un café au lait…" bind:value={aiText} rows="3"></textarea>
          <button type="submit" class="btn-accent full" disabled={aiLoading || !aiText.trim()}>
            {aiLoading ? 'Analyse…' : '✨ Estimer'}
          </button>
        </form>
        {#if aiError}<div class="error">{aiError}</div>{/if}
        {#each aiResults as food}
          <button class="food-row fav-btn" onclick={() => { commitFood(food, false); aiResults = aiResults.filter((f) => f !== food); }}>
            <div class="food-info">
              <span class="food-name">{food.n}</span>
              <span class="food-macros">{Math.round(food.k)} kcal · P {+food.p.toFixed(1)}g · G {+food.g.toFixed(1)}g · L {+food.l.toFixed(1)}g</span>
            </div>
            <span class="add-icon">+</span>
          </button>
        {/each}
      {/if}

    </div>
  </div>
</div>

<style>
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:200; display:flex; align-items:flex-end; }
.modal { width:100%; max-height:85dvh; background:var(--c-bg); border-radius:20px 20px 0 0; display:flex; flex-direction:column; overflow:hidden; }
.modal-header { display:flex; align-items:center; justify-content:space-between; padding:16px 18px 0; flex-shrink:0; }
.modal-title { font-size:16px; font-weight:600; color:var(--c-text); }
.close-btn { border:none; background:none; color:var(--c-text3); font-size:18px; cursor:pointer; padding:4px; }
.tabs { display:flex; border-bottom:1px solid var(--c-border); margin-top:10px; flex-shrink:0; overflow-x:auto; }
.tabs button { flex:1; min-width:60px; padding:10px 6px; border:none; background:none; font-size:12px; font-weight:500; color:var(--c-text2); cursor:pointer; border-bottom:2px solid transparent; font-family:var(--font); white-space:nowrap; }
.tabs button.active { color:var(--c-accent); border-bottom-color:var(--c-accent); }
.modal-body { overflow-y:auto; padding:12px 16px 24px; display:flex; flex-direction:column; gap:8px; }

.food-row { display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); }
.fav-btn { width:100%; text-align:left; cursor:pointer; font-family:var(--font); }
.fav-btn:hover { border-color:var(--c-accent); }
.food-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.food-name { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.food-macros { font-size:11px; color:var(--c-text2); }
.muted { color:var(--c-text3); }
.add-icon { font-size:22px; font-weight:300; color:var(--c-accent); flex-shrink:0; line-height:1; }
.qty-row { display:flex; align-items:center; gap:4px; flex-shrink:0; }
.qty-row input { width:52px; padding:5px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:13px; text-align:center; font-family:var(--font); }
.btn-add { width:30px; height:30px; border:none; border-radius:50%; background:var(--c-accent); color:var(--c-accent-fg); font-size:20px; font-weight:300; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.search-bar { display:flex; gap:8px; }
.search-bar input, /* unused */ .scan-bar-unused { flex:1; padding:9px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); }
.search-bar input:focus { outline:none; border-color:var(--c-accent); }
.btn-accent { padding:9px 14px; border:none; border-radius:var(--r-md); background:var(--c-accent); color:var(--c-accent-fg); font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font); }
.btn-accent:disabled { opacity:.5; cursor:not-allowed; }
.btn-accent.full { width:100%; padding:12px; margin-top:4px; }
.hint { font-size:13px; color:var(--c-text2); margin:0; }
form { display:flex; flex-direction:column; gap:8px; }
textarea { padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); resize:none; }
textarea:focus { outline:none; border-color:var(--c-accent); }
.empty { text-align:center; color:var(--c-text3); font-size:13px; padding:30px 0; }
.error { font-size:13px; color:#e05; padding:8px 12px; background:rgba(220,50,50,.08); border-radius:8px; }
.scan-camera-label { display:flex; align-items:center; justify-content:center; gap:8px; padding:12px; border:1px dashed var(--c-border); border-radius:var(--r-md); color:var(--c-text2); font-size:13px; cursor:pointer; }
.scan-camera-label:hover { border-color:var(--c-accent); color:var(--c-accent); }
.scan-file { display:none; }
.manual-form { display:flex; flex-direction:column; gap:12px; }
.field { display:flex; flex-direction:column; gap:4px; }
.field label { font-size:11px; font-weight:500; color:var(--c-text3); text-transform:uppercase; letter-spacing:.05em; }
.field input { padding:9px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); }
.field input:focus { outline:none; border-color:var(--c-accent); }
.field-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
</style>
