// Moyens de paiement de l'utilisateur (Menu › Payer aux bornes) et ce qu'ils
// permettent sur une borne donnée. Les bases de bornes ne disent pas quel
// badge passe où : seuls la carte bancaire (déclaration officielle), la
// gratuité et le réseau de la borne sont sûrs ; le badge reste « probable ».

export const RESEAUX_PAIEMENT = [
  { id: "ionity", nom: "Ionity", motif: /ionity/i },
  { id: "totalenergies", nom: "TotalEnergies", motif: /total\s*[eé]nergies/i },
  { id: "tesla", nom: "Tesla", motif: /tesla/i },
  { id: "electra", nom: "Electra", motif: /electra/i },
  { id: "fastned", nom: "Fastned", motif: /fastned/i },
  { id: "powerdot", nom: "Power Dot", motif: /power\s*dot/i },
  { id: "lidl", nom: "Lidl", motif: /lidl/i },
  { id: "vianeo", nom: "Engie Vianeo", motif: /vianeo/i },
  { id: "allego", nom: "Allego", motif: /allego/i },
  { id: "zunder", nom: "Zunder", motif: /zunder/i },
  { id: "atlante", nom: "Atlante", motif: /atlante/i },
  { id: "izivia", nom: "Izivia", motif: /izivia/i },
];

// Par défaut : une carte bancaire sans contact, rien d'autre.
export function lireMoyens(reglages) {
  const m = reglages?.moyens_paiement || {};
  return { cb: m.cb !== false, badge: m.badge === true, reseaux: Array.isArray(m.reseaux) ? m.reseaux : [] };
}

export function reseauDeLaBorne(borne) {
  const o = borne.officiel && !borne.officiel.indisponible ? borne.officiel : null;
  const texte = [borne.operateur, o?.operateur, o?.enseigne, borne.nom_borne || borne.nom].filter(Boolean).join(" ");
  return RESEAUX_PAIEMENT.find((r) => r.motif.test(texte)) || null;
}

// { niveau: "sur" | "probable" | "incertain", texte }
export function facilitePaiement(borne, moyens) {
  const o = borne.officiel && !borne.officiel.indisponible ? borne.officiel : null;
  const reseau = reseauDeLaBorne(borne);
  if (o?.gratuit === "oui") return { niveau: "sur", texte: "Recharge gratuite : rien à payer." };
  if (reseau && moyens.reseaux.includes(reseau.id)) return { niveau: "sur", texte: `Ton appli ${reseau.nom} fonctionne ici.` };
  if (moyens.cb && o?.paiement_cb === "oui") return { niveau: "sur", texte: "Ta carte bancaire est acceptée." };
  if (moyens.cb && o?.paiement_cb === "partiel") return { niveau: "probable", texte: "Carte bancaire acceptée sur une partie des points seulement." };
  // Les Superchargeurs Tesla ne prennent pas les badges : appli Tesla seulement.
  if (moyens.badge && reseau?.id !== "tesla") return { niveau: "probable", texte: "Ton badge multi-réseaux devrait passer : vérifie-le dans son appli." };
  if (moyens.cb && !o && borne.paiement_cb_probable) return { niveau: "probable", texte: "Carte bancaire probablement acceptée (non confirmé)." };
  return {
    niveau: "incertain",
    texte: reseau ? `Aucun de tes moyens n'est confirmé ici : prévois l'appli ${reseau.nom}.` : "Aucun de tes moyens n'est confirmé ici : prévois l'appli du réseau ou le QR code de la borne.",
  };
}
