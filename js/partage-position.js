// Partage de la position en direct pendant un guidage, à la demande.
//
// L'appli n'a pas de serveur : les positions passent par ntfy.sh, un service
// public gratuit de messages. Chaque partage crée une adresse au hasard,
// impossible à deviner ; quiconque a le lien peut lire les positions, comme
// pour un lien de partage Google Maps. Les messages y sont gardés quelques
// heures. Rien n'est envoyé tant que l'utilisateur n'a pas lancé le partage,
// et il s'arrête avec le guidage.

const RELAIS = "https://ntfy.sh";
// Une position toutes les deux minutes : le relais limite le nombre de
// messages par jour, et un proche n'a pas besoin de plus pour suivre.
export const INTERVALLE_PARTAGE_MS = 120000;

// Adresse de partage : 128 bits tirés au hasard.
export function creerSujet() {
  const octets = crypto.getRandomValues(new Uint8Array(16));
  return `tve-${[...octets].map((o) => o.toString(16).padStart(2, "0")).join("")}`;
}

export function estSujet(texte) {
  return /^tve-[0-9a-f]{32}$/.test(texte || "");
}

// Lien à envoyer au proche : la page de suivi, l'adresse de partage après « # »
// (cette partie n'est pas transmise au serveur du site).
export function lienSuivi(sujet, base = location.href) {
  return new URL(`./suivi.html#${sujet}`, base).href;
}

// Ce qui est publié : le strict nécessaire pour suivre l'arrivée.
//   etat : "en_route" | "a_la_borne" | "signal_perdu" | "arrive" | "termine"
export function messagePosition({ lat, lon, cap, kmh, arrivee_ms, restant_km, batterie_pct, destination, etat, maintenant = Date.now() }) {
  const arrondi = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
  return {
    v: 1,
    t: maintenant,
    etat,
    lat: arrondi(lat, 5),
    lon: arrondi(lon, 5),
    cap: arrondi(cap, 0),
    kmh: arrondi(kmh, 0),
    arrivee: arrondi(arrivee_ms, 0),
    restant_km: arrondi(restant_km, 0),
    batterie: arrondi(batterie_pct, 0),
    destination: String(destination || "").slice(0, 60),
  };
}

// Lit un message reçu ; null s'il n'est pas un message de position valide.
export function lireMessage(texte) {
  try {
    const m = JSON.parse(texte);
    return m && m.v === 1 && Number.isFinite(m.t) && typeof m.etat === "string" ? m : null;
  } catch {
    return null;
  }
}

// Renvoie true si le relais a accepté le message.
export async function publier(sujet, message) {
  try {
    const r = await fetch(`${RELAIS}/${sujet}`, { method: "POST", body: JSON.stringify(message) });
    return r.ok;
  } catch {
    return false;
  }
}

// Messages publiés depuis `depuis` (identifiant du dernier message lu, ou une
// durée comme "12h"), du plus ancien au plus récent : [{ id, message }].
export async function lireMessages(sujet, depuis = "12h") {
  const r = await fetch(`${RELAIS}/${sujet}/json?poll=1&since=${encodeURIComponent(depuis)}`);
  if (!r.ok) throw new Error(`relais indisponible (${r.status})`);
  return (await r.text())
    .split("\n")
    .filter(Boolean)
    .map((ligne) => {
      try {
        const e = JSON.parse(ligne);
        return e.event === "message" ? { id: e.id, message: lireMessage(e.message) } : null;
      } catch {
        return null;
      }
    })
    .filter((e) => e?.message);
}
