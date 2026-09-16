# Contributing

Tool Dictionary is a specification first and a reference implementation second.
That ordering decides how changes land here.

## Where things live

```
spec/tool-dictionary-v0.1.md     the normative text — what a document and a server MUST do
spec/schema/                     JSON Schema for the document; the machine-checkable half of the spec
spec/examples/                   a hand-written dictionary, and a generated one with its inputs
conformance/                     byte-exact vectors for the text rendering
src/                             the reference service, generator and overlay merge (TypeScript)
docs/                            guides: first dictionary, generating, connecting an agent, running the service
test/                            vitest; the example and the conformance vectors are tested as fixtures
```

## The rule that governs every change

**The spec, the schema and the implementation must agree at every commit.**
A change to one of them that leaves the other two behind is not mergeable, even
if it is correct. Concretely:

* Changing what a field means → edit the spec text, the schema, the types in
  `src/types.ts`, and the validator, in one PR.
* Changing the text rendering → `npm run conformance`, read the diff in
  `conformance/text/`, commit it. CI fails otherwise.
* Changing the generator or the overlay merge → `npm run example`, read the diff
  in `spec/examples/pool-scout/`, commit it. CI fails otherwise.
* Adding an operational number (a limit, a threshold, a cap) → it goes in the
  spec with a reason, not only in the code.

## Proposing a spec change

Open an issue with the *Spec change* template before writing the PR. Say which
real situation the current text handles badly. A proposal that starts from a
concrete dictionary and a concrete query is easy to evaluate; one that starts
from taste is not. Section 18 of the spec lists what is deliberately left out
and why — read it first, the omission may be on purpose.

Version 0.1 is a draft. Breaking changes are acceptable while it is, but each one
must be called out in `CHANGELOG.md` under *Breaking*.

## Working on the code

```bash
npm install
npm run check        # typecheck + tests + schema validation + build — what CI runs
npm run dev -- config/local.json
```

House style, so a reader can tell what is deliberate:

* TypeScript strict, no `any` without a comment saying why.
* Comments explain *why*, never *what*. A comment that restates the next line
  gets removed in review.
* Tests describe behaviour a consumer can observe (`it('a miss returns the
  index, never an empty list')`), not implementation steps.
* Nothing real in fixtures or examples: no real API, hostname, key, or internal
  tool name. Fictional vendors with `.example` domains only.

## Commit messages

One line, imperative, saying what changed for a reader of the repository:
`spec: say where the credential goes, never what it is`. Prefix with the area
(`spec:`, `generate:`, `service:`, `docs:`, `examples:`) when it helps.

## Licence

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the same as the rest of the project.
