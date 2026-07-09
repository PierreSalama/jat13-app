// @jat13/shared — normalizers. Ported VERBATIM from v11 db.js so the v11 importer's dedup keys
// (job-url hash, per-profile question_norm) map 1:1 onto v12 — ask-once-ever memory survives the
// cutover. Shared by app + extension + importer + tests (one module, no drift).

/** loose slug: lowercase, non-alphanumerics → single spaces. Used for company/label keys. */
export function normKey(s: string | null | undefined): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** query params that identify the posting and must survive URL normalization (id-in-query sites). */
const KEEP_PARAMS = new Set(['currentjobid', 'jk', 'gh_jid', 'gh_src', 'lever-source', 'id']);

/** canonical job URL for dedup: origin+path (no trailing slash), only id-bearing query params kept. */
export function normJobUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (KEEP_PARAMS.has(k.toLowerCase())) keep.set(k.toLowerCase(), v);
    }
    const q = keep.toString();
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase() + (q ? `?${q}` : '');
  } catch {
    return String(raw).toLowerCase();
  }
}

// EN/FR token canonicalization + fillers so "years of experience" == "annees experience", and
// word order / language don't fork the learned-answer key. Ported from v11 db.js QA_CANON/QA_FILLERS.
const QA_CANON: Record<string, string> = {
  francais: 'french', anglais: 'english', espagnol: 'spanish', allemand: 'german',
  annee: 'years', annees: 'years', ans: 'years', an: 'years',
  experiences: 'experience',
  courriel: 'email', mail: 'email', adresse: 'address',
  prenom: 'firstname', telephone: 'phone', tel: 'phone', portable: 'phone',
  ville: 'city', pays: 'country', langue: 'language', langues: 'language',
  numero: 'number', mois: 'months', semaine: 'weeks', semaines: 'weeks',
  niveau: 'level', nom: 'name', noms: 'name',
  parlez: 'speak', parler: 'speak', parle: 'speak', parlons: 'speak',
  salaire: 'salary', remuneration: 'salary', poste: 'position',
  diplome: 'degree', formation: 'education',
  competence: 'skill', competences: 'skill',
  autorisation: 'authorization', autorise: 'authorized',
  travail: 'work', travailler: 'work', travaille: 'work', emploi: 'work',
  disponibilite: 'availability', disponible: 'available', preavis: 'notice',
};

const QA_FILLERS = new Set(
  (
    'please kindly select choose enter provide specify the a an your you do did does ' +
    'are is have has had will would can could how many much what which with in for of to at on ' +
    'veuillez selectionnez choisissez entrez indiquez precisez votre vos le la les un une des du de ' +
    'est sont avez quel quelle quels quelles combien dans pour sur au aux et ou si vous tu ton ta tes'
  ).split(/\s+/),
);

/** bag-of-words key for a screening question: fold diacritics, canonicalize EN/FR, drop fillers,
 *  dedup + SORT so word order and language don't fork the key. Caps at 120 chars. */
export function normQuestion(q: string | null | undefined): string {
  const folded = String(q || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const toks = new Set<string>();
  for (let t of folded.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    t = QA_CANON[t] || t;
    if (QA_FILLERS.has(t)) continue;
    toks.add(t);
  }
  return [...toks].sort().join(' ').slice(0, 120);
}
