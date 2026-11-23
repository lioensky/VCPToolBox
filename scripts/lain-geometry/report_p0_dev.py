import argparse
import hashlib
import itertools
import json
from pathlib import Path
from statistics import mean, median


def report(folder, stdout):
    completion = json.loads(stdout.read_text(encoding="utf-8-sig"))
    if not (completion.get("complete") is True and completion.get("queries") == 253
            and completion.get("records") == 9108 and Path(completion["output"]).resolve() == folder.resolve()):
        raise ValueError("missing full-run completion marker")
    records = {}
    path = folder / "per-query.jsonl"
    for line in path.read_bytes().splitlines():
        r = json.loads(line)
        key = (r["slot"], r["denominator"], r["plate"], r["summary"])
        if key in records:
            raise ValueError("duplicate record")
        records[key] = r
    keys = itertools.product(range(253), (8, 16, 4), range(6), ("aabb", "bins"))
    if set(records) != set(keys):
        raise ValueError("incomplete or unexpected comparison matrix")
    groups = []
    for w in (8, 16, 4):
        for slot in range(253):
            matched = [records[slot,w,i,k] for i in range(6) for k in ("aabb","bins")]
            if len({r["kthScore"] for r in matched}) != 1:
                raise ValueError("threshold mismatch")
            for i in range(6):
                a,b = matched[2*i:2*i+2]
                if a["chimera"] != b["chimera"] or a["idealESkippedBytes"] != b["idealESkippedBytes"]:
                    raise ValueError("summary-dependent exact diagnostic")
                for r,cost in ((a,8),(b,1)):
                    skip,ideal = r["skippedBytes"],r["idealESkippedBytes"]
                    if not (0 <= skip <= ideal <= 6849*12288
                            and all(v % 12288 == 0 and (v//12288)%16 in (0,1) for v in (skip,ideal))
                            and r["summaryBytes"] == 429*3072*cost and r["netBytes"] == skip-r["summaryBytes"]):
                        raise ValueError("invalid payload ledger")
        for k in ("aabb","bins"):
            real = [records[s,w,0,k] for s in range(253)]
            def paired(field, index=None):
                def value(r):
                    return r[field] if index is None else r[field][index]
                return mean(value(real[s])-mean(value(records[s,w,i,k]) for i in range(1,6)) for s in range(253))
            groups.append(dict(denominator=w,summary=k,queries=len(real),
                netPositive=sum(r["netBytes"]>0 for r in real),
                fullTileSkipped=sum(r["skippedBytes"]>=16*12288 for r in real),
                fullTileSkippableIdealE=sum(r["idealESkippedBytes"]>=16*12288 for r in real),
                meanNetBytes=mean(r["netBytes"] for r in real),
                medianNetBytes=median(r["netBytes"] for r in real),
                meanEnv=mean(r["env"][0] for r in real),
                meanChimera=mean(r["chimera"][0] for r in real),
                trueMinusShuffleMeanChimera=paired("chimera",0),
                trueMinusShuffleMeanEnv=paired("env",0),
                trueMinusShuffleMeanNetBytes=paired("netBytes"),
                occupiedBinFraction=real[0]["occupiedBinFraction"],
                meanLitDimensionFraction=mean(r["litDimensionFraction"] for r in real)))
    return dict(devQueries=253,records=len(records),evalUsed=False,
                recordsSha256=hashlib.sha256(path.read_bytes()).hexdigest(),groups=groups)


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("folder",type=Path); p.add_argument("stdout",type=Path)
    print(json.dumps(report(**vars(p.parse_args())),indent=2))