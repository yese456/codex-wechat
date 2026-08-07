import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** True if `absPath` is the same as or strictly inside `root` (after resolve). */
export function isUnderDir(absPath: string, root: string): boolean {
  const a = resolve(absPath);
  const r = resolve(root);
  if (a === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return a.startsWith(prefix);
}

/**
 * Resolve path and ensure it stays under root after realpath (blocks symlink escape).
 * For files that do not yet exist, realpath the parent directory.
 */
export function resolveUnderRoot(
  inputPath: string,
  root: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
  const rootAbs = resolve(root);
  if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    return { ok: false, reason: `根目录不存在或不是目录: ${rootAbs}` };
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    return { ok: false, reason: `无法解析根目录: ${rootAbs}` };
  }

  const candidate = resolve(rootAbs, inputPath);
  // Must be under root even before realpath
  if (!isUnderDir(candidate, rootAbs) && !isUnderDir(candidate, rootReal)) {
    return { ok: false, reason: "路径超出允许目录" };
  }

  try {
    if (existsSync(candidate)) {
      const real = realpathSync(candidate);
      if (!isUnderDir(real, rootReal)) {
        return { ok: false, reason: "路径（含符号链接）超出允许目录" };
      }
      return { ok: true, abs: real };
    }
    // Parent must exist and stay under root
    const parent = dirname(candidate);
    if (!existsSync(parent)) {
      return { ok: false, reason: `父目录不存在: ${parent}` };
    }
    const parentReal = realpathSync(parent);
    if (!isUnderDir(parentReal, rootReal)) {
      return { ok: false, reason: "路径（含符号链接）超出允许目录" };
    }
    return { ok: true, abs: candidate };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export function assertDirectory(abs: string): void {
  if (!existsSync(abs)) {
    throw new Error(`目录不存在: ${abs}`);
  }
  const st = statSync(abs);
  if (!st.isDirectory()) {
    throw new Error(`不是目录: ${abs}`);
  }
}

/**
 * Resolve an existing directory to its canonical path and require it to stay
 * under at least one canonical policy root. A symlink inside a root that points
 * outside the root is rejected.
 */
export function canonicalDirectoryUnderRoots(
  absPath: string,
  roots: string[],
): string {
  assertDirectory(absPath);
  const targetReal = realpathSync(absPath);
  const rootReals: string[] = [];
  for (const root of roots) {
    const rootAbs = resolve(root);
    if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) continue;
    rootReals.push(realpathSync(rootAbs));
  }
  if (rootReals.length === 0) {
    throw new Error("允许的根目录均不存在或不是目录");
  }
  if (!rootReals.some((root) => isUnderDir(targetReal, root))) {
    throw new Error(
      `目录 realpath 超出允许范围：\n${rootReals.map((r) => `  - ${r}`).join("\n")}`,
    );
  }
  return targetReal;
}
