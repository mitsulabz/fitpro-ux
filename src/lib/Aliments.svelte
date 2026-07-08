<script lang="ts">
  import { appData, session } from './store';
  import { saveAppState } from './supabase';
  import { get } from 'svelte/store';

  let filter = $state('');
  const norm = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const favorites = $derived(
    [...(Array.isArray(($appData as any)?.favorites) ? ($appData as any).favorites : [])]
      .sort((a: any, b: any) => (a.name ?? '').localeCompare(b.name ?? '', 'fr'))
  );

  async function deleteFav(item: any) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const favs = [...(data.favorites ?? [])];
    const realIdx = favs.findIndex((f: any) => f.name === item.name && f.per === item.per);
    if (realIdx === -1) return;
    favs.splice(realIdx, 1);
    const newData = { ...data, favorites: favs };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }
</script>

<div class="scroll-area">
  <div class="header">
    <div class="title">Aliments favoris</div>
    <div class="caption">{favorites.length} aliment{favorites.length !== 1 ? 's' : ''}</div>
  </div>

  {#if favorites.length === 0}
    <div class="empty">
      <div class="empty-icon">🥗</div>
      <div>Aucun favori pour l'instant.</div>
      <div class="caption">Les aliments que tu ajoutes à une journée apparaissent ici automatiquement.</div>
    </div>
  {:else}
    {@const filtered = favorites.filter((f: any) => norm(f.name).includes(norm(filter)))}
    <input class="fav-filter" type="text" placeholder="Filtrer les aliments…"
      bind:value={filter} autocomplete="off" autocorrect="off" spellcheck="false" />
    {#if filtered.length === 0}
      <div class="caption" style="padding:12px 2px">Aucun aliment ne correspond à « {filter} ».</div>
    {/if}
    <div class="list">
      {#each filtered as fav (fav.name + '|' + (fav.per ?? '100'))}
        <div class="fav-row">
          <div class="fav-info">
            <span class="fav-name">{fav.name}</span>
            <span class="fav-macros">
              {Math.round(fav.kcal ?? 0)} kcal · P {+(fav.p ?? 0).toFixed(1)}g · G {+(fav.g ?? 0).toFixed(1)}g · L {+(fav.l ?? 0).toFixed(1)}g
              <span class="muted">{fav.per === 'unit' ? '/portion' : '/100g'}</span>
            </span>
          </div>
          <button class="del-btn" onclick={() => deleteFav(fav)} aria-label="Supprimer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
.header { padding:20px 0 14px; }
.title { font-size:20px; font-weight:500; color:var(--c-text); }
.caption { font-size:12px; color:var(--c-text3); margin-top:2px; }
.empty { display:flex; flex-direction:column; align-items:center; gap:8px; padding:60px 20px; text-align:center; color:var(--c-text2); font-size:14px; }
.empty-icon { font-size:40px; }
.fav-filter { width:100%; padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); margin-bottom:8px; }
.fav-filter:focus { outline:none; border-color:var(--c-accent); }
.list { display:flex; flex-direction:column; gap:6px; }
.fav-row { display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); }
.fav-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.fav-name { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-macros { font-size:11px; color:var(--c-text2); }
.muted { color:var(--c-text3); }
.del-btn { width:28px; height:28px; border:none; border-radius:50%; background:var(--c-surface2); color:var(--c-text3); cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.del-btn:hover { background:rgba(220,50,50,.12); color:var(--c-red, #e05); }
</style>
