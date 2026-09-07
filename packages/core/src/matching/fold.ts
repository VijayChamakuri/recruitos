/**
 * The committed quote-fold policy version. Frozen at rubric lock alongside the
 * text normalization policy and recorded on the run input snapshot, so a later
 * change to this table cannot silently reinterpret a recorded offset.
 */
export const QUOTE_FOLD_POLICY_VERSION = 1;

const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

/**
 * Punctuation half of the committed fold table. Every entry maps exactly one
 * UTF-16 code unit to exactly one UTF-16 code unit, so folding never inserts,
 * deletes, or reorders a code unit and an index into folded text is the same
 * index into the stored text.
 *
 * Scope is deliberately narrow: the quote family and the dash family, written
 * as escapes so the file itself stays plain ASCII. Characters outside this
 * table are never rewritten. In particular:
 *
 * - Only ASCII `A` through `Z` case-fold. `U+0130` (Turkish dotted capital I)
 *   lowercases to two code units and `U+0131` (dotless i) has no ASCII
 *   counterpart, so neither is foldable one-to-one and neither is in the table.
 * - The nonbreaking space `U+00A0` is not folded to a plain space. The plan
 *   scopes tier-2 folding to case, quotes, and dashes, so a quote whose spacing
 *   differs from the source falls through to the fuzzy tier rather than being
 *   silently rewritten here.
 * - Guillemets are bracketing punctuation rather than interchangeable with the
 *   ASCII double quote, so they are excluded.
 * - Surrogate code units are never keys, so astral characters, emoji, and
 *   combining marks pass through untouched.
 */
const PUNCTUATION_FOLDS: readonly (readonly [string, string])[] = [
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201a", "'"],
  ["\u201b", "'"],
  ["\u2032", "'"],
  ["\u2035", "'"],
  ["\u02bc", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u201e", '"'],
  ["\u201f", '"'],
  ["\u2033", '"'],
  ["\u2036", '"'],
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2015", "-"],
  ["\u2212", "-"]
];

function buildFoldTable(): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  for (let index = 0; index < ASCII_UPPERCASE.length; index += 1) {
    table.set(ASCII_UPPERCASE.charAt(index), ASCII_LOWERCASE.charAt(index));
  }
  for (const [from, to] of PUNCTUATION_FOLDS) {
    table.set(from, to);
  }
  return table;
}

/**
 * The whole committed fold table: ASCII case plus the quote and dash families.
 * Exposed so tests can assert the one-to-one property directly and so the
 * Trust Center can list exactly what tier-2 matching is allowed to ignore.
 */
export const QUOTE_FOLD_TABLE: ReadonlyMap<string, string> = buildFoldTable();

/**
 * Applies the committed fold table code unit by code unit. Length preserving
 * by construction, so `foldForMatching(text).indexOf(foldForMatching(quote))`
 * is directly a valid start offset into `text`.
 */
export function foldForMatching(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charAt(index);
    folded += QUOTE_FOLD_TABLE.get(codeUnit) ?? codeUnit;
  }
  return folded;
}
