use super::*;

#[derive(Debug, Clone)]
pub(crate) struct RecursiveGlobalMapBuild {
    pub global_map_markdown: String,
    pub artifact_refs: Vec<String>,
}

#[derive(Debug, Clone)]
struct RecursiveItem {
    label: String,
    content: String,
}

pub(crate) async fn build_recursive_global_map(
    repo: &WorkspaceRepository,
    document_paths: &paperreader_workspace::DocumentArtifactPaths,
    llm_client: Arc<dyn LlmClient>,
    goal: &str,
    segment_summaries: &HashMap<String, String>,
    config: &RuntimeConfig,
) -> Result<RecursiveGlobalMapBuild> {
    let reading_dir = document_paths
        .reading_state
        .parent()
        .context("reading_state path has no parent")?
        .to_path_buf();
    let recursive_dir = reading_dir.join("recursive_maps");

    let group_size = config.paperreader_recursive_group_size.max(2);
    let max_levels = config.paperreader_recursive_max_levels.max(1);

    let mut items = sorted_recursive_items(segment_summaries);
    if items.is_empty() {
        return Ok(RecursiveGlobalMapBuild {
            global_map_markdown: String::new(),
            artifact_refs: Vec::new(),
        });
    }

    let mut artifact_refs = Vec::new();
    let mut level = 1usize;
    while items.len() > 1 && level <= max_levels {
        let groups = chunk_items(&items, group_size);
        let total_groups = groups.len().max(1);

        let mut join_set = tokio::task::JoinSet::new();
        for (group_index, group_items) in groups.into_iter().enumerate() {
            let llm_client = llm_client.clone();
            let goal = goal.to_string();
            let prompt =
                build_group_prompt(&goal, level, group_index + 1, total_groups, &group_items);
            join_set.spawn(async move {
                let markdown = llm_client.generate(&prompt).await;
                (group_index, group_items, markdown)
            });
        }

        let mut group_outputs = Vec::new();
        while let Some(joined) = join_set.join_next().await {
            let (group_index, group_items, markdown) =
                joined.context("failed to join recursive map task")?;
            let markdown = markdown
                .map_err(|err| anyhow::anyhow!(err.to_string()))
                .unwrap_or_else(|err| {
                    build_fallback_group_markdown(
                        goal,
                        level,
                        group_index + 1,
                        total_groups,
                        &group_items,
                        &err,
                    )
                });
            group_outputs.push((group_index, group_items, markdown));
        }
        group_outputs.sort_by_key(|(group_index, _, _)| *group_index);

        let mut next_items = Vec::new();

        if config.paperreader_recursive_enable_critic {
            let mut critic_set = tokio::task::JoinSet::new();
            for (group_index, group_items, markdown) in group_outputs.into_iter() {
                let llm_client = llm_client.clone();
                let goal = goal.to_string();
                let prompt = build_group_critic_prompt(
                    &goal,
                    level,
                    group_index + 1,
                    total_groups,
                    &markdown,
                    &group_items,
                );
                critic_set.spawn(async move {
                    let critique = llm_client.generate(&prompt).await;
                    (group_index, group_items, markdown, critique)
                });
            }

            let mut critic_outputs = Vec::new();
            while let Some(joined) = critic_set.join_next().await {
                let (group_index, group_items, markdown, critique) =
                    joined.context("failed to join recursive critic task")?;
                let critique = critique
                    .map_err(|err| anyhow::anyhow!(err.to_string()))
                    .unwrap_or_else(|err| {
                        build_fallback_critic_markdown(
                            goal,
                            level,
                            group_index + 1,
                            total_groups,
                            &group_items,
                            &err,
                        )
                    });
                critic_outputs.push((group_index, group_items, markdown, critique));
            }
            critic_outputs.sort_by_key(|(group_index, _, _, _)| *group_index);

            for (group_index, group_items, markdown, critique) in critic_outputs {
                let decorated = format!("{markdown}\n\n---\n\n{critique}");
                let level_dir = recursive_dir.join(format!("level_{level}"));
                let group_path = level_dir.join(format!("group_{:03}.md", group_index + 1));
                repo.write_markdown(&group_path, &decorated)?;
                artifact_refs.push(display_path(&group_path));

                let critic_path = level_dir.join(format!("group_{:03}.critic.md", group_index + 1));
                repo.write_markdown(&critic_path, &critique)?;
                artifact_refs.push(display_path(&critic_path));

                let preview = group_items
                    .iter()
                    .take(3)
                    .map(|item| item.label.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                next_items.push(RecursiveItem {
                    label: format!("level-{level}-group-{} ({preview})", group_index + 1),
                    content: decorated,
                });
            }
        } else {
            for (group_index, group_items, markdown) in group_outputs {
                let level_dir = recursive_dir.join(format!("level_{level}"));
                let group_path = level_dir.join(format!("group_{:03}.md", group_index + 1));
                repo.write_markdown(&group_path, &markdown)?;
                artifact_refs.push(display_path(&group_path));

                let preview = group_items
                    .iter()
                    .take(3)
                    .map(|item| item.label.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                next_items.push(RecursiveItem {
                    label: format!("level-{level}-group-{} ({preview})", group_index + 1),
                    content: markdown,
                });
            }
        }

        items = next_items;
        level = level.saturating_add(1);
    }

    let reduced = if items.len() == 1 {
        items
            .first()
            .map(|item| item.content.clone())
            .unwrap_or_default()
    } else {
        build_unreduced_global_map_markdown(&items)
    };

    let mut global_map = format!(
        "# Global Map (Recursive)\n\n## Goal\n{}\n\n{}\n",
        goal, reduced
    );

    if config.paperreader_recursive_enable_critic {
        let prompt = build_global_map_critic_prompt(goal, &global_map);
        let critique = llm_client
            .generate(&prompt)
            .await
            .map_err(|err| anyhow::anyhow!(err.to_string()))
            .unwrap_or_else(|err| build_fallback_global_map_critic_markdown(goal, &err));
        let critique_path = recursive_dir.join("global_map.critic.md");
        repo.write_markdown(&critique_path, &critique)?;
        artifact_refs.push(display_path(&critique_path));
        global_map = format!("{global_map}\n\n---\n\n{critique}");
    }

    Ok(RecursiveGlobalMapBuild {
        global_map_markdown: global_map,
        artifact_refs,
    })
}

fn sorted_recursive_items(segment_summaries: &HashMap<String, String>) -> Vec<RecursiveItem> {
    if segment_summaries.is_empty() {
        return Vec::new();
    }

    let mut items = segment_summaries
        .iter()
        .map(|(segment_id, summary)| RecursiveItem {
            label: segment_id.clone(),
            content: summary.clone(),
        })
        .collect::<Vec<_>>();

    items.sort_by(|left, right| {
        segment_id_sort_key(&left.label).cmp(&segment_id_sort_key(&right.label))
    });
    items
}

fn chunk_items(items: &[RecursiveItem], group_size: usize) -> Vec<Vec<RecursiveItem>> {
    if items.is_empty() {
        return Vec::new();
    }
    let size = group_size.max(1);
    items
        .chunks(size)
        .map(|chunk| chunk.to_vec())
        .collect::<Vec<_>>()
}

fn build_group_prompt(
    goal: &str,
    level: usize,
    group_index: usize,
    total_groups: usize,
    items: &[RecursiveItem],
) -> String {
    let mut prompt = format!(
        "You are PaperReader's recursive reading map agent.\n\n\
Research Goal: {goal}\n\
Level: {level}\n\
Group: {group_index}/{total_groups}\n\n\
Input items (summaries):\n"
    );

    for item in items {
        prompt.push_str(&format!("- {}: {}\n", item.label, item.content));
    }

    prompt.push_str(
        "\nReturn Markdown with:\n\
## Group Summary\n\
- 5-10 bullets about what this slice contains\n\
## Key Claims (with confidence)\n\
- ...\n\
## Open Questions\n\
- ...\n\
## Useful Keywords\n\
- ...\n",
    );

    prompt
}

fn build_group_critic_prompt(
    goal: &str,
    level: usize,
    group_index: usize,
    total_groups: usize,
    group_markdown: &str,
    inputs: &[RecursiveItem],
) -> String {
    let mut prompt = format!(
        "You are PaperReader's recursive reading CRITIC agent.\n\n\
Research Goal: {goal}\n\
Level: {level}\n\
Group: {group_index}/{total_groups}\n\n\
Group output to audit:\n{group_markdown}\n\n\
Original input labels:\n"
    );
    for item in inputs {
        prompt.push_str(&format!("- {}\n", item.label));
    }
    prompt.push_str(
        "\nReturn Markdown with:\n\
## Critic Notes\n\
- Identify omissions, overclaims, contradictions, and unclear parts.\n\
## Patch Suggestions\n\
- 3-8 concrete patch bullets that would improve the group summary.\n\
## Evidence Needs\n\
- 3-8 bullets describing what evidence/quotes would strengthen the claims.\n",
    );
    prompt
}

fn build_global_map_critic_prompt(goal: &str, global_map: &str) -> String {
    format!(
        "You are PaperReader's recursive reading CRITIC agent.\n\n\
Research Goal: {goal}\n\n\
Global map to audit:\n{global_map}\n\n\
Return Markdown with:\n\
## Critic Notes\n\
- omissions, contradictions, weak claims, missing sections\n\
## Patch Suggestions\n\
- 5-12 concrete edits/additions\n\
## Follow-up Questions\n\
- 5-12 questions that should be answered next\n"
    )
}

fn build_fallback_group_markdown(
    goal: &str,
    level: usize,
    group_index: usize,
    total_groups: usize,
    items: &[RecursiveItem],
    error: &anyhow::Error,
) -> String {
    let input_preview = items
        .iter()
        .map(|item| format!("- {}: {}", item.label, snippet(&item.content)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "## Group Summary\n- (fallback) LLM error while building recursive map: {}\n\n\
### Context\n- goal: {}\n- level: {}\n- group: {}/{}\n\n\
### Input Preview\n{}\n",
        snippet(&error.to_string()),
        goal,
        level,
        group_index,
        total_groups,
        input_preview
    )
}

fn build_fallback_critic_markdown(
    _goal: &str,
    _level: usize,
    _group_index: usize,
    _total_groups: usize,
    items: &[RecursiveItem],
    error: &anyhow::Error,
) -> String {
    let labels = items
        .iter()
        .map(|item| item.label.clone())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "## Critic Notes\n- (fallback) LLM error while critiquing recursive map: {}\n\n\
## Patch Suggestions\n- Re-run recursive mode later (rate limit / transient error).\n- Reduce group size or concurrency.\n\n\
## Evidence Needs\n- (inputs: {})\n",
        snippet(&error.to_string()),
        labels
    )
}

fn build_fallback_global_map_critic_markdown(goal: &str, error: &anyhow::Error) -> String {
    format!(
        "## Critic Notes\n- (fallback) LLM error while auditing global map: {}\n\n\
## Patch Suggestions\n- Re-run recursive mode later.\n- Consider increasing PaperReaderMaxChunks or reducing group size.\n\n\
## Follow-up Questions\n- Which sections are most relevant to: {} ?\n",
        snippet(&error.to_string()),
        goal
    )
}

fn build_unreduced_global_map_markdown(items: &[RecursiveItem]) -> String {
    let mut markdown = String::new();
    markdown.push_str("## Unreduced Items\n");
    for item in items {
        markdown.push_str(&format!("\n### {}\n{}\n", item.label, item.content));
    }
    markdown
}

fn segment_id_sort_key(segment_id: &str) -> (u64, &str) {
    if let Some(rest) = segment_id.strip_prefix("seg-") {
        if let Ok(number) = rest.parse::<u64>() {
            return (number, "");
        }
    }
    (u64::MAX, segment_id)
}
