use super::*;

impl PaperReaderApplication {
    pub fn survey_collection(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let collection_id = CollectionId::new(required_string(payload, "collection_id")?);
        let name = payload_string(payload, "name")
            .or_else(|| payload_string(payload, "collection_name"))
            .unwrap_or_else(|| format!("collection-{}", collection_id.0));
        let goal =
            payload_string(payload, "goal").unwrap_or_else(|| "Survey the collection".to_string());
        let document_ids = required_document_ids(payload, "document_ids")?;
        if document_ids.is_empty() {
            anyhow::bail!("document_ids must not be empty");
        }

        let collection_paths = repo.collection_paths(&collection_id);
        let now = chrono::Utc::now().to_rfc3339();
        let created_at = if collection_paths.collection_manifest.exists() {
            let existing: CollectionManifest =
                repo.read_json(&collection_paths.collection_manifest)?;
            existing.created_at
        } else {
            now.clone()
        };

        let mut member_documents = Vec::new();
        let mut member_roles = Vec::new();
        let mut open_questions = Vec::new();

        for (idx, document_id) in document_ids.iter().enumerate() {
            let document_paths = repo.document_paths(document_id);
            let normalized: NormalizedDocument =
                repo.read_json(&document_paths.normalized_document)?;
            let parse_quality = if normalized.outline.is_empty() {
                ParseQuality::Partial
            } else {
                ParseQuality::Structured
            };
            member_documents.push(DocumentManifest {
                document_id: document_id.clone(),
                title: normalized.title.clone(),
                parse_status: ParseStatus::Parsed,
                parse_quality,
            });

            let notes = if document_paths.reading_state.exists() {
                let reading_state: paperreader_domain::ReadingState =
                    repo.read_json(&document_paths.reading_state)?;
                reading_state
                    .rolling_context
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| snippet(&value))
                    .unwrap_or_default()
            } else {
                String::new()
            };

            member_roles.push(CollectionMemberRole {
                document_id: document_id.clone(),
                title: normalized.title.clone(),
                role: if idx == 0 {
                    "anchor".to_string()
                } else {
                    "supporting".to_string()
                },
                notes,
            });

            if document_paths.handoff.exists() {
                let handoff: HandoffArtifact = repo.read_json(&document_paths.handoff)?;
                open_questions.extend(handoff.open_questions.into_iter().map(|q| q.text));
            }
        }

        open_questions.sort();
        open_questions.dedup();
        if open_questions.len() > 50 {
            open_questions.truncate(50);
        }

        let collection_manifest = CollectionManifest {
            collection_id: collection_id.clone(),
            name: name.clone(),
            goal: goal.clone(),
            document_count: member_documents.len(),
            created_at,
            updated_at: now.clone(),
        };
        let collection_map = CollectionMapArtifact {
            collection_id: collection_id.clone(),
            goal: goal.clone(),
            member_roles,
            open_questions,
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        repo.write_json(&collection_paths.collection_manifest, &collection_manifest)?;
        repo.write_json(&collection_paths.member_documents, &member_documents)?;
        repo.write_json(&collection_paths.collection_map, &collection_map)?;

        Ok(json!({
            "collection_id": collection_id,
            "name": name,
            "goal": goal,
            "document_ids": document_ids,
            "collection_manifest_ref": display_path(&collection_paths.collection_manifest),
            "member_documents_ref": display_path(&collection_paths.member_documents),
            "collection_map_ref": display_path(&collection_paths.collection_map),
            "artifact_refs": [
                display_path(&collection_paths.collection_manifest),
                display_path(&collection_paths.member_documents),
                display_path(&collection_paths.collection_map)
            ]
        }))
    }

    pub async fn synthesize_collection(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let collection_id = CollectionId::new(required_string(payload, "collection_id")?);
        let collection_paths = repo.collection_paths(&collection_id);
        let synthesis_mode = payload_string(payload, "mode")
            .unwrap_or_else(|| "synthesis".to_string())
            .to_lowercase();
        let constraints = requested_constraints(payload);
        let document_roles = payload
            .get("document_roles")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let manifest: Option<CollectionManifest> = if collection_paths.collection_manifest.exists()
        {
            Some(repo.read_json(&collection_paths.collection_manifest)?)
        } else {
            None
        };
        let goal = payload_string(payload, "goal")
            .or_else(|| manifest.as_ref().map(|m| m.goal.clone()))
            .unwrap_or_else(|| "Synthesize collection".to_string());

        let document_ids = if let Ok(ids) = required_document_ids(payload, "document_ids") {
            ids
        } else if collection_paths.member_documents.exists() {
            let members: Vec<DocumentManifest> =
                repo.read_json(&collection_paths.member_documents)?;
            members.into_iter().map(|m| m.document_id).collect()
        } else {
            anyhow::bail!("missing required payload field: document_ids");
        };

        if synthesis_mode == "compare" {
            let compare = self.compare_documents(&json!({
                "workspace_root": repo.layout.root,
                "collection_id": collection_id,
                "document_ids": document_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
            }))?;
            return Ok(json!({
                "collection_id": collection_id,
                "goal": goal,
                "mode": synthesis_mode,
                "constraints": constraints,
                "document_roles": document_roles,
                "document_ids": document_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
                "comparison_table_ref": compare["comparison_table_ref"].clone(),
                "artifact_refs": compare["artifact_refs"].clone(),
                "comparison": compare.get("comparison").cloned().unwrap_or(Value::Null),
                "comparison_table": compare["comparison_table"].clone(),
            }));
        }

        if synthesis_mode == "conflict_audit" {
            let audit = self.audit_collection_conflicts(&json!({
                "workspace_root": repo.layout.root,
                "collection_id": collection_id,
                "document_ids": document_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
                "goal": goal,
            }))?;
            return Ok(json!({
                "collection_id": collection_id,
                "goal": goal,
                "mode": synthesis_mode,
                "constraints": constraints,
                "document_roles": document_roles,
                "aligned_claims_ref": audit["aligned_claims_ref"].clone(),
                "conflict_report_ref": audit["conflict_report_ref"].clone(),
                "artifact_refs": audit["artifact_refs"].clone(),
                "audit_summary": audit["audit_summary"].clone(),
            }));
        }

        let comparison_table = if collection_paths.comparison_table_latest.exists() {
            repo.read_json(&collection_paths.comparison_table_latest)?
        } else {
            self.build_collection_compare_artifact(&repo, &collection_id, &document_ids)?
        };
        let comparison_table_ref = display_path(&collection_paths.comparison_table_latest);
        let audit = if collection_paths.aligned_claims_latest.exists()
            && collection_paths.conflict_report_latest.exists()
        {
            json!({
                "aligned_claims_ref": display_path(&collection_paths.aligned_claims_latest),
                "conflict_report_ref": display_path(&collection_paths.conflict_report_latest),
                "audit_summary": repo.read_json::<Value>(&collection_paths.conflict_report_latest)?
                    .get("audit_summary")
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        } else {
            self.audit_collection_conflicts(&json!({
                "workspace_root": repo.layout.root,
                "collection_id": collection_id,
                "document_ids": document_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
            }))?
        };

        let mut doc_lines = Vec::new();
        let mut fact_lines = Vec::new();
        let mut question_lines = Vec::new();
        for document_id in document_ids.iter() {
            let doc_paths = repo.document_paths(document_id);
            let title = if doc_paths.normalized_document.exists() {
                let normalized: NormalizedDocument =
                    repo.read_json(&doc_paths.normalized_document)?;
                normalized.title
            } else {
                document_id.0.clone()
            };
            doc_lines.push(format!("- {}: {}", document_id.0, title));

            if doc_paths.handoff.exists() {
                let handoff: HandoffArtifact = repo.read_json(&doc_paths.handoff)?;
                for fact in handoff.confirmed_facts.into_iter().take(10) {
                    fact_lines.push(format!("- [{}] {}", document_id.0, fact.text));
                }
                for question in handoff.open_questions.into_iter().take(10) {
                    question_lines.push(format!("- [{}] {}", document_id.0, question.text));
                }
            }
        }

        fact_lines.sort();
        fact_lines.dedup();
        if fact_lines.len() > 30 {
            fact_lines.truncate(30);
        }
        question_lines.sort();
        question_lines.dedup();
        if question_lines.len() > 30 {
            question_lines.truncate(30);
        }

        let synthesis_md = format!(
            "# Collection Synthesis\n\n## Collection\n- id: {}\n- goal: {}\n- mode: {}\n\n## Constraints\n{}\n\n## Document Roles\n{}\n\n## Documents\n{}\n\n## Comparison Coverage\n{}\n\n## Conflict Audit Summary\n{}\n\n## Confirmed Facts (Sample)\n{}\n\n## Open Questions (Sample)\n{}\n\n## Next Actions\n- audit_collection_conflicts\n- compare_documents\n",
            collection_id.0,
            goal,
            synthesis_mode,
            format_constraints_markdown(&constraints),
            serde_json::to_string_pretty(&document_roles).unwrap_or_else(|_| "{}".to_string()),
            doc_lines.join("\n"),
            format_collection_compare_markdown(&comparison_table),
            format_collection_audit_markdown(audit.get("audit_summary")),
            if fact_lines.is_empty() {
                "- (none)".to_string()
            } else {
                fact_lines.join("\n")
            },
            if question_lines.is_empty() {
                "- (none)".to_string()
            } else {
                question_lines.join("\n")
            },
        );

        repo.write_markdown(&collection_paths.collection_synthesis_latest, &synthesis_md)?;
        let collection_map_ref = display_path(&collection_paths.collection_map);
        let aligned_claims_ref = audit
            .get("aligned_claims_ref")
            .and_then(|value| value.as_str())
            .map(ToString::to_string);
        let conflict_report_ref = audit
            .get("conflict_report_ref")
            .and_then(|value| value.as_str())
            .map(ToString::to_string);

        Ok(json!({
            "collection_id": collection_id,
            "goal": goal,
            "mode": synthesis_mode,
            "constraints": constraints,
            "document_roles": document_roles,
            "collection_map_ref": collection_map_ref,
            "comparison_table_ref": comparison_table_ref,
            "aligned_claims_ref": aligned_claims_ref,
            "conflict_report_ref": conflict_report_ref,
            "collection_synthesis_ref": display_path(&collection_paths.collection_synthesis_latest),
            "artifact_refs": [
                display_path(&collection_paths.collection_synthesis_latest),
                display_path(&collection_paths.collection_map),
                display_path(&collection_paths.comparison_table_latest),
                display_path(&collection_paths.aligned_claims_latest),
                display_path(&collection_paths.conflict_report_latest)
            ]
        }))
    }

    pub fn compare_documents(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let collection_id = CollectionId::new(required_string(payload, "collection_id")?);
        let document_ids = resolve_compare_document_ids(payload)?;
        let comparison_table =
            self.build_collection_compare_artifact(&repo, &collection_id, &document_ids)?;
        let collection_paths = repo.collection_paths(&collection_id);
        let mut response = json!({
            "collection_id": collection_id,
            "document_ids": document_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
            "comparison_table_ref": display_path(&collection_paths.comparison_table_latest),
            "artifact_refs": [display_path(&collection_paths.comparison_table_latest)],
            "comparison_table": comparison_table
        });
        if document_ids.len() == 2 {
            if let Some(comparison) = response["comparison_table"]
                .get("pairwise_comparisons")
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
                .and_then(|item| item.get("comparison"))
            {
                response["comparison"] = comparison.clone();
            }
        }
        Ok(response)
    }

    fn build_collection_compare_artifact(
        &self,
        repo: &WorkspaceRepository,
        collection_id: &CollectionId,
        document_ids: &[DocumentId],
    ) -> Result<Value> {
        if document_ids.len() < 2 {
            anyhow::bail!("compare mode requires at least two documents");
        }

        let loaded_documents = document_ids
            .iter()
            .map(|document_id| {
                let document_paths = repo.document_paths(document_id);
                let document: NormalizedDocument =
                    repo.read_json(&document_paths.normalized_document)?;
                let claims = load_claim_units_for_document(repo, document_id).unwrap_or_default();
                Ok((document_id.clone(), document, claims))
            })
            .collect::<Result<Vec<_>>>()?;

        let mut pairwise_comparisons = Vec::new();
        let mut key_differences = BTreeSet::new();
        for left_index in 0..loaded_documents.len() {
            for right_index in (left_index + 1)..loaded_documents.len() {
                let (left_id, left_doc, left_claims) = &loaded_documents[left_index];
                let (right_id, right_doc, right_claims) = &loaded_documents[right_index];
                let comparison =
                    corpus::compare_documents(left_doc, right_doc, left_claims, right_claims);
                for difference in comparison.key_differences.iter() {
                    key_differences.insert(difference.clone());
                }
                pairwise_comparisons.push(json!({
                    "pair_id": format!("{}::{}", left_id.0, right_id.0),
                    "document_ids": [left_id.0.clone(), right_id.0.clone()],
                    "comparison": comparison,
                }));
            }
        }

        let comparison_table = json!({
            "collection_id": collection_id,
            "document_ids": document_ids.iter().map(|id| id.0.clone()).collect::<Vec<_>>(),
            "document_count": document_ids.len(),
            "pair_count": pairwise_comparisons.len(),
            "comparison_mode": if document_ids.len() == 2 { "pair" } else { "pairwise_matrix" },
            "pairwise_comparisons": pairwise_comparisons,
            "key_differences": key_differences.into_iter().collect::<Vec<_>>(),
            "created_at": chrono::Utc::now().to_rfc3339(),
        });

        let collection_paths = repo.collection_paths(collection_id);
        repo.write_json(&collection_paths.comparison_table_latest, &comparison_table)?;
        Ok(comparison_table)
    }

    pub fn audit_collection_conflicts(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let collection_id = CollectionId::new(required_string(payload, "collection_id")?);
        let collection_paths = repo.collection_paths(&collection_id);
        let now = chrono::Utc::now().to_rfc3339();

        let member_documents_disk: Option<Vec<DocumentManifest>> =
            if collection_paths.member_documents.exists() {
                Some(repo.read_json(&collection_paths.member_documents)?)
            } else {
                None
            };

        let document_ids = if let Ok(ids) = required_document_ids(payload, "document_ids") {
            ids
        } else if let Some(ref members) = member_documents_disk {
            members.iter().map(|doc| doc.document_id.clone()).collect()
        } else {
            anyhow::bail!("missing required payload field: document_ids");
        };
        if document_ids.is_empty() {
            anyhow::bail!("document_ids must not be empty");
        }

        let (name, goal, created_at) = if collection_paths.collection_manifest.exists() {
            let manifest: CollectionManifest =
                repo.read_json(&collection_paths.collection_manifest)?;
            (manifest.name, manifest.goal, manifest.created_at)
        } else {
            (
                payload_string(payload, "name")
                    .or_else(|| payload_string(payload, "collection_name"))
                    .unwrap_or_else(|| format!("collection-{}", collection_id.0)),
                payload_string(payload, "goal")
                    .unwrap_or_else(|| "Audit collection conflicts".to_string()),
                now.clone(),
            )
        };

        let mut collection = Collection::new(collection_id.clone(), name.clone(), goal.clone());
        for document_id in document_ids.iter().cloned() {
            collection.add_document(document_id);
        }

        let member_documents = member_documents_disk.unwrap_or_else(|| {
            document_ids
                .iter()
                .filter_map(|document_id| {
                    let paths = repo.document_paths(document_id);
                    if !paths.normalized_document.exists() {
                        return None;
                    }
                    let normalized: NormalizedDocument =
                        repo.read_json(&paths.normalized_document).ok()?;
                    let parse_quality = if normalized.outline.is_empty() {
                        ParseQuality::Partial
                    } else {
                        ParseQuality::Structured
                    };
                    Some(DocumentManifest {
                        document_id: document_id.clone(),
                        title: normalized.title,
                        parse_status: ParseStatus::Parsed,
                        parse_quality,
                    })
                })
                .collect::<Vec<_>>()
        });

        let mut all_claims = Vec::new();
        for document_id in document_ids.iter() {
            let mut claims = load_claim_units_for_document(&repo, document_id).unwrap_or_default();
            all_claims.append(&mut claims);
        }

        let audit = corpus::audit_collection_conflicts(&collection, &all_claims);
        repo.write_json(
            &collection_paths.aligned_claims_latest,
            &audit.claim_alignment,
        )?;
        repo.write_json(&collection_paths.conflict_report_latest, &audit)?;

        let manifest = CollectionManifest {
            collection_id: collection_id.clone(),
            name: name.clone(),
            goal: goal.clone(),
            document_count: member_documents.len(),
            created_at,
            updated_at: now.clone(),
        };
        repo.write_json(&collection_paths.collection_manifest, &manifest)?;
        if !collection_paths.member_documents.exists() {
            repo.write_json(&collection_paths.member_documents, &member_documents)?;
        }

        Ok(json!({
            "collection_id": collection_id,
            "audit_summary": audit.audit_summary,
            "aligned_claims_ref": display_path(&collection_paths.aligned_claims_latest),
            "conflict_report_ref": display_path(&collection_paths.conflict_report_latest),
            "artifact_refs": [
                display_path(&collection_paths.aligned_claims_latest),
                display_path(&collection_paths.conflict_report_latest)
            ],
            "created_at": now
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct CollectionMapArtifact {
    pub collection_id: CollectionId,
    pub goal: String,
    pub member_roles: Vec<CollectionMemberRole>,
    pub open_questions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct CollectionMemberRole {
    pub document_id: DocumentId,
    pub title: String,
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub notes: String,
}

fn parse_two_document_ids(payload: &Value) -> Result<(DocumentId, DocumentId)> {
    if let Some(values) = payload
        .get("document_ids")
        .and_then(|value| value.as_array())
    {
        if values.len() != 2 {
            anyhow::bail!("document_ids must have exactly 2 items");
        }
        let left = values[0]
            .as_str()
            .context("document_ids must contain strings")?;
        let right = values[1]
            .as_str()
            .context("document_ids must contain strings")?;
        return Ok((DocumentId::new(left), DocumentId::new(right)));
    }

    let doc_a = payload_string(payload, "document_id_a")
        .or_else(|| payload_string(payload, "doc_a"))
        .context("missing required payload field: document_ids")?;
    let doc_b = payload_string(payload, "document_id_b")
        .or_else(|| payload_string(payload, "doc_b"))
        .context("missing required payload field: document_ids")?;
    Ok((DocumentId::new(doc_a), DocumentId::new(doc_b)))
}

fn resolve_compare_document_ids(payload: &Value) -> Result<Vec<DocumentId>> {
    if let Ok(document_ids) = required_document_ids(payload, "document_ids") {
        if document_ids.len() < 2 {
            anyhow::bail!("document_ids must have at least 2 items");
        }
        return Ok(document_ids);
    }

    let (left, right) = parse_two_document_ids(payload)?;
    Ok(vec![left, right])
}

fn format_collection_compare_markdown(comparison_table: &Value) -> String {
    let document_count = comparison_table
        .get("document_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let pair_count = comparison_table
        .get("pair_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let differences = comparison_table
        .get("key_differences")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .take(5)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let difference_summary = if differences.is_empty() {
        "(none)".to_string()
    } else {
        differences.join("; ")
    };
    format!(
        "- documents compared: {document_count}\n- pairwise comparisons: {pair_count}\n- key differences: {difference_summary}"
    )
}

fn format_collection_audit_markdown(audit_summary: Option<&Value>) -> String {
    let Some(summary) = audit_summary else {
        return "- audit summary unavailable".to_string();
    };
    if let Some(text) = summary.as_str() {
        return format!("- {text}");
    }
    if let Some(conflict_count) = summary
        .get("conflict_count")
        .and_then(|value| value.as_u64())
    {
        let severity = summary
            .get("highest_severity")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        return format!("- conflict_count: {conflict_count}\n- highest_severity: {severity}");
    }
    format!(
        "- summary: {}",
        serde_json::to_string(summary).unwrap_or_else(|_| "{}".to_string())
    )
}
