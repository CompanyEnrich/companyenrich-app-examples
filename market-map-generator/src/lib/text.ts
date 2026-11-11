/**
 * Turns free text (company descriptions, industries, keywords) into terms for TF-IDF.
 *
 * A term is either a single word or a two-word phrase ("accounts payable"), lowercased and
 * lightly stemmed so "invoice" and "invoices" count as the same term. Each term also keeps the
 * surface form it was written in, so cluster names can show real words instead of stems.
 */

export interface Term {
  /** Stemmed key used for counting, e.g. "account payable". */
  key: string;
  /** The words as written (lowercased), e.g. "accounts payable". */
  surface: string;
}

/** Common English words, plus filler that shows up in almost every company description. */
const STOPWORDS = new Set(
  `a about across after all also an and any are as at be been being best both build builds built but by can
  company companies could do does each easy enable enables enabling end every for from full get gives global
  has have help helps helping how in inc including into is it its just leading leader leverage leverages llc ltd
  make makes making more most new next no not of on one only or other our out over own platform platforms
  power powered provide provider provides providing real so solution solutions such than that the their them
  then there these they this those through to today tool tools trusted under up us use used uses using via
  was way we well what when where which while who whose will with within without world worldwide you your
  based founded headquartered offer offers offering service services software customer customers client clients
  business businesses organization organizations enterprise enterprises team teams time first
  develop develops developing existing support supports supporting handle handles handling connect connects
  serve serves serving designed focus focuses focused emphasize emphasizes related various range wide key
  include includes deliver delivers operate operates allow allows ensure ensures
  multiple several many different specific critical complex entire major large small high better faster
  north south america americas europe asia africa emea apac latam globally
  ai-powered ai-driven ai-native ai-first end-to-end real-time cloud-based data-driven next-generation best-in-class`.split(/\s+/),
);

/** Short words that read better in upper case when they appear in a category name. */
const ACRONYMS = new Map(
  ['ai', 'ap', 'ar', 'api', 'b2b', 'b2c', 'bi', 'cfo', 'co2', 'crm', 'csrd', 'erp', 'esg', 'fp&a', 'gaap', 'ghg', 'hr', 'kyc', 'aml', 'llm', 'ml', 'ocr', 'rpa', 'saas', 'smb', 'sme', 'sox', 'usa', 'uk', 'eu'].map(
    (word) => [word, word === 'saas' ? 'SaaS' : word.toUpperCase()],
  ),
);

/** Punctuation that ends a phrase: two words on either side of it never form a two-word term. */
const PHRASE_BREAK = /[.,;:!?()[\]{}"|/\n–—]+|\s-\s/;
/** A word, keeping joined forms whole: "fp&a", "order-to-cash", "e-invoicing". */
const WORD = /[a-z0-9]+(?:[-&+][a-z0-9]+)*/g;
/** Small words left in lower case inside a hyphenated name: "Order-to-Cash". */
const CONNECTORS = new Set(['to', 'of', 'and', 'in', 'for', 'the', 'by', 'as']);

/** Strips common English plural endings. Deliberately tiny: good enough to merge "invoices" with "invoice". */
export function stem(word: string): string {
  if (word.length <= 3 || ACRONYMS.has(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || /(x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(ss|us|is|as)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * The counting key for one word. A two-part hyphenated word gets the same key as the two words
 * written apart, so a hint keyword "net zero" matches "net-zero" in a description. Longer joined
 * forms ("order-to-cash") and ones with a one-letter part ("e-invoicing") stay whole.
 */
export function termKey(word: string): string {
  const parts = word.split('-');
  return parts.length === 2 && parts.every((part) => part.length >= 2) ? parts.map(stem).join(' ') : stem(word);
}

/** The stemmed words of a short text, used to build ignore lists (a company's own name, a theme title). */
export function wordKeys(text: string): Set<string> {
  return new Set([...normalize(text).matchAll(WORD)].map((match) => termKey(match[0])));
}

/**
 * Extracts single words and adjacent two-word phrases. Stopwords, numbers and any word whose stem is
 * in `ignore` are dropped, and a phrase is only formed from two words that were next to each other.
 */
export function extractTerms(text: string, ignore: ReadonlySet<string> = new Set()): Term[] {
  const terms: Term[] = [];
  for (const segment of normalize(text).split(PHRASE_BREAK)) {
    let previous: { word: string; key: string } | null = null;
    for (const match of segment.matchAll(WORD)) {
      const word = match[0];
      const key = termKey(word);
      if (word.length < 2 || /^\d+$/.test(word) || STOPWORDS.has(word) || ignore.has(key)) {
        previous = null;
        continue;
      }
      terms.push({ key, surface: word });
      if (previous) terms.push({ key: `${previous.key} ${key}`, surface: `${previous.word} ${word}` });
      previous = { word, key };
    }
  }
  return terms;
}

/** "accounts payable" -> "Accounts Payable", "fp&a" -> "FP&A", "order-to-cash" -> "Order-to-Cash". */
export function titleCase(phrase: string): string {
  const capitalize = (word: string, index: number) =>
    ACRONYMS.get(word) ?? (index > 0 && CONNECTORS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1));
  return phrase
    .split(' ')
    .map((word) => word.split('-').map(capitalize).join('-'))
    .join(' ');
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/['’]s\b/g, '');
}
