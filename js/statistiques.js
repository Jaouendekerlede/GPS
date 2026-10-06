// Statistiques de conduite : trajets faits en navigation et recharges du
// journal, sur le mois, l'année ou depuis le début. Module sans écran.

// Émissions moyennes (g de CO₂ par km) : voiture essence récente, et
// voiture électrique avec l'électricité française.
const CO2_ESSENCE_G_KM = 120;
const CO2_ELECTRIQUE_G_KM = 15;
const PRIX_KWH_DEFAUT_EUR = 0.25;

function dansPeriode(ms, periode, maintenant) {
  if (periode === "tout") return true;
  const d = new Date(ms);
  const n = new Date(maintenant);
  if (d.getFullYear() !== n.getFullYear()) return false;
  return periode === "annee" || d.getMonth() === n.getMonth();
}

// trajets : [{ date, km, kwh }] ; journal : [{ ts, kwh, cout_eur }].
export function statistiques(trajets, journal, periode, maintenant) {
  const t = trajets.filter((x) => dansPeriode(x.date, periode, maintenant));
  const j = journal.filter((x) => dansPeriode(x.ts, periode, maintenant));
  const km = t.reduce((s, x) => s + (x.km || 0), 0);
  const kwh = t.reduce((s, x) => s + (x.kwh || 0), 0);
  const kwhRecharges = j.reduce((s, x) => s + (x.kwh || 0), 0);
  const coutRecharges = j.reduce((s, x) => s + (x.cout_eur || 0), 0);
  // Prix réel payé si le journal en dit assez, sinon un prix moyen.
  const prixKwh = kwhRecharges >= 5 ? coutRecharges / kwhRecharges : PRIX_KWH_DEFAUT_EUR;
  const coutElectrique = kwh * prixKwh;
  return {
    trajets: t.length,
    km,
    kwh,
    recharges: j.length,
    kwh_recharges: kwhRecharges,
    cout_recharges: coutRecharges,
    cout_km: km > 0 ? coutElectrique / km : 0,
    co2_evite_kg: (km * (CO2_ESSENCE_G_KM - CO2_ELECTRIQUE_G_KM)) / 1000,
  };
}
