#!/usr/bin/env node
// Populate pnpm/dist/node_modules/ with the prod-dep closure of the `pnpm`
// workspace package, pinned to exact versions from the workspace lockfile.
//
// Why: publish-packed and `pnpm deploy --prod` both ignore the workspace
// lockfile and re-resolve to latest matching versions every run, causing
// bundled-dep drift in the published tarball. This script bypasses both —
// it reads pnpm-lock.yaml directly, walks the closure, and copies real
// files from node_modules/.pnpm/ (already populated by an earlier
// `pnpm install --frozen-lockfile --force` at the workspace root).
//
// Hoist algorithm:
//   - For each install-as name (alias-aware), highest version wins top level.
//   - Other versions go nested under each parent that depends on them
//     (transitively, including parents that are themselves nested).

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(__dirname, '..', '..')
const lockfilePath = path.join(workspaceRoot, 'pnpm-lock.yaml')
const dotPnpm = path.join(workspaceRoot, 'node_modules', '.pnpm')
const outDir = path.resolve(__dirname, '..', 'dist', 'node_modules')

console.error(`workspace: ${workspaceRoot}`)
console.error(`output:    ${outDir}`)

const lockfile = yaml.load(fs.readFileSync(lockfilePath, 'utf8'))
const importer = lockfile.importers.pnpm
const snapshots = lockfile.snapshots ?? {}

// --- id helpers ---------------------------------------------------------
// "id" = lockfile snapshot key, e.g. `glob@10.4.5` or
// `graceful-fs@4.2.11(patch_hash=abc...)` or `@scope/name@1.0(peer@2.0)`.
function nameFromId (id) {
  if (id.startsWith('@')) return id.slice(0, id.indexOf('@', 1))
  return id.slice(0, id.indexOf('@'))
}
function specFromId (id) {
  return id.slice(nameFromId(id).length + 1)
}
function versionFromId (id) {
  return specFromId(id).split('(')[0]
}
// `dep` value in snapshots can be `1.2.3`, `1.2.3(peer@4)`, or
// `realName@1.2.3(peer@4)` (when the importing dep is an npm alias).
// Returns { installAs, id }.
function resolveDep (name, depValue) {
  if (depValue.includes('@') && !depValue.startsWith('(')) {
    // aliased: name = installAs, depValue = realName@version[suffix]
    return { installAs: name, id: depValue }
  }
  return { installAs: name, id: `${name}@${depValue}` }
}

function semverCompare (a, b) {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0)
  const pb = b.split('.').map(s => parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// --- closure ------------------------------------------------------------
// edges: parentId -> [{ installAs, id }]
const edges = new Map()
const closure = new Set()
const queue = []

function addRoots (deps) {
  if (!deps) return
  for (const [name, info] of Object.entries(deps)) {
    if (typeof info?.version !== 'string') continue
    const id = info.version.includes('@') && !info.version.startsWith('(')
      ? info.version
      : `${name}@${info.version}`
    queue.push({ installAs: name, id, parent: null })
  }
}
addRoots(importer.dependencies)
addRoots(importer.optionalDependencies)

while (queue.length > 0) {
  const { installAs, id, parent } = queue.shift()
  if (parent != null) {
    if (!edges.has(parent)) edges.set(parent, [])
    edges.get(parent).push({ installAs, id })
  }
  if (closure.has(id)) continue
  closure.add(id)
  const snap = snapshots[id]
  if (!snap) continue
  const merged = { ...(snap.dependencies ?? {}), ...(snap.optionalDependencies ?? {}) }
  for (const [childName, childVal] of Object.entries(merged)) {
    if (typeof childVal !== 'string') continue
    const { installAs: childInstallAs, id: childId } = resolveDep(childName, childVal)
    queue.push({ installAs: childInstallAs, id: childId, parent: id })
  }
}
console.error(`closure: ${closure.size} packages`)

// --- top-level winners (per install-as name) ----------------------------
// Collect, per alias-name, which ids appear under that alias.
const idsByInstallAs = new Map()
function collectInstallAs () {
  // Roots (importer entries)
  for (const deps of [importer.dependencies, importer.optionalDependencies]) {
    if (!deps) continue
    for (const [name, info] of Object.entries(deps)) {
      if (typeof info?.version !== 'string') continue
      const id = info.version.includes('@') && !info.version.startsWith('(')
        ? info.version
        : `${name}@${info.version}`
      if (!idsByInstallAs.has(name)) idsByInstallAs.set(name, new Set())
      idsByInstallAs.get(name).add(id)
    }
  }
  // Edges
  for (const list of edges.values()) {
    for (const { installAs, id } of list) {
      if (!idsByInstallAs.has(installAs)) idsByInstallAs.set(installAs, new Set())
      idsByInstallAs.get(installAs).add(id)
    }
  }
}
collectInstallAs()

const topId = new Map() // installAs -> id (highest version wins)
for (const [installAs, ids] of idsByInstallAs) {
  const sorted = [...ids].sort((a, b) => -semverCompare(versionFromId(a), versionFromId(b)))
  topId.set(installAs, sorted[0])
}

// --- source dir resolution ----------------------------------------------
const dotPnpmEntries = fs.existsSync(dotPnpm) ? fs.readdirSync(dotPnpm) : []
if (dotPnpmEntries.length === 0) {
  console.error(`error: ${dotPnpm} is empty or missing — run pnpm install first`)
  process.exit(1)
}

function sourceDirFor (id) {
  const realName = nameFromId(id)
  const spec = specFromId(id)
  const verBase = versionFromId(id)
  const dirRealName = realName.startsWith('@') ? realName.replace('/', '+') : realName

  // exact key match
  for (const k of [`${dirRealName}@${spec}`, `${dirRealName}@${verBase}`]) {
    const p = path.join(dotPnpm, k, 'node_modules', realName)
    if (fs.existsSync(p)) return p
  }
  // prefix match for peer-suffixed entries
  const prefix = `${dirRealName}@${verBase}`
  for (const entry of dotPnpmEntries) {
    if (entry === prefix || entry.startsWith(`${prefix}_`) || entry.startsWith(`${prefix}(`)) {
      const p = path.join(dotPnpm, entry, 'node_modules', realName)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// --- placement plan ------------------------------------------------------
// For each (installAs, id, location-of-parent), decide where to copy.
// location is a list of nesting parents (install-as names), root being [].
//
// Algorithm: BFS from roots.
//   - At each (installAs, id, currentLocation):
//     - destLocation = currentLocation if id != topId(installAs in scope)
//     - For top-level, scope is root. For nested, scope is currentLocation's nm.
//   - We approximate by: if the id matches topId(installAs) globally AND no
//     conflicting placement exists at root, install at root. Otherwise nest
//     under the immediate parent.
//
// In practice for pnpm's prod closure this gives:
//   - Highest version at top-level node_modules/<installAs>/
//   - Other versions at node_modules/<parentInstallAs>/.../node_modules/<installAs>/
//     where the chain ends at a top-level parent.

const placements = new Map() // pathKey -> { id, installAs }
function place (location, installAs, id) {
  const key = [...location, installAs].join('/')
  const existing = placements.get(key)
  if (existing && existing.id === id) return false
  if (existing && existing.id !== id) {
    console.warn(`conflict at ${key}: ${existing.id} vs ${id} (keeping first)`)
    return false
  }
  placements.set(key, { id, installAs })
  return true
}

function planFrom (location, parentId) {
  const list = edges.get(parentId) ?? []
  for (const { installAs, id } of list) {
    const useTopLevel = topId.get(installAs) === id && location.length === 0
    const placeAt = useTopLevel ? [] : location
    const isNew = place(placeAt, installAs, id)
    if (!isNew) continue
    // Recurse into children of this id, using updated location.
    planFrom([...placeAt, installAs], id)
  }
}
// Seed with root edges
const rootEdges = []
for (const deps of [importer.dependencies, importer.optionalDependencies]) {
  if (!deps) continue
  for (const [name, info] of Object.entries(deps)) {
    if (typeof info?.version !== 'string') continue
    const id = info.version.includes('@') && !info.version.startsWith('(')
      ? info.version
      : `${name}@${info.version}`
    rootEdges.push({ installAs: name, id })
  }
}
for (const { installAs, id } of rootEdges) {
  place([], installAs, id)
  planFrom([installAs], id)
}

console.error(`placements: ${placements.size}`)

// --- copy ----------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

let copied = 0
let missingSrc = 0
const missing = []
for (const [key, { id, installAs }] of placements) {
  const segments = key.split('/')
  // segments[last] should equal installAs; rebuild path with nested node_modules
  const dest = path.join(
    outDir,
    ...segments.slice(0, -1).flatMap(s => [s, 'node_modules']),
    installAs
  )
  const src = sourceDirFor(id)
  if (!src) {
    missing.push(id)
    missingSrc++
    continue
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: true, errorOnExist: false, force: true })
  copied++
}
console.error(`copied: ${copied}, missing source: ${missingSrc}`)
if (missing.length) {
  console.error('first missing:', missing.slice(0, 5).join(', '))
  process.exit(1)
}
