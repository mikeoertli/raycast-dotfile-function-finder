import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefinitions, searchDefinitions } from "../src/parser";
import { indexPaths } from "../src/indexer";
import { editorCommand, shellQuote } from "../src/editor";

const parse = (text: string) => parseDefinitions(text, "/test/aliases.zsh");

test("aliases: flags, multiple assignments, quoted names, comments and continuations", () => {
  const items = parse(
    "# alias nope='false'\nalias -g G='| grep' L='| less'\nalias 'g-co'='git checkout'\nalias multi='first\nsecond'\nalias \\\n continued='yes'\n",
  );
  assert.deepEqual(
    items.map((item) => [item.name, item.line]),
    [
      ["G", 2],
      ["L", 2],
      ["g-co", 3],
      ["multi", 4],
      ["continued", 6],
    ],
  );
  assert.equal(items[1].definition, "alias -g L='| less'");
  assert.equal(items[3].definition, "alias multi='first\nsecond'");
});

test("complete function bodies preserve braces, quotes, nested substitutions and comments", () => {
  const definition = `function example-name()\n{\n  local value=\${1:-fallback}\n  echo "}" '\${literal}' "$(printf '%s' "$(echo nested)")"\n  # } ignored\n  if true; then { echo ok; }; fi\n}`;
  const items = parse(`${definition}\nnext() { echo next; }\n`);
  assert.equal(items.length, 2);
  assert.equal(items[0].definition, definition);
  assert.equal(items[1].name, "next");
  assert.equal(items[1].line, 8);
});

test("heredoc text never becomes a definition or closes a function", () => {
  const text = `with_doc() {\ncat <<'EOF'\n}\nalias fake='wrong'\nEOF\ncat <<-END\n\t}\n\tEND\necho done\n}\nalias real='yes'\n`;
  const items = parse(text);
  assert.deepEqual(
    items.map((item) => item.name),
    ["with_doc", "real"],
  );
  assert.ok(items[0].definition.endsWith("echo done\n}"));
});

test("here-strings do not hide subsequent definitions", () => {
  const items = parse(`one() { cat <<< "hello"; }\nalias after='yes'\n`);
  assert.deepEqual(
    items.map((item) => item.name),
    ["one", "after"],
  );
});

test("conditional definitions included, quoted examples and function-local aliases excluded", () => {
  const items = parse(
    `echo "alias fake='no'\nphony() { echo no; }"\nif true; then alias yes='ok'; fi\nfunction good { alias local_only='no'; }\n`,
  );
  assert.deepEqual(
    items.map((item) => item.name),
    ["yes", "good"],
  );
});

test("case-insensitive fuzzy ranking and exact whole-name matching", () => {
  const items = parse("alias gco='1'\nalias git_checkout='2'\nalias gcount='3'\nalias GCO='4'\n");
  assert.deepEqual(
    searchDefinitions(items, "GcO", "exact")
      .map((item) => item.name)
      .sort(),
    ["GCO", "gco"],
  );
  assert.deepEqual(searchDefinitions(items, "git_", "exact"), []);
  assert.equal(searchDefinitions(items, "GCO", "fuzzy").length, 4);
  assert.equal(searchDefinitions(items, "gco", "fuzzy")[0].name.toLowerCase(), "gco");
  assert.equal(searchDefinitions(items, "missing", "fuzzy").length, 0);
  assert.equal(searchDefinitions(items, " ", "exact").length, 4);
});

test("indexing recurses, follows and deduplicates symlinks, skips dependencies and reads explicit files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dotfile-finder-test-"));
  try {
    await mkdir(join(dir, "nested"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "nested", "alias.zsh"), "alias real='true'\n");
    await writeFile(join(dir, "node_modules", "hidden.sh"), "alias hidden='false'\n");
    await writeFile(join(dir, "notes.txt"), "alias explicit='yes'\n");
    await symlink(join(dir, "nested", "alias.zsh"), join(dir, ".aliases"));
    await symlink(dir, join(dir, "nested", "loop"));
    const result = await indexPaths(
      [dir, join(dir, ".aliases"), join(dir, "notes.txt"), join(dir, "missing")].join("\n"),
    );
    assert.deepEqual(result.definitions.map((item) => item.name).sort(), ["explicit", "real"]);
    assert.equal(result.files, 2);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editor arguments preserve flags and safely quote paths with shell metacharacters", () => {
  const item = { file: "/tmp/Mike's $(touch nope).zsh", line: 42 };
  const code = editorCommand("code --reuse-window", item);
  assert.equal(code.command, `code --reuse-window '--goto' ${shellQuote(item.file + ":42")}`);
  assert.equal(code.terminal, false);
  assert.equal(editorCommand("zed", item).command, `zed ${shellQuote(item.file + ":42")}`);
  assert.equal(editorCommand("nvim -f", item).command, `nvim -f '+42' ${shellQuote(item.file)}`);
  assert.equal(editorCommand("nvim", item).terminal, true);
  assert.equal(editorCommand("custom-editor", item).command, `custom-editor ${shellQuote(item.file)}`);
});

test("arithmetic shifts are not heredocs and ANSI quoted aliases retain escaped quotes", () => {
  const text = "shifted() { (( value = 1 << 4 )); echo $value; }\nalias quoted=$'it\\'s a quote'\nalias after='ok'\n";
  const items = parse(text);
  assert.deepEqual(
    items.map((item) => item.name),
    ["shifted", "quoted", "after"],
  );
  assert.equal(items[1].definition, "alias quoted=$'it\\'s a quote'");
});

test("fuzzy search treats spaces, dashes and underscores as optional separators", () => {
  const items = parse(
    "alias git_checkout='git checkout'\nalias git-checkout='git checkout'\nalias gitcheckout='git checkout'\n",
  );
  for (const query of ["GIT CHECKOUT", "git-checkout", "git_checkout", "gitcheckout", "g c o"]) {
    assert.equal(searchDefinitions(items, query, "fuzzy").length, 3, query);
  }
  assert.deepEqual(searchDefinitions(items, "git checkout", "exact"), []);
  assert.deepEqual(
    searchDefinitions(items, "GIT_CHECKOUT", "exact").map((item) => item.name),
    ["git_checkout"],
  );
});

test("fuzzy search includes alias expansions and function contents while ranking names first", () => {
  const items = parse(
    "alias ports='lsof -i TCP'\ninspect() {\n  kubectl get deployment\n  echo Service-Account\n}\nalias kubectl_get='true'\n",
  );
  assert.ok(searchDefinitions(items, "LSOF", "fuzzy").some((item) => item.name === "ports"));
  assert.ok(searchDefinitions(items, "service account", "fuzzy").some((item) => item.name === "inspect"));
  assert.ok(searchDefinitions(items, "k g d p", "fuzzy").some((item) => item.name === "inspect"));
  const matches = searchDefinitions(items, "kubectl get", "fuzzy");
  assert.deepEqual(
    matches.map((item) => item.name),
    ["kubectl_get", "inspect"],
  );
  assert.deepEqual(searchDefinitions(items, "lsof", "exact"), []);
  assert.equal(searchDefinitions(items, "   - _ ", "fuzzy").length, 3);
});

test("large indexes retain, search and page every result beyond 4,999", async () => {
  const { resultPage, RESULTS_PER_PAGE } = await import("../src/results");
  const dir = await mkdtemp(join(tmpdir(), "dotfile-finder-large-test-"));
  try {
    await writeFile(
      join(dir, "large.zsh"),
      Array.from({ length: 6201 }, (_, i) => `alias entry_${String(i).padStart(5, "0")}='echo value ${i}'`).join("\n"),
    );
    const result = await indexPaths(dir);
    assert.equal(result.definitions.length, 6201);
    assert.deepEqual(result.warnings, []);
    const matches = searchDefinitions(result.definitions, "", "fuzzy");
    const visited = new Set<string>();
    for (let page = 0; page < Math.ceil(matches.length / RESULTS_PER_PAGE); page++) {
      const visible = resultPage(matches, page);
      assert.ok(visible.items.length <= RESULTS_PER_PAGE);
      for (const item of visible.items) visited.add(item.id);
    }
    assert.equal(visited.size, 6201);
    assert.equal(searchDefinitions(result.definitions, "ENTRY_06200", "exact")[0].name, "entry_06200");
    assert.ok(searchDefinitions(result.definitions, "value 6200", "fuzzy").some((item) => item.name === "entry_06200"));
    assert.equal(resultPage(matches, 999).end, 6201);
    assert.equal(resultPage([], 9).page, 0);
    assert.equal(resultPage([], 9).start, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("alias flags distinguish ordinary, global and suffix aliases", () => {
  const items = parse("alias plain='true'\nalias -g G='| grep'\nalias -Lg H='| head'\nalias -s py='python3'\n");
  assert.deepEqual(
    items.map((item) => [item.name, item.kind]),
    [
      ["plain", "alias"],
      ["G", "glob alias"],
      ["H", "glob alias"],
      ["py", "suffix alias"],
    ],
  );
  assert.equal(items[1].definition, "alias -g G='| grep'");
});

test("script folders discover script names and complete bodies without executing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dotfile-script-test-"));
  try {
    await mkdir(join(dir, "nested"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "deploy-tool.py"), "#!/usr/bin/env python3\nprint('refresh deployment')\n");
    await writeFile(join(dir, "nested", "cleanup"), "#!/bin/sh\necho clear cached containers\n");
    await writeFile(join(dir, "readme.md"), "Not a script");
    await writeFile(join(dir, "binary.sh"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(dir, "node_modules", "hidden.js"), "console.log('hidden')");
    await symlink(dir, join(dir, "nested", "loop"));
    await symlink(join(dir, "deploy-tool.py"), join(dir, "deploy-shortcut"));
    const result = await indexPaths("", `${dir}; ${dir}`);
    assert.deepEqual(result.definitions.map((item) => item.name).sort(), [
      "cleanup",
      "deploy-shortcut",
      "deploy-tool.py",
    ]);
    assert.ok(result.definitions.every((item) => item.kind === "script" && item.line === 1));
    assert.equal(result.files, 2);
    assert.deepEqual(result.warnings, []);
    const script = result.definitions.find((item) => item.name === "deploy-tool.py")!;
    assert.equal(script.language, "python");
    assert.equal(script.definition, "#!/usr/bin/env python3\nprint('refresh deployment')\n");
    assert.ok(searchDefinitions(result.definitions, "REFRESH DEPLOYMENT", "fuzzy").includes(script));
    assert.ok(searchDefinitions(result.definitions, "deploy tool.py", "fuzzy").includes(script));
    assert.deepEqual(searchDefinitions(result.definitions, "DEPLOY-TOOL.PY", "exact"), [script]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dotfile and script scopes independently index the same physical file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dotfile-script-overlap-"));
  try {
    const path = join(dir, "helpers.sh");
    await writeFile(path, "#!/bin/sh\nhelper() { echo yes; }\n");
    const result = await indexPaths(dir, dir);
    assert.deepEqual(
      result.definitions.map((item) => [item.name, item.kind]),
      [
        ["helper", "function"],
        ["helpers.sh", "script"],
      ],
    );
    assert.equal(result.files, 1);
    assert.equal(new Set(result.definitions.map((item) => item.id)).size, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
