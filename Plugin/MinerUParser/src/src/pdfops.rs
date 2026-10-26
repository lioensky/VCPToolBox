//! PDF 页操作：页数检测与 >200 页分片（MinerU 单文件 200 页上限）。

use crate::error::AppError;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::path::{Path, PathBuf};

/// 单片页数上限（与 MinerU 云端一致）。
pub const CHUNK_PAGE_LIMIT: u64 = 200;

/// 分片区间：0-based [start, end)。
pub fn chunk_ranges(total_pages: u64, chunk_size: u64) -> Vec<(u64, u64)> {
    let size = chunk_size.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while start < total_pages {
        let end = (start + size).min(total_pages);
        out.push((start, end));
        start = end;
    }
    out
}

/// 读取 PDF 页数。加密或损坏的 PDF 返回 FIX 错误。
pub fn page_count(pdf_path: &Path) -> Result<u64, AppError> {
    let doc = Document::load(pdf_path).map_err(|e| {
        AppError::fix(format!(
            "无法解析 PDF {}（可能已加密或结构损坏）：{}",
            pdf_path.display(),
            e
        ))
    })?;
    if doc.is_encrypted() {
        return Err(AppError::fix(format!(
            "PDF 已加密，暂不支持：{}",
            pdf_path.display()
        )));
    }
    Ok(doc.get_pages().len() as u64)
}

pub struct ChunkFile {
    pub index: usize,
    /// 0-based 起始页（含）
    pub start_page: u64,
    /// 0-based 结束页（不含）
    pub end_page: u64,
    pub path: PathBuf,
}

/// 将 PDF 切分为 ≤chunk_size 页的多个文件，写入 chunks_dir（part_1.pdf, part_2.pdf …）。
pub fn split_pdf(
    pdf_path: &Path,
    chunks_dir: &Path,
    chunk_size: u64,
) -> Result<Vec<ChunkFile>, AppError> {
    let total = page_count(pdf_path)?;
    if total == 0 {
        return Err(AppError::fix(format!(
            "PDF 没有任何页面：{}",
            pdf_path.display()
        )));
    }
    let ranges = chunk_ranges(total, chunk_size);
    std::fs::create_dir_all(chunks_dir)
        .map_err(|e| AppError::fix(format!("创建分片目录失败: {}", e)))?;

    let mut out = Vec::new();
    for (index, (start, end)) in ranges.iter().enumerate() {
        // lopdf 的 delete_pages 接收 1-based 页号
        let keep: std::ops::Range<u64> = *start..*end;
        let to_delete: Vec<u32> = (1..=total as u32)
            .filter(|p| !keep.contains(&(*p as u64 - 1)))
            .collect();
        let mut doc = Document::load(pdf_path)
            .map_err(|e| AppError::fix(format!("重新读取 PDF 失败: {}", e)))?;
        doc.delete_pages(&to_delete);
        let path = chunks_dir.join(format!("part_{}.pdf", index + 1));
        doc.save(&path)
            .map_err(|e| AppError::fix(format!("写入分片失败 {}: {}", path.display(), e)))?;
        out.push(ChunkFile {
            index,
            start_page: *start,
            end_page: *end,
            path,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mineruparser_pdfops_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造 N 页空白 PDF（无内容流，仅页面对象树）。
    fn build_blank_pdf(path: &Path, pages: u32) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids: Vec<Object> = Vec::new();
        for _ in 0..pages {
            let mut page = Dictionary::new();
            page.set("Type", Object::from("Page"));
            page.set("Parent", Object::Reference(pages_id));
            kids.push(Object::Reference(doc.add_object(page)));
        }
        let mut pages_dict = Dictionary::new();
        pages_dict.set("Type", Object::from("Pages"));
        pages_dict.set("Count", Object::Integer(pages as i64));
        pages_dict.set("Kids", Object::Array(kids));
        doc.set_object(pages_id, Object::Dictionary(pages_dict));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::from("Catalog"));
        catalog.set("Pages", Object::Reference(pages_id));
        let catalog_id = doc.add_object(catalog);
        // 页树遍历从 trailer 的 Root 出发，必须显式挂接
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(path).unwrap();
    }

    #[test]
    fn ranges_math() {
        assert_eq!(chunk_ranges(0, 200), vec![]);
        assert_eq!(chunk_ranges(1, 200), vec![(0, 1)]);
        assert_eq!(chunk_ranges(200, 200), vec![(0, 200)]);
        assert_eq!(chunk_ranges(201, 200), vec![(0, 200), (200, 201)]);
        assert_eq!(chunk_ranges(450, 200), vec![(0, 200), (200, 400), (400, 450)]);
        assert_eq!(chunk_ranges(5, 0), vec![(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)]);
    }

    #[test]
    fn page_count_of_built_pdf() {
        let dir = temp_dir("count");
        let p = dir.join("t.pdf");
        build_blank_pdf(&p, 7);
        assert_eq!(page_count(&p).unwrap(), 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_preserves_page_counts() {
        let dir = temp_dir("split");
        let src = dir.join("src.pdf");
        build_blank_pdf(&src, 450);
        let chunks = split_pdf(&src, &dir.join("chunks"), 200).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].start_page, 0);
        assert_eq!(chunks[0].end_page, 200);
        assert_eq!(chunks[2].end_page, 450);
        let counts: Vec<u64> = chunks
            .iter()
            .map(|c| page_count(&c.path).unwrap())
            .collect();
        assert_eq!(counts, vec![200, 200, 50]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_fix_error() {
        let err = page_count(Path::new("D:/no/such/file.pdf")).unwrap_err();
        assert!(matches!(err, AppError::Fix(_)));
    }
}
