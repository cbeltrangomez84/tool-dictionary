# Guides

Four short guides, in the order most people need them. Each one is runnable
against this repository as checked in.

| | |
|---|---|
| [Write your first dictionary](write-your-first-dictionary.md) | Three tools by hand, validated, searched. Ten minutes. |
| [Generate one from OpenAPI](generate-from-openapi.md) | Point the generator at a document, add an overlay, keep it fresh in CI. |
| [Connect an agent](connect-an-agent.md) | Two HTTP calls to wire a dictionary into any model that can call tools — three when the service executes for you. |
| [Run the service](run-the-service.md) | Config file, tokens, refresh, execution, Docker, what `/health` tells you. |

The normative text is [`spec/tool-dictionary-v0.2.md`](../spec/tool-dictionary-v0.2.md).
When a guide and the spec disagree, the spec is right and the guide has a bug —
please open an issue.
