---
name: orx-skill-creator
description: "Author and iteratively improve reusable skills: interview for intent, draft the SKILL.md, register it with `orx skills add`, then refine from real usage. Use whenever the user wants to create a skill from scratch, turn a repeated workflow into a skill, or improve an existing skill's wording, structure, or triggering."
---

<!-- Adapted from Anthropic's skill-creator (Apache-2.0): https://github.com/anthropics/skills/tree/main/skills/skill-creator -->

# Skill creator

Turn a repeated way of working into a skill the user can reuse. The loop:

1. Understand what the skill should do and when it fires.
2. Draft the SKILL.md and register it.
3. Try it together on realistic prompts.
4. Read the results with the user and revise. Repeat until it holds up.

Meet the user wherever they are: "make me a skill for X" starts at step 1; an
existing draft jumps to step 3; "just write it, no ceremony" is a valid answer.

## Capture intent

If the conversation already shows the workflow — the user did something
manually a few times and now wants it captured — mine the history first: the
tools used, the order of steps, the corrections they made, the input and
output formats. Confirm the gaps with the user instead of re-interviewing
from zero.

Otherwise ask, briefly:

- What should this skill let the model do?
- When should it fire — which user phrasings or contexts?
- What output does the user expect?
- Are there example inputs and outputs that pin the behavior down?

## Draft the SKILL.md

A skill is a folder whose heart is `SKILL.md`; supporting files are optional.

```text
my-skill/
├── SKILL.md          (required: YAML frontmatter + markdown body)
└── (optional)
    ├── references/   (docs the model reads on demand)
    ├── scripts/      (helper code the model can run)
    └── assets/       (templates, fixtures, fonts)
```

- `name`: lowercase letters, digits, and single hyphens. The `orx-` prefix
  and built-in names are reserved; registration rejects them.
- `description`: the trigger surface. It carries both what the skill does
  and when to use it — "when to use" belongs here, not in the body. Models
  under-trigger, so write it a little pushy: instead of "How to build a
  fast dashboard", write "How to build a fast dashboard. Use whenever the
  user mentions dashboards, visualization, or wants to display any data,
  even without saying the word 'dashboard'."
- Body: use the imperative form ("Read the file before editing"). Explain
  why a rule exists instead of shouting MUST — models follow reasoned
  guidance better than loud enforcement. Examples beat rules: when the
  output has a shape, include a literal example of it.

Progressive disclosure: metadata (name + description) sits in every
context; the body loads when the skill triggers (keep it under ~500 lines);
bundled files load on demand. Push domain detail into `references/` and
point to it from the body ("if the target is AWS, read references/aws.md
first"). A multi-file skill registers as a zip of the folder.

## Register

Write the file(s) into the working directory, then:

```
orx skills add ./SKILL.md        # single file
orx skills add ./my-skill.zip    # folder with supporting files
```

Read the JSON result and report the saved `name` and whether `replaced` is
true. Registered skills are on-demand by default: typing `/name` in any
chat invokes it immediately, but sessions only auto-carry it after the user
binds it to a project or attaches it to a custom expert (Skills page →
生效范围, or `userSkills` on an agent). Tell the user this in plain words.
Session copies refresh on later turns; never promise a hot reload in the
running harness.

## Try it together

Propose 2–3 realistic test prompts — the kind of thing the user would
actually type, with concrete paths, column names, and casual phrasing. Let
them edit the list. Then have them run one — send `/name <prompt>` in the
chat, or bind the skill and let it fire naturally — and read the output
together.

Signals a revision is needed: the skill did not fire; the output misses
what the user wanted; or the run did busywork — re-reading the same files,
writing throwaway scripts, going in circles. Busywork means the skill
over-prescribes, so cut guidance rather than add more.

## Improve and re-register

- Generalize from feedback. You and the user iterate on a few examples for
  speed; the skill must still work on inputs neither of you has seen.
  Resist overfit rules and stacked MUSTs — reframe the guidance instead.
- Keep it lean. Delete instructions that are not pulling their weight and
  watch whether the runs get better, not worse.
- Look for repeated work. If every test run reinvents the same helper
  script or multi-step dance, move it into `scripts/` and point the body at
  it once.
- Revising keeps the name. Edit the description and body, re-run
  `orx skills add` with the same name; registration fully replaces the
  package, including supporting files.
