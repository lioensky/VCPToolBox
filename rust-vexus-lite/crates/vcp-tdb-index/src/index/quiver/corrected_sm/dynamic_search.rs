//! 与768维共用语义的通用搜索流程；独立评分避免每候选做维度分派。
use super::*;
impl CorrectedSmIndex {
    pub(super) fn dynamic_encoded<const TRACE: bool, const OPTIMIZED: bool, S: ExactSource>(
        &self,
        q: &[f32],
        graph: &FlatAdj,
        source: &mut S,
        cfg: &QuIVerSearchConfig,
        sq: &DynamicQuery,
    ) -> io::Result<SmSearchOutput> {
        self.dynamic_encoded_filtered::<TRACE, OPTIMIZED, S, fn(u64) -> bool>(
            q, graph, source, cfg, sq, None,
        )
    }

    pub(super) fn dynamic_encoded_filtered<
        const TRACE: bool,
        const OPTIMIZED: bool,
        S: ExactSource,
        F: Fn(u64) -> bool,
    >(
        &self,
        q: &[f32],
        graph: &FlatAdj,
        source: &mut S,
        cfg: &QuIVerSearchConfig,
        sq: &DynamicQuery,
        exclude_pred: Option<&F>,
    ) -> io::Result<SmSearchOutput> {
        let budget = cfg.rerank_limit.unwrap_or(64);
        let ef = cfg.ef_search.min(self.len());
        if q.len() != self.dimension()
            || !q.iter().all(|x| x.is_finite())
            || cfg.top_k == 0
            || cfg.top_k > budget
            || budget > ef
        {
            return Err(invalid("SM查询维度、候选或精排预算无效"));
        }
        let optimized = OPTIMIZED;
        let uses_anchor = self.scoring == SmScoring::CorrectedInnerProduct;
        let anchor = if uses_anchor {
            source
                .one(q, self.anchor as usize)?
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "搜索锚点冷向量不可读取"))?
        } else {
            0.
        };
        let error = if uses_anchor {
            anchor
                - self
                    .dynamic
                    .as_ref()
                    .unwrap()
                    .score(sq, self.anchor as usize, optimized)
        } else {
            0.
        };
        let high = sq.weak + sq.delta;
        let query_norm =
            (self.dimension() as f32 - sq.count) * sq.weak * sq.weak + sq.count * high * high;
        let first = 1.
            - self.dynamic_navigation_score(sq, self.entry as usize, error, query_norm, optimized);
        if !first.is_finite() || !anchor.is_finite() {
            return Err(invalid("SM查询分数溢出"));
        }
        SCRATCH.with(|cell| {
            let mut scratch = cell.borrow_mut();
            let Scratch { visited, storage } = &mut *scratch;
            if visited.len < self.len() {
                visited.grow(self.len());
            }
            visited.clear();
            let mut fresh;
            let st = if optimized {
                storage.reset(ef);
                storage
            } else {
                fresh = Storage::new(ef);
                &mut fresh
            };
            let mut trace = SmTrace::default();
            let mut counts = [0usize, 1 + usize::from(uses_anchor), 0, 0, 0];
            visited.set(self.entry as usize);
            st.queue.push(Reverse((NonNanF32(first), self.entry)));
            let entry_excluded = exclude_pred
                .map(|pred| pred(self.ids[self.entry as usize]))
                .unwrap_or(false);
            if !entry_excluded {
                st.results.push((NonNanF32(first), self.entry));
            }
            while let Some(&Reverse((distance, u))) = st.queue.peek() {
                if st.results.len() >= ef && distance > st.results.peek().unwrap().0 {
                    break;
                }
                st.queue.pop();
                counts[0] += 1;
                if TRACE {
                    trace.expanded.push(u);
                }
                let neighbors = graph.neighbors(u);
                counts[3] += neighbors.len();
                for neighbors in neighbors.chunks(MAX_DEGREE) {
                    let mut ids = [0u32; MAX_DEGREE];
                    let mut values = [0f32; MAX_DEGREE];
                    let mut len = 0;
                    if optimized {
                        for &v in neighbors {
                            if visited.test(v as usize) {
                                continue;
                            }
                            visited.set(v as usize);
                            ids[len] = v;
                            len += 1;
                            self.dynamic_prefetch(v as usize);
                            if TRACE {
                                trace.scored.push(v);
                            }
                        }
                        // 保留已验证组合的四候选评分顺序，整批预取后再访问模型。
                        let mut j = 0;
                        while j + 4 <= len {
                            values[j] = self.dynamic_navigation_score(
                                sq,
                                ids[j] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            values[j + 1] = self.dynamic_navigation_score(
                                sq,
                                ids[j + 1] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            values[j + 2] = self.dynamic_navigation_score(
                                sq,
                                ids[j + 2] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            values[j + 3] = self.dynamic_navigation_score(
                                sq,
                                ids[j + 3] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            j += 4;
                        }
                        while j < len {
                            values[j] = self.dynamic_navigation_score(
                                sq,
                                ids[j] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            j += 1;
                        }
                        counts[1] += len;
                        // 检查整批分数，所有候选仍执行有限值校验。
                        let invalid_score = values[..len]
                            .iter()
                            .fold(false, |invalid, value| invalid | !value.is_finite());
                        if invalid_score {
                            return Err(invalid("SM候选分数溢出"));
                        }
                    } else {
                        for &v in neighbors {
                            if !visited.test(v as usize) {
                                self.dynamic_prefetch(v as usize);
                            }
                        }
                    }
                    let iteration = if optimized { &ids[..len] } else { neighbors };
                    for (j, &v) in iteration.iter().enumerate() {
                        let value = if optimized {
                            values[j]
                        } else {
                            if visited.test(v as usize) {
                                continue;
                            }
                            visited.set(v as usize);
                            counts[1] += 1;
                            if TRACE {
                                trace.scored.push(v);
                            }
                            self.dynamic_navigation_score(sq, v as usize, error, query_norm, false)
                        };
                        if !optimized && !value.is_finite() {
                            return Err(invalid("SM候选分数溢出"));
                        }
                        let next = NonNanF32(1. - value);
                        if st.results.len() < ef || next < st.results.peek().unwrap().0 {
                            st.queue.push(Reverse((next, v)));
                            let is_excluded = exclude_pred
                                .map(|pred| pred(self.ids[v as usize]))
                                .unwrap_or(false);
                            if !is_excluded {
                                if optimized && st.results.len() == ef {
                                    *st.results.peek_mut().unwrap() = (next, v);
                                } else {
                                    st.results.push((next, v));
                                    if st.results.len() > ef {
                                        st.results.pop();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            st.candidates.extend(st.results.drain());
            st.candidates.sort_unstable();
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::QuiverCandidateProduced);
            if TRACE {
                trace.candidates.extend(st.candidates.iter().map(|x| x.1));
            }
            if uses_anchor && !exclude_pred.map(|p| p(self.ids[self.anchor as usize])).unwrap_or(false) {
                st.exact.push((self.anchor, anchor));
            }
            for &(_, v) in &st.candidates {
                if !uses_anchor || v != self.anchor {
                    st.exact_ids.push(v);
                }
            }
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::BeforeVectorRerank);
            let mut j = 0;
            let count = st.exact_ids.len();
            while j < count && st.exact.len() < budget {
                if optimized
                    && j + 4 <= count
                    && budget - st.exact.len() >= 4
                    && dot_simd_available()
                {
                    let values =
                        source.four(q, std::array::from_fn(|k| st.exact_ids[j + k] as usize))?;
                    for k in 0..4 {
                        if let Some(value) = values[k] {
                            st.exact.push((st.exact_ids[j + k], value));
                        }
                    }
                    j += 4;
                } else {
                    let id = st.exact_ids[j];
                    if let Some(value) = source.one(q, id as usize)? {
                        st.exact.push((id, value));
                    }
                    j += 1;
                }
            }
            if st.exact.iter().any(|x| !x.1.is_finite()) {
                return Err(invalid("SM精排分数溢出"));
            }
            counts[4] = st.exact.len();
            if TRACE {
                trace.exact.extend(st.exact.iter().map(|x| x.0));
            }
            st.exact
                .sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            let neighbors = st
                .exact
                .iter()
                .take(cfg.top_k)
                .map(|&(id, score)| (self.ids[id as usize], score))
                .collect();
            Ok(SmSearchOutput {
                neighbors,
                counts,
                trace,
            })
        })
    }
}
