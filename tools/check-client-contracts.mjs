import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE = /\.[cm]?[jt]sx?$/;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const relativeSpecifier = (value) => value.startsWith("./") || value.startsWith("../");
const forbiddenPackage = (value) => /^(?:drizzle-orm|drizzle-zod)(?:\/|$)/.test(value);

/**
 * Inspect every client source and its resolved source/declaration dependencies,
 * including package entry points, reexports and type-only edges.
 * This reads TypeScript/JSON only; target code and configuration scripts never run.
 * Package implementations are not executed. Their declared runtime/peer/optional
 * dependency closure is checked as well, so a package wrapper cannot conceal a
 * declared Drizzle dependency. Direct type-only Drizzle edges are also rejected.
 */
export async function checkClientContracts(projectDirectory = process.cwd()) {
  const root = await realpath(path.resolve(projectDirectory));
  const client = path.join(root, "client", "src");
  const schema = path.join(root, "shared", "schema.ts");
  const violations = [];
  const edges = [];
  const files = new Set();
  const queue = [];
  const roots = [];
  const inspectedPackages = new Set();
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, "/");
  function add(code, file, node) {
    const position = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    violations.push({ code, file: relative(file), ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) });
  }
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { add("LINKED_CLIENT_SOURCE", file); continue; }
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && SOURCE.test(file)) roots.push(file);
    }
  }
  try {
    if ((await lstat(client)).isSymbolicLink()) add("LINKED_CLIENT_SOURCE", client);
    else await walk(client);
  } catch (error) {
    if (error.code === "ENOENT") add("CLIENT_SOURCE_MISSING", client);
    else throw error;
  }
  if (roots.length === 0) add("CLIENT_SOURCE_EMPTY", client);

  let compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, baseUrl: root, paths: { "@/*": ["client/src/*"], "@shared/*": ["shared/*"] } };
  const foundConfig = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  const config = foundConfig && path.resolve(foundConfig);
  if (config && inside(root, config)) {
    const loaded = ts.readConfigFile(config, ts.sys.readFile);
    if (loaded.error) add("CONFIG_PARSE_ERROR", config);
    else {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(config));
      if (parsed.errors.length) add("CONFIG_PARSE_ERROR", config);
      compilerOptions = { ...compilerOptions, ...parsed.options, allowJs: true };
    }
  }
  const resolutionCache = ts.createModuleResolutionCache(root, (value) => ts.sys.useCaseSensitiveFileNames ? value : value.toLowerCase(), compilerOptions);
  const packageCache = new Map();
  async function findPackage(file) {
    let directory = path.dirname(path.resolve(file));
    while (inside(root, directory) && directory !== root) {
      const manifest = path.join(directory, "package.json");
      try {
        const source = await readFile(manifest, "utf8");
        return { manifest, directory, metadata: JSON.parse(source) };
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
      directory = path.dirname(directory);
    }
  }
  async function packageDependsOnDrizzle(file, active = new Set()) {
    const pkg = await findPackage(file);
    if (!pkg) return false;
    inspectedPackages.add(pkg.manifest);
    if (active.has(pkg.manifest)) return false;
    if (packageCache.has(pkg.manifest)) return packageCache.get(pkg.manifest);
    const next = new Set(active).add(pkg.manifest);
    const names = Object.keys({ ...pkg.metadata.dependencies, ...pkg.metadata.optionalDependencies, ...pkg.metadata.peerDependencies });
    for (const name of names) {
      if (forbiddenPackage(name)) { packageCache.set(pkg.manifest, true); return true; }
      const options = { ...compilerOptions, paths: undefined, baseUrl: undefined };
      const dependency = ts.resolveModuleName(name, path.join(pkg.directory, "__client_contract_boundary__.ts"), options, ts.sys).resolvedModule;
      if (dependency && await packageDependsOnDrizzle(dependency.resolvedFileName, next)) { packageCache.set(pkg.manifest, true); return true; }
    }
    packageCache.set(pkg.manifest, false);
    return false;
  }
  async function dependency(file, specifier, node, kind) {
    if (forbiddenPackage(specifier)) { add("DRIZZLE_DEPENDENCY", file, node); return; }
    if (specifier === "@shared/schema" || specifier === "@shared/schema.ts") { add("SCHEMA_DEPENDENCY", file, node); return; }
    const resolved = kind === "type-reference"
      ? ts.resolveTypeReferenceDirective(specifier, file, compilerOptions, ts.sys).resolvedTypeReferenceDirective
      : ts.resolveModuleName(specifier, file, compilerOptions, ts.sys, resolutionCache).resolvedModule;
    if (!resolved) {
      // CSS and other assets are leaves; unknown code edges must not hide imports.
      if (relativeSpecifier(specifier) && !SOURCE.test(specifier) && path.extname(specifier)) {
        try { if ((await stat(path.resolve(path.dirname(file), specifier))).isFile()) return; } catch {}
      }
      const alias = Object.keys(compilerOptions.paths || {}).some((key) => specifier.startsWith(key.replace(/\*.*$/, "")));
      if (relativeSpecifier(specifier) || alias) add("UNRESOLVED_LOCAL_DEPENDENCY", file, node);
      return;
    }
    // Inspect package metadata and then parse the resolved source/declaration.
    // External type barrels must not hide undeclared Drizzle reexports.
    const alias = Object.keys(compilerOptions.paths || {}).some((key) => specifier.startsWith(key.replace(/\*.*$/, "")));
    if (resolved.isExternalLibraryImport && !relativeSpecifier(specifier) && !alias) {
      try {
        if (await packageDependsOnDrizzle(resolved.resolvedFileName)) add("TRANSITIVE_DRIZZLE_PACKAGE", file, node);
      } catch { add("PACKAGE_PARSE_ERROR", file, node); }
    }
    const target = await realpath(resolved.resolvedFileName);
    if (target === schema || relative(target).toLowerCase() === "shared/schema.ts") { add("SCHEMA_DEPENDENCY", file, node); return; }
    if (!inside(root, target)) { add("OUTSIDE_PROJECT_DEPENDENCY", file, node); return; }
    if (target.split(path.sep).some((part) => part === "drizzle-orm" || part === "drizzle-zod")) { add("DRIZZLE_DEPENDENCY", file, node); return; }
    if (!SOURCE.test(target)) return;
    edges.push({ from: relative(file), to: relative(target), kind });
    queue.push(target);
  }

  queue.push(...roots);
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    const source = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) add("SOURCE_PARSE_ERROR", file);
    const dependencies = [];
    const collect = (argument, owner, kind) => {
      if (argument && ts.isStringLiteralLike(argument)) dependencies.push({ specifier: argument.text, node: owner, kind });
      else add("DYNAMIC_DEPENDENCY", file, owner);
    };
    for (const reference of ast.referencedFiles) dependencies.push({ specifier: reference.fileName.startsWith(".") ? reference.fileName : "./" + reference.fileName, node: ast, kind: "reference" });
    for (const reference of ast.typeReferenceDirectives) dependencies.push({ specifier: reference.fileName, node: ast, kind: "type-reference" });
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) collect(node.moduleSpecifier, node, ts.isExportDeclaration(node) ? "export" : "import");
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) collect(node.moduleReference.expression, node, "require");
      else if (ts.isImportTypeNode(node)) {
        if (ts.isLiteralTypeNode(node.argument)) collect(node.argument.literal, node, "type-import");
        else add("DYNAMIC_DEPENDENCY", file, node);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) collect(node.arguments[0], node, "dynamic-import");
        else if ((ts.isIdentifier(callee) && callee.text === "require") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "require")) collect(node.arguments[0], node, "require");
        else if (ts.isPropertyAccessExpression(callee) && ["glob", "globEager"].includes(callee.name.text) && ts.isMetaProperty(callee.expression) && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword) add("DYNAMIC_DEPENDENCY", file, node);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const item of dependencies) await dependency(file, item.specifier, item.node, item.kind);
  }
  return { ok: violations.length === 0, roots: roots.length, files: files.size, edges: edges.length, packages: inspectedPackages.size, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkClientContracts(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || "CHECKER_FAILURE" }));
    process.exitCode = 1;
  }
}
