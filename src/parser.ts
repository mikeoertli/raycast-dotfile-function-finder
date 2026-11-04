export interface Definition {
  id: string;
  name: string;
  kind: "alias" | "glob alias" | "suffix alias" | "function" | "script";
  language?: string;
  definition: string;
  file: string;
  line: number;
}

interface Token {
  value: string;
  start: number;
  end: number;
}

// Lex shell text without evaluating it. Quoted strings, substitutions, comments,
// and heredoc bodies must not become apparent definitions or closing braces.
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  function quoted(quote: string) {
    const ansi = quote === "'" && text[i - 1] === "$";
    i++;
    while (i < text.length) {
      if (text[i] === quote) {
        i++;
        return;
      }
      if ((quote !== "'" || ansi) && text[i] === "\\") i += 2;
      else if (quote !== "'" && text[i] === "$" && /[({]/.test(text[i + 1] ?? "")) expansion();
      else i++;
    }
  }
  function expansion() {
    const open = text[i + 1];
    const close = open === "(" ? ")" : "}";
    i += 2;
    let depth = 1;
    while (i < text.length && depth) {
      const ch = text[i];
      if (ch === "\\") i += 2;
      else if (ch === "'" || ch === '"' || ch === "`") quoted(ch);
      else if (ch === "$" && /[({]/.test(text[i + 1] ?? "")) expansion();
      else {
        if (ch === open) depth++;
        if (ch === close) depth--;
        i++;
      }
    }
  }
  while (i < text.length) {
    const start = i;
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "\n") {
      tokens.push({ value: "\n", start, end: ++i });
      for (const doc of heredocs.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf("\n", i);
          const stop = end < 0 ? text.length : end;
          const line = text.slice(i, stop).replace(/\r$/, "");
          i = end < 0 ? text.length : end + 1;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text.startsWith("((", i)) {
      let depth = 0;
      do {
        if (text[i] === "\\") i += 2;
        else if (text[i] === "'" || text[i] === '"' || text[i] === "`") quoted(text[i]);
        else {
          if (text[i] === "(") depth++;
          if (text[i] === ")") depth--;
          i++;
        }
      } while (i < text.length && depth > 0);
      tokens.push({ value: text.slice(start, i), start, end: i });
      continue;
    }
    if (text.startsWith("<<<", i)) {
      i += 3;
      tokens.push({ value: "<<<", start, end: i });
      continue;
    }
    if (text.startsWith("<<", i)) {
      i += 2;
      const tabs = text[i] === "-";
      if (tabs) i++;
      while (text[i] === " " || text[i] === "\t") i++;
      const delimiterStart = i;
      while (i < text.length && !/[\s;<>|&]/.test(text[i])) {
        if (text[i] === "'" || text[i] === '"') quoted(text[i]);
        else if (text[i] === "\\") i += 2;
        else i++;
      }
      heredocs.push({ delimiter: text.slice(delimiterStart, i).replace(/["'\\]/g, ""), tabs });
      tokens.push({ value: "<<", start, end: i });
      continue;
    }
    if (/[;|&()<>]/.test(ch) || ((ch === "{" || ch === "}") && /[\s;|&()<>]|^$/.test(text[i + 1] ?? ""))) {
      tokens.push({ value: ch, start, end: ++i });
      continue;
    }
    while (i < text.length && !/[\s;|&()<>]/.test(text[i])) {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "'" || text[i] === '"' || text[i] === "`") quoted(text[i]);
      else if (text[i] === "$" && /[({]/.test(text[i + 1] ?? "")) expansion();
      else i++;
    }
    tokens.push({ value: text.slice(start, i), start, end: i });
  }
  return tokens;
}

export function parseDefinitions(text: string, file: string): Definition[] {
  const tokens = tokenize(text);
  const result: Definition[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  function add(name: string, kind: Definition["kind"], start: number, end: number, definition?: string) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid] <= start) low = mid;
      else high = mid;
    }
    result.push({
      id: `${file}:${start}:${name}`,
      name,
      kind,
      file,
      line: low + 1,
      definition: definition ?? text.slice(start, end),
    });
  }
  const namePattern = /^[\w.:+@%/-]+$/;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Definitions can be nested in conditionals, but not in arbitrary command arguments.
    const previous = tokens[i - 1]?.value;
    if (i && !["\n", ";", "&", "|", "then", "else", "do", "{"].includes(previous)) continue;
    if (token.value === "alias") {
      let j = i + 1;
      const flags: string[] = [];
      while (/^-[\w-]+$/.test(tokens[j]?.value ?? "")) flags.push(tokens[j++].value);
      // Zsh calls -g a global alias; use the requested "glob alias" UI label.
      const options = flags.join("");
      const kind = options.includes("g") ? "glob alias" : options.includes("s") ? "suffix alias" : "alias";
      while (j < tokens.length) {
        const assignment = tokens[j];
        const match = /^(?:([\w.:+@%/-]+)|'([^']+)'|"([^"]+)")=/.exec(assignment.value);
        if (!match) break;
        const name = match[1] ?? match[2] ?? match[3];
        const definition = `alias ${flags.length ? flags.join(" ") + " " : ""}${assignment.value}`;
        add(name, kind, token.start, assignment.end, definition);
        j++;
      }
      i = j - 1;
      continue;
    }
    let j = i;
    if (tokens[j].value === "function") j++;
    const name = tokens[j]?.value;
    if (!name || !namePattern.test(name)) continue;
    j++;
    if (tokens[j]?.value === "(" && tokens[j + 1]?.value === ")") j += 2;
    else if (token.value !== "function") continue;
    while (tokens[j]?.value === "\n") j++;
    if (tokens[j]?.value !== "{") continue;
    let depth = 1;
    const bodyStart = j;
    while (++j < tokens.length) {
      if (tokens[j].value === "{") depth++;
      if (tokens[j].value === "}") depth--;
      if (!depth) break;
    }
    if (j === tokens.length) {
      // Keep scanning after an unsupported/malformed function rather than hiding the rest of the file.
      i = bodyStart;
      continue;
    }
    add(name, "function", token.start, tokens[j].end);
    i = j;
  }
  return result;
}

export type SearchMode = "fuzzy" | "exact";

// Separators are optional in fuzzy mode: "git co", "git-co", "git_co",
// and "gitco" use the same search text. Exact mode keeps punctuation intact.
const normalizeFuzzy = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");

export interface SearchEntry {
  item: Definition;
  name: string;
  fuzzyName: string;
  fuzzyDefinition: string;
}

export function createSearchIndex(items: Definition[]): SearchEntry[] {
  return items.map((item) => ({
    item,
    name: item.name.toLowerCase(),
    fuzzyName: normalizeFuzzy(item.name),
    fuzzyDefinition: normalizeFuzzy(item.definition),
  }));
}

// Higher is better; non-matches return -1. Bounded scores keep long function
// bodies searchable without allowing their length to swamp the match tiers.
function similarity(value: string, needle: string): number {
  const substring = value.indexOf(needle);
  if (substring >= 0) return 2 + 1 / (1 + substring + value.length / 1000);
  let position = -1;
  let gaps = 0;
  for (const character of needle) {
    const next = value.indexOf(character, position + 1);
    if (next < 0) return -1;
    gaps += next - position - 1;
    position = next;
  }
  return 1 / (1 + gaps + value.length / 1000);
}

export function searchIndex(entries: SearchEntry[], query: string, mode: SearchMode): Definition[] {
  const exactNeedle = query.trim().toLowerCase();
  const fuzzyNeedle = normalizeFuzzy(query);
  function score(entry: SearchEntry): number {
    if (!exactNeedle) return 0;
    if (entry.name === exactNeedle) return 20;
    if (mode === "exact") return -1;
    // Separator-only queries act as an empty fuzzy query.
    if (!fuzzyNeedle) return 0;
    if (entry.fuzzyName === fuzzyNeedle) return 19;
    const nameScore = similarity(entry.fuzzyName, fuzzyNeedle);
    if (nameScore >= 0) return 10 + nameScore;
    return similarity(entry.fuzzyDefinition, fuzzyNeedle);
  }
  return entries
    .map((entry) => ({ item: entry.item, score: score(entry) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.name.localeCompare(b.item.name) ||
        a.item.file.localeCompare(b.item.file) ||
        a.item.line - b.item.line,
    )
    .map(({ item }) => item);
}

export function searchDefinitions(items: Definition[], query: string, mode: SearchMode): Definition[] {
  return searchIndex(createSearchIndex(items), query, mode);
}
