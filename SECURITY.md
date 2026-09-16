# Security

## What a dictionary service is, and is not

The service described by this specification **never executes a tool and never
holds a credential**. It answers *which tool, where it lives, and where a
credential goes*. A dictionary carries `{{VARIABLE}}` references, never values;
the caller's own executor resolves them. Section 16 of the spec sets out the
model in full.

That boundary is the design's main security property. If you find a way for a
conforming document or a conforming server to carry, log, or emit a credential
value, that is a vulnerability in the specification and we want to hear about it.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Include the affected file or endpoint, a dictionary or
request that reproduces it (fictional data only), and what you believe the impact
is.

You will get an acknowledgement within a week. Fixes for the reference
implementation ship as a patch release; fixes that need a spec change are noted
in `CHANGELOG.md`.

## Scope

In scope: the specification text, the JSON Schema, the reference service, the
generator and the overlay merge, the Docker image.

Out of scope: the APIs a dictionary happens to describe. A dictionary is a map
of someone else's surface; the security of that surface is theirs.
