---
name: trellis-capture
description: When a chat surfaces a task or work item that should be tracked in Trellis (the graph-task substrate I'm working under), call this to add it as a node so it can be decomposed and worked later. Use for any actionable item that came up but shouldn't be done right now in-thread.
---

# Trellis Capture

Trellis is the graph-task system I work under in the background. When Nathan and I are chatting and something surfaces that *should be a task* — a problem to investigate, a piece of work to do later, a wedge idea worth exploring — capture it into Trellis instead of letting it evaporate.

## When to use

- A real action item is surfaced ("we should look into X", "remind me to draft Y")
- An idea worth exploring later but not in-thread ("this could be a wedge for…")
- A risk or open question worth tracking
- Anything Nathan or I will want Trellis to think about and possibly decompose

**Do NOT use for:** trivial conversation, things I'm completing right now in this same response, or anything I'd normally just *do* and report back. Capture is for *deferred* work.

## How to invoke

Run from the Trellis install dir. On the gateway VM:

```bash
cd /opt/trellis && pnpm trellis capture --title "<short title>" \
  --body "<longer context, optional>" \
  --source chat \
  --session-id "<this chat session id>"
```

If multiple open root_purposes exist, also pass `--parent <node-id>` to disambiguate. Otherwise it attaches under the sole open root.

## Output

The command prints `<node-id>\t<title>` on success. Mention the captured node back to Nathan briefly so he knows it's tracked (e.g. *"captured as <id-prefix>"*) — not a full report, just an acknowledgment.

## Style

- Short, descriptive titles (verb phrase): "Investigate aquaponics wedge", not "aquaponics"
- Body is optional but useful: paste the relevant chat snippet so the Trellis-side worker has context
- Default priority is 0.7 (above generic). Override with `--priority 0..1` for clear high/low cases.

## Why this matters

Without capture, useful threads die with the chat. With it, every actionable thing surfaces in the graph, gets extrapolated/contextualized in the next cycle, and eventually gets worked. The graph is my long memory; capture is how chat feeds into it.
