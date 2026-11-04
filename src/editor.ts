import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import type { Definition } from "./parser";

const execFileAsync = promisify(execFile);
export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export interface EditorEnvironment {
  visual: string;
  editor: string;
  path: string;
  shell: string;
}

export async function readEditorEnvironment(): Promise<EditorEnvironment> {
  const shell = process.env.SHELL || "/bin/zsh";
  // Raycast is a GUI process: its environment may not include shell exports.
  // NUL framing separates the requested fields from arbitrary startup output.
  const { stdout } = await execFileAsync(
    shell,
    ["-ilc", 'printf "\\0RAYCAST_DOTFILE_ENV\\0%s\\0%s\\0%s\\0" "$VISUAL" "$EDITOR" "$PATH"'],
    {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      cwd: homedir(),
    },
  );
  const marker = "\0RAYCAST_DOTFILE_ENV\0";
  const start = stdout.lastIndexOf(marker);
  if (start < 0) throw new Error("Could not read VISUAL and EDITOR from your login shell.");
  const [visual, editor, path] = stdout.slice(start + marker.length).split("\0");
  return { visual: visual.trim(), editor: editor.trim(), path, shell };
}

export function editorCommand(
  editor: string,
  item: Pick<Definition, "file" | "line">,
): { command: string; terminal: boolean } {
  const firstWord = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(editor.trim());
  const executable = basename(firstWord?.[1] ?? firstWord?.[2] ?? firstWord?.[3] ?? "");
  let args: string[];
  const terminal = /^(?:vi|vim|nvim|nano|pico|emacs|hx|helix)$/.test(executable);
  if (/^(?:code|code-insiders|codium|cursor|windsurf)$/.test(executable))
    args = ["--goto", `${item.file}:${item.line}`];
  else if (/^(?:zed|subl|mate|hx|helix)$/.test(executable)) args = [`${item.file}:${item.line}`];
  else if (/^(?:vi|vim|nvim|nano|pico|emacs|emacsclient)$/.test(executable)) args = [`+${item.line}`, item.file];
  else args = [item.file];
  return { command: `${editor} ${args.map(shellQuote).join(" ")}`, terminal };
}

export async function openDefinition(item: Definition): Promise<void> {
  const env = await readEditorEnvironment();
  const editor = env.visual || env.editor;
  if (!editor) throw new Error("Neither VISUAL nor EDITOR is set in your login shell. Set one and try again.");
  const { command, terminal } = editorCommand(editor, item);
  if (terminal) {
    const terminalCommand = `cd ${shellQuote(homedir())} && ${command}`;
    const appleString =
      '"' +
      terminalCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") +
      '"';
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application "Terminal"\nactivate\ndo script ${appleString}\nend tell`,
    ]);
    return;
  }
  // Preserve editor flags/quoting, and use the PATH from the interactive shell.
  // A configured --wait editor can stay open without keeping the Raycast action busy.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(env.shell, ["-c", `exec ${command}`], {
      env: { ...process.env, PATH: env.path },
      cwd: homedir(),
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.stderr?.destroy();
      child.unref();
      resolve();
    }, 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code && code !== 0) reject(new Error(stderr.trim() || `Editor exited with status ${code}.`));
      else resolve();
    });
  });
}
