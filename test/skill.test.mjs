/**
 * Guards the vendored official TypeSafe skill.
 *
 * Run: node --test
 *
 * `skills/typesafe-ai/SKILL.md` is a copy of the skill TypeSafe publishes in
 * github.com/typesafe-ai/skills (MIT). It is vendored rather than installed so
 * it travels with the package and stays readable offline, which makes three
 * things worth pinning:
 *
 *   1. The file is there and still opens with a parseable YAML frontmatter —
 *      a skill loader rejects the file outright without it.
 *   2. The upstream attribution survives an update (repo, licence, commit).
 *   3. The README points readers at the real skill and its install command,
 *      and package.json keeps shipping `skills/` in the tarball.
 *
 * The frontmatter is parsed with a deliberately small YAML reader (flat
 * `key: value` scalars plus block scalars): this repo carries no YAML
 * dependency, and anything outside that subset — tabs, nested maps, a missing
 * colon — is exactly the breakage this test should catch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillPath = path.join(root, 'skills', 'typesafe-ai', 'SKILL.md')
const licensePath = path.join(root, 'skills', 'typesafe-ai', 'LICENSE.upstream')

const skill = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Parse this skill's frontmatter: top-level `key: value` and block scalars. */
function parseFrontmatter(text, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  assert.ok(match, `${label} must open with a YAML frontmatter block`)
  const out = {}
  let blockKey = null
  let blockLines = []
  const flush = () => {
    if (blockKey === null) return
    out[blockKey] = blockLines.join(' ').trim()
    blockKey = null
    blockLines = []
  }
  match[1].split(/\r?\n/).forEach((line, index) => {
    const where = `${label} frontmatter line ${index + 1}`
    assert.ok(!line.includes('\t'), `${where} must not indent with a tab`)
    if (line.trim() === '') return
    if (blockKey !== null) {
      assert.ok(/^\s+\S/.test(line), `${where} must stay indented inside "${blockKey}:"`)
      blockLines.push(line.trim())
      return
    }
    const entry = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    assert.ok(entry, `${where} must look like "key: value" (got "${line}")`)
    assert.ok(!(entry[1] in out), `${where} repeats the key "${entry[1]}"`)
    const value = entry[2].trim()
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      blockKey = entry[1] // a block scalar (or a value continued on indented lines)
      return
    }
    out[entry[1]] = value
  })
  flush()
  return out
}

test('the official TypeSafe skill is vendored in the repo', () => {
  assert.ok(existsSync(skillPath), 'skills/typesafe-ai/SKILL.md must exist')
  assert.ok(skill.length > 1000, 'the skill must carry its content, not a stub')
  // Upstream phrases worth keeping: the atomicity rule and the docs-first rule.
  assert.ok(skill.includes('Ask one narrow, coherent judgment per question'))
  assert.ok(skill.includes('The live TypeSafe docs are the source of truth'))
})

test('the skill frontmatter is valid YAML with a name and a description', () => {
  const frontmatter = parseFrontmatter(skill, 'skills/typesafe-ai/SKILL.md')
  assert.equal(frontmatter.name, 'typesafe-ai', 'the skill name is its install id')
  assert.equal(typeof frontmatter.description, 'string')
  assert.ok(
    frontmatter.description.length > 80,
    'the description is what an agent router reads to decide when to load the skill',
  )
  assert.equal(frontmatter.license, 'MIT')
})

test('the vendored skill carries its upstream attribution', () => {
  // Repo, licence and the exact commit the copy came from.
  assert.ok(skill.includes('github.com/typesafe-ai/skills'), 'the upstream repo must be named')
  assert.ok(skill.includes('https://github.com/typesafe-ai/skills'), 'the upstream link must be kept')
  assert.ok(skill.includes('Licensed under the MIT License'), 'the upstream licence must be stated')
  assert.ok(
    skill.includes('65a39f393687675ce170e6094757de20370365b9'),
    'the vendored commit must be recorded for the next sync',
  )
  assert.ok(skill.includes('LICENSE.upstream'), 'the attribution must point at the shipped licence')

  assert.ok(existsSync(licensePath), 'the upstream LICENSE must ship next to the skill')
  const license = readFileSync(licensePath, 'utf8')
  assert.match(license, /^MIT License/)
  assert.ok(license.includes('Copyright (c) 2026 TypeSafe AI'))
})

test('the README points at the official skill and its install command', () => {
  assert.ok(readme.includes('## Official TypeSafe skill'), 'the README section must exist')
  assert.ok(
    readme.includes('npx skills add typesafe-ai/skills --skill typesafe-ai'),
    'the documented install command must match the upstream one',
  )
  assert.ok(readme.includes('https://github.com/typesafe-ai/skills'))
  assert.ok(readme.includes('skills/typesafe-ai/SKILL.md'), 'the vendored copy must be linked')
})

test('the tarball ships skills/ and still excludes tests and docs', () => {
  assert.ok(pkg.files.includes('skills'), 'package.json files must carry skills/')
  for (const entry of pkg.files) {
    assert.ok(
      !/^(test|docs)(\/|$)/.test(entry),
      `"${entry}" must not ship in the npm tarball`,
    )
  }
})
