// Helpers de calcul partagés (Dashboard, Programme)

// parse tolérant à la virgule ("82,5" -> 82.5)
export function nf(v: any): number { return parseFloat(String(v ?? '').replace(',', '.')) || 0; }

// BMR : Katch-McArdle si %MG connu, sinon Mifflin-St-Jeor
export function calcBMR(p: any): number {
  const manual = nf(p?.bmrManual);
  if (manual > 0) return manual; // BMR mesuré/saisi manuellement = priorité
  const w = nf(p?.weight) || 100, h = nf(p?.height) || 180, age = nf(p?.age) || 40;
  const bf = nf(p?.bf);
  if (bf > 0) return 370 + 21.6 * w * (1 - bf / 100);
  const sex = p?.sex === 'f' ? -161 : 5;
  return 10 * w + 6.25 * h - 5 * age + sex;
}

export function calcTDEE(bmr: number, actKey: string, sportKcal: number): number {
  return bmr * (nf(actKey) || 1.4) + sportKcal;
}
