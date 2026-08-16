// Helpers de calcul partagés

// parse tolérant à la virgule ("82,5" -> 82.5)
export function nf(v: any): number { return parseFloat(String(v ?? '').replace(',', '.')) || 0; }
