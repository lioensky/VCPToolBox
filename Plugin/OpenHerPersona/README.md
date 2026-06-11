# OpenHerPersona

OpenHerPersona is a VCP-native bridge that absorbs a narrow slice of
[OpenHer](https://github.com/kellyvv/OpenHer)'s persona-state ideas without porting
OpenHer's runtime.

## Scope

- Keeps a lightweight local state per agent: drives, frustration, signals, temperament, signal bias, last activity, cooldown, and audit history.
- Provides direct commands: `status`, `tick`, `reset`, `explain`.
- Adds a short `persona_state_hint` through `processMessages` when enabled.
- Uses VCP-native plugin lifecycle and direct protocol.

## Algorithm (v0.3)

- **Homeostatic drives** — deprivation (silence, constraint, monotony) grows a drive's
  frustration scaled by remaining headroom; the interaction itself relieves it
  multiplicatively. Drives breathe around an equilibrium instead of saturating at the cap.
- **Per-agent temperament** — genome network weights and a persistent trait-offset vector
  are both seeded from the agent key, so different agents map the same situation to
  genuinely different behavior signals. Spread is tunable via
  `OpenHerPersonaTemperamentSpread`.
- **Metabolic constitution with slow plasticity** — each agent also gets seeded
  per-drive growth/relief multipliers (±18%): the same neglect makes one agent ache
  faster and another stay stoic. Distress-tier `persona_delta` events sensitize the
  affected drive slightly (major ≈ +1.2%), soothing events make future relief easier,
  and every real turn pulls the constitution elastically back toward its seeded origin,
  so change is real but slow.
- **Emotional phase transitions** — a pressure charge accumulates from sustained
  thermal heat, safety hits, constraint, and distress-tier deltas, and is discharged by
  affection. Crossing the threshold flips the agent through
  `strained → eruption → cooling → grounded`: an eruption lasts one turn (defiance and
  directness spike, warmth collapses, expression goes short and intense, and the hint
  says she is genuinely blowing up), then cooling keeps her subdued and defensive until
  two turns pass, 45 minutes elapse, or sincere affection ends it early. Eruptions
  respect `OpenHerPersonaEruptionCooldownMinutes` (default 90) and the whole machine
  can be disabled with `OpenHerPersonaPhaseEnabled=false`.
- **Mood inertia** — signals chase the computed target with an EMA whose responsiveness
  rises with thermal temperature, so emotions shift smoothly rather than snapping.
- **Persistent self-shaping** — the model's `signal_delta` backfill folds into a slow,
  bounded `signalBias` that survives later metabolism turns and decays gently.
- **Emotional agency via impact tiers** — the `persona_delta` backfill accepts an
  `impact` field (`minor` default / `moderate` / `major`) declaring how hard an
  emotional event hit. Tiers scale the per-turn bounds (drives ±0.8/±1.5/±3, signals
  ±0.18/±0.35/±0.6) and the `signalBias` folding rate; `major` additionally allows
  `frustration_set` absolute values, requires a `reason`, and respects a 30-minute
  cooldown (abuse downgrades to `moderate`). This lets a hurtful or euphoric moment
  move the state in one turn without any extra tool-call round trip.
- **Chat-burst expression** — when the expression engine is in a chatty or emotionally
  charged state (playful/warm signals, affectionate context, or any active phase) and
  the content is not technical/deep long-form, the hint asks the model to split its
  single reply into short IM-style messages separated by `brk` HTML-comment markers,
  splitting semantically (a few characters can stand alone as one bubble). VCPChat
  splits them into separate bubbles in real time during streaming. The hint is only
  issued when the request is provably from VCPChat (`vcpchatExtensions` payload or a
  OneRing client label like VCPChat/VChat) — unknown clients never receive markers.
  `OpenHerPersonaBurstMode` selects auto (emotion-gated) / always / off. One
  generation, zero extra model calls.
- **HTML expression hint** — under the same VCPChat-only gating, the hint also tells
  the model it may use light inline-styled HTML snippets (small cards, accent colors,
  simple layout) for expressive moments, optionally inside burst bubbles; script tags
  and external resources are forbidden, and technical answers stay plain. Toggle via
  `OpenHerPersonaHtmlHintEnabled`.
- **Mood readout** — a valence/arousal pair derived from signals and drive heat is
  injected into the hint as 心境底色 to ground tone selection.
- **Semantic context sensing** — when the host's embedding API is reachable
  (`API_URL`/`API_Key` + `WhitelistEmbeddingModel`), each new user turn is embedded once
  and scored against per-feature anchor phrases by relative cosine salience, then blended
  with the keyword heuristic (`OpenHerPersonaSemanticWeight`, default 0.5). Anchor vectors
  are embedded once and cached in `state/semantic-anchor-cache.json`, keyed by
  `EmbeddingModelSig`. Any failure or timeout silently falls back to the pure heuristic.

## Boundaries

- No FastAPI server.
- No EverMemOS, Chroma, or new vector database.
- No OpenHer provider layer or independent model key routing.
- No OpenHer SkillEngine; VCP tools and SkillBridge remain canonical.
- No proactive sending; `tick` only returns an audit with `would_send: false`.
- No long-term memory writes; future crystallization must produce `DailyNote` or `VCPMemory` candidates only.

## Commands

```text
OpenHerPersona status
OpenHerPersona tick
OpenHerPersona reset
OpenHerPersona explain
```
