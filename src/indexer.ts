import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { parseDefinitions, type Definition } from "./parser";

export function expandPath(path: string): string {
  return resolve(
    path
      .trim()
      .replace(/^~(?=\/|$)/, homedir())
      .replace(/\$\{HOME\}|\$HOME\b/g, homedir()),
  );
}

export interface IndexResult {
  definitions: Definition[];
  files: number;
  warnings: string[];
}

const ignored = new Set([".git", "node_modules", ".cache", "vendor", "dist", "build", "__pycache__"]);
const shellFile =
  /(?:\.(?:sh|zsh|bash|zshrc|bashrc|zshenv|zprofile|zlogin)$|^\.?(?:alias(?:es)?|functions|zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile)$)/i;
const scriptExtensions = new Set([
  ".sh",
  ".zsh",
  ".bash",
  ".fish",
  ".py",
  ".rb",
  ".pl",
  ".lua",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".ps1",
  ".command",
  ".applescript",
  ".awk",
  ".sed",
  ".tcl",
  ".r",
  ".php",
  ".swift",
]);
const languages: Record<string, string> = {
  ".sh": "sh",
  ".zsh": "sh",
  ".bash": "sh",
  ".command": "sh",
  ".fish": "fish",
  ".py": "python",
  ".rb": "ruby",
  ".pl": "perl",
  ".lua": "lua",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".ps1": "powershell",
  ".applescript": "applescript",
  ".swift": "swift",
  ".r": "r",
  ".php": "php",
};

// The two scopes are independent: a file can contribute shell definitions and
// also appear as a complete script, but is counted as one physical file.
export async function indexPaths(paths: string, scriptPaths = ""): Promise<IndexResult> {
  const result: IndexResult = { definitions: [], files: 0, warnings: [] };
  const indexedFiles = new Set<string>();
  const contents = new Map<string, string | null>();

  async function scan(config: string, scripts: boolean) {
    const directories = new Set<string>();
    const files = new Set<string>();
    let entries = 0;
    async function visit(path: string, explicit = false): Promise<void> {
      try {
        const canonical = await realpath(path);
        const info = await stat(canonical);
        if (info.isDirectory() && directories.has(canonical)) return;
        if (++entries > 20000) {
          if (entries === 20001)
            result.warnings.push(
              `${scripts ? "Script" : "Dotfile"} scan stopped after 20,000 entries. Choose more specific folders.`,
            );
          return;
        }
        if (info.isDirectory()) {
          directories.add(canonical);
          const children = await readdir(canonical, { withFileTypes: true });
          for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
            if (ignored.has(child.name)) continue;
            if (child.name.startsWith(".") && !shellFile.test(child.name)) continue;
            await visit(join(canonical, child.name));
          }
          return;
        }
        if (!info.isFile() || (!scripts && !explicit && !shellFile.test(basename(path)))) return;
        // Different symlink command names remain discoverable in script folders.
        const key = scripts ? `${canonical}\0${basename(path)}` : canonical;
        if (files.has(key)) return;
        files.add(key);
        if (info.size > 2 * 1024 * 1024) {
          result.warnings.push(`${path}: skipped (larger than 2 MB)`);
          return;
        }
        let text = contents.get(canonical);
        if (text === undefined) {
          const buffer = await readFile(canonical);
          text = buffer.includes(0) ? null : buffer.toString("utf8");
          contents.set(canonical, text);
        }
        if (text === null) return;
        if (scripts) {
          const extension = extname(path).toLowerCase();
          // A shebang also discovers executable scripts without extensions.
          if (!scriptExtensions.has(extension) && !text.startsWith("#!")) return;
          result.definitions.push({
            id: `script:${canonical}:${basename(path)}`,
            name: basename(path),
            kind: "script",
            definition: text,
            file: canonical,
            line: 1,
            language: languages[extension] ?? "",
          });
        } else {
          result.definitions.push(...parseDefinitions(text, canonical));
        }
        indexedFiles.add(canonical);
      } catch (error) {
        // Optional default startup files do not exist on every machine.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          result.warnings.push(`${path}: ${(error as Error).message}`);
      }
    }
    for (const path of config
      .split(/[;\r\n]/)
      .map((path) => path.trim())
      .filter(Boolean))
      await visit(expandPath(path), true);
  }

  await scan(paths, false);
  await scan(scriptPaths, true);
  result.files = indexedFiles.size;
  return result;
}
