"""Experimental readout only. Call once per candidate with frozen observations.
Routes are (explicit_source, observed_target, conductance / original_row_mass).
bindings[target] = {candidate_tag_id: (endpoint_tag_cos, tag_body_cos)}.
body[target] is endpoint-to-chunk cosine. Inputs use the original vector space.
"""
from math import isfinite, sqrt


def clip(x):
    if not isfinite(x):
        raise ValueError("nonfinite readout input")
    return min(1., max(0., x))


def corroborated(routes, explicit, bindings, body, semantic_threshold):
    """A route needs endpoint/body closure. Other explicit foci must each
    have an observed first-hop endpoint exactly present on the candidate.
    A candidate tag or route endpoint may not witness two different foci.
    No second focus -> no invented corroboration; retain the row share.
    Caller supplies only positive, observed, non-return hop-0 -> hop-1 edges.
    """
    explicit = set(explicit)
    routes = tuple(routes)
    best, witness = 0., None
    exact = {s: [] for s in explicit}
    for s, t, share in routes:
        if s not in explicit or s == t or not 0 < share <= 1:
            raise ValueError("invalid observed explicit route")
        if t in bindings.get(t, {}):
            _, tc = bindings[t][t]
            strength = share * clip(tc)
            if strength:
                exact[s].append((t, strength))

    def confirm(rest, used, strength, trail):
        if not rest:
            return strength, trail
        s, *tail = rest
        answer = (0., ())
        for t, weight in exact[s]:
            if t in used:
                continue
            result = confirm(tail, used | {t}, min(strength, weight),
                             trail + ((s, t),))
            if result[0] > answer[0]:
                answer = result
        return answer

    for s, t, share in routes:
        b = clip(body[t])
        for tag, (sim, tc) in sorted(bindings.get(t, {}).items()):
            if tag != t and sim <= semantic_threshold:
                continue
            own = share * b * sqrt(clip(sim) * clip(tc))
            if own <= best:
                continue
            strength, trail = confirm(sorted(explicit - {s}), {tag, t}, own, ())
            if strength > best:
                best, witness = strength, (s, t, tag, trail)
    return best, witness


def arms(*, raw, diff, mix, genus, field, field_lambda, support, path,
         graph, cap, omega_gate, evidence, baseline):
    """Compare the same frozen candidate. Preserve existing graph evidence.
    Gate floor and additive envelope are alternative uses of the same signal.
    `unitGateDiagnostic` is an upper-bound control, NOT a proposed scorer.
    """
    def pure(g):
        q = ((1 - mix) * clip(raw) + mix * g * clip(diff)) if mix > 0 else clip(raw)
        gain = min(.03, field_lambda * max(0., field - q)) * clip(support)
        return q + min(1 - q, gain)

    prev = clip(pure(genus) + path + graph)
    if abs(prev - baseline) > 1e-7:
        raise ValueError(f"baseline mismatch {prev} vs {baseline}")
    e = clip(evidence)
    g = clip(pure(max(genus, e) if mix > 0 else genus) + path + graph)
    # Replace transport by a competing envelope; never count old proxy twice.
    alt_graph = min(max(0., cap - path), cap * clip(omega_gate) * e)
    r = clip(pure(genus) + path + max(graph, alt_graph))
    return dict(current=prev, gateFloor=g, hopReadout=r,
                combined=max(g, r), unitGateDiagnostic=clip(pure(1.) + path + graph))