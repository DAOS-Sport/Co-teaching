import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RUNTIME_GLOBALS = new Set([
  "process", "require", "module", "exports", "global", "globalThis", "Deno", "Bun",
  "Buffer", "__dirname", "__filename", "setImmediate", "clearImmediate",
  "fetch", "XMLHttpRequest", "WebSocket", "window", "document", "navigator", "self",
  "eval", "Function",
]);
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const sourceFile = (name) => SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
const relativeImport = (specifier) => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
const literalText = (node) => ts.isStringLiteralLike(node) ? node.text : undefined;

/**
 * Parse every core source, resolve every module edge, then reject cycles.
 * No target source is executed and no package resolver or config is loaded.
 */
export async function checkCoreBoundaries(coreDirectory = path.resolve("server/core")) {
  const requestedRoot = path.resolve(coreDirectory);
  const violations = [];
  const add = (code, file, message, astNode) => {
    const position = astNode?.getSourceFile().getLineAndCharacterOfPosition(astNode.getStart());
    violations.push({ code, file: path.relative(requestedRoot, file) || ".", ...(position ? { line: position.line + 1, column: position.character + 1 } : {}), message });
  };
  let root;
  try {
    if ((await lstat(requestedRoot)).isSymbolicLink()) {
      return { ok: false, files: 0, edges: 0, violations: [{ code: "OUTSIDE_CORE", file: ".", message: "The core root must not be a symlink or junction" }] };
    }
    root = await realpath(requestedRoot);
  }
  catch (error) {
    return { ok: false, files: 0, edges: 0, violations: [{ code: "CORE_MISSING", file: ".", message: error.message }] };
  }
  const paths = [];
  const visitedDirectories = new Set();
  async function walk(directory) {
    const canonical = await realpath(directory);
    if (!inside(root, canonical)) { add("OUTSIDE_CORE", directory, "A directory resolves outside core"); return; }
    if (visitedDirectories.has(canonical)) return;
    visitedDirectories.add(canonical);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      let metadata = await lstat(filename);
      if (metadata.isSymbolicLink()) {
        const target = await realpath(filename);
        if (!inside(root, target)) { add("OUTSIDE_CORE", filename, "A symlink resolves outside core"); continue; }
        metadata = await stat(filename);
      }
      if (metadata.isDirectory()) await walk(filename);
      else if (metadata.isFile() && sourceFile(filename)) paths.push(await realpath(filename));
    }
  }
  await walk(root);
  const files = [...new Set(paths)].sort();
  if (files.length === 0) add("CORE_EMPTY", requestedRoot, "Core must contain source files");
  // The checker distinguishes local bindings named `process` from ambient access.
  // noResolve avoids loading any dependency while inspecting symbols.
  const program = ts.createProgram(files, { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext });
  const checker = program.getTypeChecker();
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set()]));
  async function resolveEdge(from, specifier, node) {
    if (!relativeImport(specifier)) { add("EXTERNAL_IMPORT", from, `Core cannot depend on ${JSON.stringify(specifier)}`, node); return; }
    const candidate = path.resolve(path.dirname(from), specifier);
    if (!inside(root, candidate)) { add("OUTSIDE_CORE", from, `Dependency leaves core: ${JSON.stringify(specifier)}`, node); return; }
    const extension = path.extname(candidate);
    const replacements = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[extension] || [];
    const candidates = [
      ...replacements.map((next) => candidate.slice(0, -extension.length) + next),
      candidate,
      ...SOURCE_EXTENSIONS.map((next) => candidate + next),
      ...SOURCE_EXTENSIONS.map((next) => path.join(candidate, "index" + next)),
    ];
    for (const resolved of candidates) {
      try {
        if (!(await stat(resolved)).isFile()) continue;
        const canonical = await realpath(resolved);
        if (!inside(root, canonical)) { add("OUTSIDE_CORE", from, `Dependency resolves outside core: ${JSON.stringify(specifier)}`, node); return; }
        if (!fileSet.has(canonical)) { add("UNSUPPORTED_DEPENDENCY", from, `Dependency is not a parsed core source: ${JSON.stringify(specifier)}`, node); return; }
        graph.get(from).add(canonical);
        return;
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    }
    add("UNRESOLVED_IMPORT", from, `Cannot resolve core dependency: ${JSON.stringify(specifier)}`, node);
  }
  for (const file of files) {
    const ast = program.getSourceFile(file) || ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const diagnostic of ast.parseDiagnostics || []) add("PARSE_ERROR", file, ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    const dependencies = [];
    const dependency = (argument, owner) => {
      const specifier = argument && literalText(argument);
      if (specifier === undefined) add("DYNAMIC_DEPENDENCY", file, "Module specifier must be a string literal", owner);
      else dependencies.push({ specifier, node: owner });
    };
    for (const reference of ast.referencedFiles) dependencies.push({ specifier: reference.fileName, node: ast });
    for (const reference of [...ast.typeReferenceDirectives, ...ast.libReferenceDirectives]) add("EXTERNAL_REFERENCE", file, `Core cannot load reference ${JSON.stringify(reference.fileName)}`);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) dependency(node.moduleSpecifier, node);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) dependency(node.moduleReference.expression, node);
      else if (ts.isImportTypeNode(node)) {
        if (ts.isLiteralTypeNode(node.argument)) dependency(node.argument.literal, node);
        else add("DYNAMIC_DEPENDENCY", file, "Import type must have a literal module", node);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(node.arguments[0], node);
      else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") dependency(node.arguments[0], node);
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) add("RUNTIME_GLOBAL", file, "Core cannot access import.meta runtime configuration", node);
      if (ts.isIdentifier(node) && RUNTIME_GLOBALS.has(node.text)) {
        const parent = node.parent;
        const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node);
        const symbol = checker.getSymbolAtLocation(node);
        const locallyDeclared = symbol?.declarations?.some((declaration) => {
          let current = declaration;
          while (current && !ts.isSourceFile(current)) {
            if (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) return false;
            current = current.parent;
          }
          return fileSet.has(path.resolve(declaration.getSourceFile().fileName));
        });
        if (!isPropertyName && !locallyDeclared) add("RUNTIME_GLOBAL", file, `Core cannot access ambient runtime ${node.text}`, node);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const { specifier, node } of dependencies) await resolveEdge(file, specifier, node);
  }
  const active = new Set();
  const complete = new Set();
  function visitGraph(file, stack) {
    if (active.has(file)) { add("DEPENDENCY_CYCLE", file, [...stack.slice(stack.indexOf(file)), file].map((item) => path.relative(root, item)).join(" -> ")); return; }
    if (complete.has(file)) return;
    active.add(file);
    for (const target of graph.get(file)) visitGraph(target, [...stack, file]);
    active.delete(file);
    complete.add(file);
  }
  for (const file of files) visitGraph(file, []);
  return { ok: violations.length === 0, files: files.length, edges: [...graph.values()].reduce((sum, edges) => sum + edges.size, 0), violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkCoreBoundaries(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
