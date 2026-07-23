use crate::rivermemo_topology_v3::{load_artifact_from_runtime, MemoRuntime, NativeArtifact};
use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

const OBSERVATION_SCHEMA: &str = "vexus-unified-memo-observation-v1";
const ALGORITHM_VERSION: &str = "tagmemo.spike-v9.1-rust-shared";

fn positive(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn default_energy() -> f64 {
    1.0
}

fn default_source_type() -> String {
    "seed".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseInput {
    #[serde(default)]
    pub(crate) query_id: Option<String>,
    #[serde(default)]
    pub(crate) seeds: Vec<SenseSeed>,
    #[serde(default)]
    pub(crate) config: SenseConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseSeed {
    pub(crate) id: i64,
    #[serde(default = "default_energy")]
    pub(crate) energy: f64,
    #[serde(default = "default_source_type")]
    pub(crate) source_type: String,
}

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct SenseConfig {
    pub(crate) max_safe_hops: usize,
    pub(crate) base_momentum: f64,
    pub(crate) firing_threshold: f64,
    pub(crate) base_decay: f64,
    pub(crate) wormhole_decay: f64,
    pub(crate) tension_threshold: f64,
    pub(crate) max_neighbors_per_node: usize,
    pub(crate) return_flow_factor: f64,
    pub(crate) fir_gamma: f64,
    pub(crate) max_propagation_states: usize,
    pub(crate) minimum_injected_current: f64,
    pub(crate) max_output_nodes: usize,
    pub(crate) max_output_edges: usize,
}

impl Default for SenseConfig {
    fn default() -> Self {
        Self {
            max_safe_hops: 4,
            base_momentum: 2.0,
            firing_threshold: 0.10,
            base_decay: 0.25,
            wormhole_decay: 0.70,
            tension_threshold: 1.0,
            max_neighbors_per_node: 20,
            return_flow_factor: 0.15,
            fir_gamma: 0.6,
            max_propagation_states: 2000,
            minimum_injected_current: 0.01,
            // 0 表示完整输出；旧 JS SOTA 不在河网观测层截断，
            // 只在后续融合层限制 emergent candidates。
            max_output_nodes: 0,
            max_output_edges: 0,
        }
    }
}

#[derive(Clone)]
struct SpikeState {
    node_index: usize,
    previous_index: Option<usize>,
    energy: f64,
    momentum: f64,
    source_type: String,
    hop: usize,
    seed_id: i64,
}

#[derive(Clone)]
struct Provenance {
    source_type: String,
    origin_type: Option<String>,
    hop: usize,
    seed_id: Option<i64>,
}

#[derive(Clone)]
struct Parent {
    parent_id: i64,
    flow: f64,
    hop: usize,
    wormhole: bool,
}

#[derive(Clone)]
struct EdgeFlow {
    source_id: i64,
    target_id: i64,
    flow: f64,
    max_flow: f64,
    conductance: f64,
    min_hop: usize,
    wormhole: bool,
    immediate_return: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationNode {
    pub(crate) id: i64,
    pub(crate) energy: f64,
    pub(crate) normalized_energy: f64,
    pub(crate) source_type: String,
    pub(crate) origin_type: Option<String>,
    pub(crate) hop: usize,
    pub(crate) seed_id: Option<i64>,
    pub(crate) strongest_parent: Option<ObservationParent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationParent {
    pub(crate) parent_id: i64,
    pub(crate) flow: f64,
    pub(crate) hop: usize,
    pub(crate) wormhole: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationEdge {
    pub(crate) source_id: i64,
    pub(crate) target_id: i64,
    pub(crate) flow: f64,
    pub(crate) max_flow: f64,
    pub(crate) normalized_flow: f64,
    pub(crate) conductance: f64,
    pub(crate) min_hop: usize,
    pub(crate) wormhole: bool,
    pub(crate) immediate_return: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseDiagnostics {
    pub(crate) backend: String,
    pub(crate) seed_nodes: usize,
    pub(crate) reached_nodes: usize,
    pub(crate) active_edges: usize,
    pub(crate) maximum_node_energy: f64,
    pub(crate) maximum_edge_flow: f64,
    pub(crate) return_flow_suppressed_mass: f64,
    pub(crate) state_truncations: usize,
    pub(crate) hop_in_flight_mass: Vec<f64>,
    pub(crate) artifact_nodes: usize,
    pub(crate) artifact_edges: usize,
    pub(crate) elapsed_ms: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseOutput {
    pub(crate) schema: String,
    pub(crate) algorithm_version: String,
    pub(crate) artifact_sig: String,
    pub(crate) query_id: Option<String>,
    pub(crate) source_field: Vec<(i64, f64)>,
    pub(crate) nodes: Vec<ObservationNode>,
    pub(crate) edges: Vec<ObservationEdge>,
    pub(crate) diagnostics: SenseDiagnostics,
}

fn fir_weights(config: &SenseConfig) -> Vec<f64> {
    let gamma = config.fir_gamma.clamp(0.05, 0.95);
    let mut weights: Vec<f64> = (0..=config.max_safe_hops)
        .map(|hop| gamma.powi(hop as i32))
        .collect();
    let total: f64 = weights.iter().sum();
    if total > 0.0 {
        for weight in &mut weights {
            *weight /= total;
        }
    }
    weights
}

pub(crate) fn sense_typed(
    artifact: &NativeArtifact,
    artifact_sig: &str,
    input: SenseInput,
) -> std::result::Result<SenseOutput, String> {
    let started_at = Instant::now();
    let config = input.config;
    let weights = fir_weights(&config);
    let mut active: HashMap<(Option<usize>, usize), SpikeState> = HashMap::new();
    let mut accumulated: HashMap<usize, f64> = HashMap::new();
    let mut provenance: HashMap<usize, Provenance> = HashMap::new();
    let mut edge_flows: HashMap<(usize, usize), EdgeFlow> = HashMap::new();
    let mut parents: HashMap<usize, Parent> = HashMap::new();

    for seed in input
        .seeds
        .iter()
        .filter(|seed| seed.id > 0 && seed.energy > 0.0)
    {
        let Some(&node_index) = artifact.node_index.get(&seed.id) else {
            continue;
        };
        let energy = positive(seed.energy);
        let source_type = if seed.source_type.is_empty() {
            "seed".to_string()
        } else {
            seed.source_type.clone()
        };
        active
            .entry((None, node_index))
            .and_modify(|state| state.energy += energy)
            .or_insert(SpikeState {
                node_index,
                previous_index: None,
                energy,
                momentum: config.base_momentum,
                source_type: source_type.clone(),
                hop: 0,
                seed_id: seed.id,
            });
        *accumulated.entry(node_index).or_default() += energy * weights[0];
        provenance.entry(node_index).or_insert(Provenance {
            source_type,
            origin_type: None,
            hop: 0,
            seed_id: Some(seed.id),
        });
    }

    // 空种子是合法的请求级观测：JavaScript SOTA 在 Pyramid 未召回 Tag 时
    // 跳过 Spike，但仍允许传播后补入字符串 Core/幽灵节点参与最终融合；
    // 若后续也没有可融合节点，则返回原查询向量而不是把请求升级为异常。
    let mut return_flow_suppressed_mass = 0.0;
    let mut state_truncations = 0usize;
    let mut hop_in_flight_mass = Vec::new();

    for hop in 0..config.max_safe_hops {
        let mut next: HashMap<(Option<usize>, usize), SpikeState> = HashMap::new();

        for spike in active.values() {
            if spike.energy < config.firing_threshold || spike.momentum < 0.0 {
                continue;
            }
            let start = artifact.row_offsets[spike.node_index];
            let end = artifact.row_offsets[spike.node_index + 1];
            let mut neighbors: Vec<(usize, f64)> = (start..end)
                .map(|cursor| (artifact.targets[cursor], positive(artifact.weights[cursor])))
                .filter(|entry| entry.1 > 0.0)
                .collect();
            neighbors
                .sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
            neighbors.truncate(config.max_neighbors_per_node.max(1));

            for (target_index, conductance) in neighbors {
                let source_id = artifact.node_ids[spike.node_index];
                let target_id = artifact.node_ids[target_index];
                let residual = artifact.anchor_gain.get(&target_id).copied().unwrap_or(1.0);
                let wormhole = artifact.wormhole_edges.contains(&(source_id, target_id))
                    || conductance * residual >= config.tension_threshold;
                let decay = if wormhole {
                    config.wormhole_decay
                } else {
                    config.base_decay
                };
                let immediate_return = spike.previous_index == Some(target_index);
                let unpenalized = spike.energy * conductance * decay;
                let injected = unpenalized
                    * if immediate_return {
                        config.return_flow_factor.clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                if immediate_return {
                    return_flow_suppressed_mass += positive(unpenalized - injected);
                }
                if injected < config.minimum_injected_current {
                    continue;
                }

                let edge = edge_flows
                    .entry((spike.node_index, target_index))
                    .or_insert(EdgeFlow {
                        source_id,
                        target_id,
                        flow: 0.0,
                        max_flow: 0.0,
                        conductance,
                        min_hop: spike.hop + 1,
                        wormhole,
                        immediate_return,
                    });
                edge.flow += injected;
                edge.max_flow = edge.max_flow.max(injected);
                edge.min_hop = edge.min_hop.min(spike.hop + 1);
                edge.wormhole |= wormhole;
                edge.immediate_return |= immediate_return;

                let parent = parents.entry(target_index).or_insert(Parent {
                    parent_id: source_id,
                    flow: injected,
                    hop: spike.hop + 1,
                    wormhole,
                });
                if injected > parent.flow || (injected == parent.flow && spike.hop + 1 < parent.hop)
                {
                    *parent = Parent {
                        parent_id: source_id,
                        flow: injected,
                        hop: spike.hop + 1,
                        wormhole,
                    };
                }

                let next_momentum = spike.momentum - if wormhole { 0.0 } else { 1.0 };
                if next_momentum < 0.0 && !wormhole {
                    continue;
                }
                next.entry((Some(spike.node_index), target_index))
                    .and_modify(|state| {
                        state.energy += injected;
                        state.momentum = state.momentum.max(next_momentum);
                    })
                    .or_insert(SpikeState {
                        node_index: target_index,
                        previous_index: Some(spike.node_index),
                        energy: injected,
                        momentum: next_momentum,
                        source_type: spike.source_type.clone(),
                        hop: spike.hop + 1,
                        seed_id: spike.seed_id,
                    });
            }
        }

        if next.len() > config.max_propagation_states.max(100) {
            let mut retained: Vec<SpikeState> = next.into_values().collect();
            retained.sort_by(|left, right| {
                right
                    .energy
                    .partial_cmp(&left.energy)
                    .unwrap_or(Ordering::Equal)
            });
            let limit = config.max_propagation_states.max(100);
            state_truncations += retained.len().saturating_sub(limit);
            retained.truncate(limit);
            next = retained
                .into_iter()
                .map(|state| ((state.previous_index, state.node_index), state))
                .collect();
        }

        let mut node_energy: HashMap<usize, f64> = HashMap::new();
        let mut in_flight = 0.0;
        for spike in next.values() {
            *node_energy.entry(spike.node_index).or_default() += spike.energy;
            in_flight += spike.energy;
            provenance
                .entry(spike.node_index)
                .and_modify(|value| {
                    if spike.hop < value.hop {
                        *value = Provenance {
                            source_type: "emergent".to_string(),
                            origin_type: Some(spike.source_type.clone()),
                            hop: spike.hop,
                            seed_id: Some(spike.seed_id),
                        };
                    }
                })
                .or_insert(Provenance {
                    source_type: "emergent".to_string(),
                    origin_type: Some(spike.source_type.clone()),
                    hop: spike.hop,
                    seed_id: Some(spike.seed_id),
                });
        }
        hop_in_flight_mass.push(in_flight);

        let field_weight = weights[hop + 1];
        let mut propagated = false;
        for (node_index, energy) in node_energy {
            *accumulated.entry(node_index).or_default() += energy * field_weight;
            propagated |= energy > config.minimum_injected_current;
        }
        if !propagated {
            break;
        }
        active = next;
    }

    let maximum_node_energy = accumulated.values().copied().fold(0.0, f64::max);
    let maximum_edge_flow = edge_flows
        .values()
        .map(|edge| edge.flow)
        .fold(0.0, f64::max);

    let mut nodes: Vec<ObservationNode> = accumulated
        .iter()
        .map(|(&index, &energy)| {
            let meta = provenance.get(&index);
            ObservationNode {
                id: artifact.node_ids[index],
                energy,
                normalized_energy: if maximum_node_energy > 0.0 {
                    energy / maximum_node_energy
                } else {
                    0.0
                },
                source_type: meta
                    .map(|value| value.source_type.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                origin_type: meta.and_then(|value| value.origin_type.clone()),
                hop: meta.map(|value| value.hop).unwrap_or(0),
                seed_id: meta.and_then(|value| value.seed_id),
                strongest_parent: parents.get(&index).map(|parent| ObservationParent {
                    parent_id: parent.parent_id,
                    flow: parent.flow,
                    hop: parent.hop,
                    wormhole: parent.wormhole,
                }),
            }
        })
        .collect();
    nodes.sort_by(|left, right| {
        right
            .energy
            .partial_cmp(&left.energy)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    if config.max_output_nodes > 0 {
        nodes.truncate(config.max_output_nodes);
    }

    let mut edges: Vec<ObservationEdge> = edge_flows
        .into_values()
        .map(|edge| ObservationEdge {
            source_id: edge.source_id,
            target_id: edge.target_id,
            flow: edge.flow,
            max_flow: edge.max_flow,
            normalized_flow: if maximum_edge_flow > 0.0 {
                edge.flow / maximum_edge_flow
            } else {
                0.0
            },
            conductance: edge.conductance,
            min_hop: edge.min_hop,
            wormhole: edge.wormhole,
            immediate_return: edge.immediate_return,
        })
        .collect();
    edges.sort_by(|left, right| {
        right
            .flow
            .partial_cmp(&left.flow)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.source_id.cmp(&right.source_id))
            .then_with(|| left.target_id.cmp(&right.target_id))
    });
    if config.max_output_edges > 0 {
        edges.truncate(config.max_output_edges);
    }

    let total_mass: f64 = nodes.iter().map(|node| node.energy).sum();
    let source_field = nodes
        .iter()
        .filter(|node| node.id > 0 && node.energy > 0.0)
        .map(|node| {
            (
                node.id,
                if total_mass > 0.0 {
                    node.energy / total_mass
                } else {
                    0.0
                },
            )
        })
        .collect();

    Ok(SenseOutput {
        schema: OBSERVATION_SCHEMA.to_string(),
        algorithm_version: ALGORITHM_VERSION.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_id,
        source_field,
        diagnostics: SenseDiagnostics {
            backend: "rust-shared-memo-runtime".to_string(),
            seed_nodes: input.seeds.len(),
            reached_nodes: nodes.len(),
            active_edges: edges.len(),
            maximum_node_energy,
            maximum_edge_flow,
            return_flow_suppressed_mass,
            state_truncations,
            hop_in_flight_mass,
            artifact_nodes: artifact.node_ids.len(),
            artifact_edges: artifact.targets.len(),
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        },
        nodes,
        edges,
    })
}

pub(crate) fn sense(
    artifact: &NativeArtifact,
    artifact_sig: &str,
    input: SenseInput,
) -> std::result::Result<String, String> {
    let output = sense_typed(artifact, artifact_sig, input)?;
    serde_json::to_string(&output)
        .map_err(|error| format!("encode unified Memo observation failed: {}", error))
}

pub struct MemoSensingTask {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
}

impl Task for MemoSensingTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let artifact = load_artifact_from_runtime(&self.runtime, &self.db_path, &self.artifact_sig)
            .map_err(Error::from_reason)?;
        let input: SenseInput = serde_json::from_str(&self.input_json).map_err(|error| {
            Error::from_reason(format!(
                "invalid unified Memo sensing input JSON: {}",
                error
            ))
        })?;
        sense(&artifact, &self.artifact_sig, input).map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn sense_with_runtime(
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
) -> AsyncTask<MemoSensingTask> {
    AsyncTask::new(MemoSensingTask {
        runtime,
        db_path,
        artifact_sig,
        input_json,
    })
}
