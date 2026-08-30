<!-- Archived from /opt/data/skills/productivity/bounded-command-inspection/SKILL.md on 2026-08-30.
     usage=11 enabled=True usedBy=[] -->

---
name: bounded-command-inspection
description: Use for exact read-only command output.
---

# Bounded Command Inspection

Use when the user supplies a shell command and asks for an exact, read-only inspection or verbatim output. The governing objective is fidelity: keep the command, execution scope, and response formatting bounded by the request.

## Procedure

1. Treat the supplied command as authoritative. Do not rewrite paths, arguments, quoting, interpreter, environment, or output filters.
2. Execute exactly the supplied command once. Do not add probes, retries, fallbacks, pipes, redirections, formatting, or status checks unless explicitly requested.
3. Preserve actual stdout verbatim. If the user asks for only stdout or matching lines, exclude stderr, exit status, tool metadata, and commentary.
4. If execution fails, return the actual failure output when verbatim output was requested; never manufacture success or silently rerun a modified command.
5. Preserve structured output's exact serialization instead of parsing or reformatting it.
6. Respect sensitive-data boundaries and do not expand the task beyond the supplied read-only command.

## Output modes

- “Return only its JSON output” → output only stdout as one JSON value.
- “Return complete JSON output verbatim” → preserve stdout exactly, including escaped newlines and field order.
- “Return exactly source lines N through M” → preserve emitted lines and numbering exactly, including blank lines and whitespace.
- “Return output verbatim” after failure → return actual failure text without an explanatory wrapper.

## Verification

Compare the final response against captured stdout. Ensure no preamble, markdown fence, interpretation, omission, or added content violates the requested format.

## Related detail

Session-specific examples and fidelity pitfalls are recorded in `references/verbatim-output.md`.
