<script lang="ts">
  import { onMount } from 'svelte';
  import { appData } from './store';
  import { get } from 'svelte/store';
  import { calcBMR, nf } from './calc';
  import { initGraphViz } from './graphViz';

  let root: HTMLDivElement;

  onMount(() => {
    const p = (get(appData) as any)?.profile ?? {};
    const W0 = nf(p.weight) || 97.95;
    const bfp = nf(p.bf) || 30.5;
    const F0 = +(W0 * bfp / 100).toFixed(1);
    const BASE0 = Math.round((calcBMR(p) || 1650) * (nf(p.act) || 1.2)) || 2020;
    initGraphViz(root, { W0, F0, BASE0 });
  });
</script>

<div class="graph-root" bind:this={root}></div>

<style>
:global {
  .graph-root {
    --surface-1: var(--c-bg);
    --surface-2: var(--c-surface);
    --surface-3: var(--c-surface2);
    --text-primary: var(--c-text);
    --text-secondary: var(--c-text2);
    --text-muted: var(--c-text3);
    --line: var(--c-border);
    --s1:#2a78d6; --s2:#eb6834; --s3:#7a5cd6; --band:#2a78d633;
    margin:0; color:var(--text-primary);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    padding:20px 14px calc(90px + env(safe-area-inset-bottom, 0px)); min-height:100vh;
  }
  .graph-root * { box-sizing:border-box; }
  .graph-root .wrap { max-width:1020px; margin:0 auto; }
  .graph-root h1 { font-size:21px; margin:0 0 4px; letter-spacing:-.01em; }
  .graph-root .sub { color:var(--text-secondary); font-size:13.5px; margin:0 0 22px; }
  .graph-root section { margin:0 0 30px; border:1px solid var(--line); border-radius:12px; padding:16px 14px 10px; background:var(--surface-1); }
  .graph-root .shead { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px; }
  .graph-root h2 { font-size:16px; margin:0; letter-spacing:-.01em; }
  .graph-root .h2sub { font-size:12.5px; color:var(--text-muted); font-weight:400; margin-top:2px; }
  .graph-root .ctl { display:flex; align-items:center; gap:9px; flex-wrap:wrap; font-size:12.5px; color:var(--text-secondary); }
  .graph-root .seg { display:flex; flex-wrap:wrap; background:var(--surface-2); border:1px solid var(--line); border-radius:9px; padding:2px; gap:2px; }
  .graph-root .seg button { border:0; background:transparent; color:var(--text-secondary); font:inherit; font-size:12.5px; padding:5px 9px; border-radius:7px; cursor:pointer; font-variant-numeric:tabular-nums; min-width:38px; }
  .graph-root .seg button:hover { background:var(--surface-3); }
  .graph-root .seg button[aria-pressed="true"] { background:var(--text-primary); color:var(--surface-1); font-weight:600; }
  .graph-root .kpis { display:flex; flex-wrap:wrap; gap:9px; margin:14px 0 4px; }
  .graph-root .kpi { background:var(--surface-2); border:1px solid var(--line); border-radius:9px; padding:9px 13px; min-width:132px; flex:1; }
  .graph-root .kpi .lab { font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted); display:flex; align-items:center; gap:6px; }
  .graph-root .kpi .dot { width:8px; height:8px; border-radius:50%; }
  .graph-root .kpi .val { font-size:21px; font-weight:600; letter-spacing:-.02em; margin-top:3px; font-variant-numeric:tabular-nums; }
  .graph-root .kpi .val small { font-size:12.5px; font-weight:400; color:var(--text-secondary); }
  .graph-root .kpi .d { font-size:12px; color:var(--text-secondary); font-variant-numeric:tabular-nums; }
  .graph-root .legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12.5px; color:var(--text-secondary); margin:6px 0 2px; }
  .graph-root .legend span { display:inline-flex; align-items:center; gap:7px; }
  .graph-root .sw { width:20px; height:0; border-top:2.6px solid; border-radius:2px; }
  .graph-root .swb { width:20px; height:11px; background:var(--band); border-radius:3px; }
  .graph-root .cw { position:relative; overflow-x:auto; overflow-y:hidden; }
  .graph-root .cw svg { min-width:600px; }
  .graph-root .tip { position:absolute; pointer-events:none; opacity:0; transition:opacity .1s; background:var(--surface-2); border:1px solid var(--line); border-radius:9px; padding:8px 11px; font-size:12.5px; box-shadow:0 6px 20px rgba(0,0,0,.14); white-space:nowrap; font-variant-numeric:tabular-nums; z-index:5; top:6px; }
  .graph-root .tip b { display:block; margin-bottom:4px; font-size:12px; color:var(--text-secondary); font-weight:500; }
  .graph-root .tip div { display:flex; justify-content:space-between; gap:16px; }
  .graph-root .tip i { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; }
  .graph-root .pt { font:600 12.5px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-primary); }
  .graph-root .pu { fill:var(--text-muted); font-weight:400; }
  .graph-root .tk { font:10.5px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-muted); font-variant-numeric:tabular-nums; }
  .graph-root .dl { font:600 13px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-primary); font-variant-numeric:tabular-nums; }
  .graph-root .dl0 { font:11px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-muted); font-variant-numeric:tabular-nums; }
  .graph-root .gr { stroke:var(--line); stroke-width:1; }
  .graph-root .grv { stroke:var(--line); stroke-width:1; opacity:.5; }
  .graph-root .ref { stroke:var(--text-muted); stroke-width:1; stroke-dasharray:4 4; opacity:.55; }
  .graph-root .reftx { font:10px ui-sans-serif,sans-serif; fill:var(--text-muted); }
  .graph-root .cmp { stroke:var(--text-muted); stroke-width:1; stroke-dasharray:2 3; opacity:.6; }
  .graph-root .cmptx { font:9.5px ui-sans-serif,sans-serif; fill:var(--text-muted); }
  .graph-root .obj { stroke:var(--s2); stroke-width:1.5; opacity:.75; }
  .graph-root .crs { stroke:var(--text-muted); stroke-width:1; stroke-dasharray:3 3; }
  .graph-root .note { font-size:12.5px; color:var(--text-secondary); border-left:3px solid var(--line); padding-left:12px; margin:16px 0 4px; }
  .graph-root details { margin-top:16px; }
  .graph-root summary { cursor:pointer; font-size:13px; color:var(--text-secondary); }
  .graph-root .tbl { overflow-x:auto; }
  .graph-root table { border-collapse:collapse; font-size:12.5px; margin-top:12px; width:100%; font-variant-numeric:tabular-nums; }
  .graph-root th, .graph-root td { padding:4px 8px; text-align:right; border-bottom:1px solid var(--line); }
  .graph-root th { color:var(--text-muted); font-weight:500; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; }
  .graph-root td:first-child, .graph-root th:first-child { text-align:left; }
  .graph-root .warn { color:var(--s2); font-weight:600; }
  .graph-root .hyp { margin:12px 0 0; padding:10px 13px; background:var(--surface-2); border:1px solid var(--line); border-radius:9px; font-size:13px; color:var(--text-secondary); font-variant-numeric:tabular-nums; line-height:1.5; }
  .graph-root .hyp b { color:var(--text-primary); font-weight:600; }
  .graph-root .acts { margin-top:14px; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .graph-root .acts .ah { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; background:var(--surface-2); font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted); }
  .graph-root .acts .ar { display:flex; align-items:center; gap:8px; padding:6px 12px; border-top:1px solid var(--line); flex-wrap:wrap; }
  .graph-root .acts input { font:inherit; font-size:13px; background:var(--surface-1); color:var(--text-primary); border:1px solid var(--line); border-radius:7px; padding:5px 8px; font-variant-numeric:tabular-nums; }
  .graph-root .acts input.nm { flex:1; min-width:120px; }
  .graph-root .acts input.nb { width:78px; text-align:right; }
  .graph-root .acts .u { font-size:12px; color:var(--text-muted); min-width:50px; }
  .graph-root .acts .del { border:0; background:transparent; color:var(--text-muted); font-size:17px; line-height:1; cursor:pointer; padding:2px 7px; border-radius:6px; }
  .graph-root .acts .del:hover { background:var(--surface-3); color:var(--s2); }
  .graph-root .acts .af { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; border-top:1px solid var(--line); background:var(--surface-2); }
  .graph-root .acts .add { border:1px dashed var(--line); background:transparent; color:var(--text-secondary); font:inherit; font-size:12.5px; padding:5px 11px; border-radius:8px; cursor:pointer; }
  .graph-root .acts .add:hover { background:var(--surface-3); }
  .graph-root .acts .tot { font-size:12.5px; color:var(--text-secondary); font-variant-numeric:tabular-nums; }
  .graph-root .acts .tot b { color:var(--text-primary); }
}
</style>
