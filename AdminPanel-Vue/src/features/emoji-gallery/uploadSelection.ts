export const IMAGE_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.bmp";
export const ARCHIVE_UPLOAD_ACCEPT = ".zip,.tar,.tar.gz,.tgz";
export const MAX_UPLOAD_FILES = 40;
export const MAX_UPLOAD_FILE_SIZE = 8 * 1024 * 1024;
export const MAX_ARCHIVE_FILE_SIZE = 200 * 1024 * 1024;

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);
const ALLOWED_ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz"]);

export type UploadMode = "files" | "folder" | "archive";

export interface UploadSelectionRejection {
  readonly fileName: string;
  readonly reason: string;
}

export interface PreparedUploadSelection {
  readonly acceptedFiles: File[];
  readonly acceptedRelativePaths: string[];
  readonly rejected: UploadSelectionRejection[];
  readonly mode: UploadMode;
  readonly resetSelection: boolean;
}

function getFileExtension(fileName: string): string {
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName.endsWith(".tar.gz")) {
    return ".tar.gz";
  }

  const lastDotIndex = lowerFileName.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return "";
  }

  return lowerFileName.slice(lastDotIndex);
}

export function normalizeRelativePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function validateUploadFile(file: File, mode: UploadMode): string | null {
  const extension = getFileExtension(file.name);

  if (mode === "archive") {
    if (!ALLOWED_ARCHIVE_EXTENSIONS.has(extension)) {
      return `不支持的压缩包格式：${extension || "unknown"}`;
    }

    if (file.size > MAX_ARCHIVE_FILE_SIZE) {
      return `压缩包超过大小限制（${Math.floor(
        MAX_ARCHIVE_FILE_SIZE / 1024 / 1024
      )}MB）：${file.name}`;
    }

    return null;
  }

  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    return `不支持的文件格式：${extension || "unknown"}`;
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    return `文件超过大小限制（${Math.floor(MAX_UPLOAD_FILE_SIZE / 1024 / 1024)}MB）：${file.name}`;
  }

  return null;
}

export function prepareUploadSelection(
  files: File[],
  mode: UploadMode,
  relativePaths: string[]
): PreparedUploadSelection {
  if (files.length === 0) {
    return {
      acceptedFiles: [],
      acceptedRelativePaths: [],
      rejected: [],
      mode,
      resetSelection: false,
    };
  }

  if (mode === "archive") {
    const archiveFile = files[0];
    const validationError = validateUploadFile(archiveFile, "archive");

    if (validationError) {
      return {
        acceptedFiles: [],
        acceptedRelativePaths: [],
        rejected: [{ fileName: archiveFile.name, reason: validationError }],
        mode: "archive",
        resetSelection: true,
      };
    }

    return {
      acceptedFiles: [archiveFile],
      acceptedRelativePaths: [archiveFile.name],
      rejected: [],
      mode: "archive",
      resetSelection: false,
    };
  }

  if (files.length > MAX_UPLOAD_FILES) {
    return {
      acceptedFiles: [],
      acceptedRelativePaths: [],
      rejected: [
        {
          fileName: "批量选择",
          reason: `单次上传最多 ${MAX_UPLOAD_FILES} 个文件，当前选择了 ${files.length} 个`,
        },
      ],
      mode,
      resetSelection: true,
    };
  }

  const acceptedFiles: File[] = [];
  const acceptedRelativePaths: string[] = [];
  const rejected: UploadSelectionRejection[] = [];
  const dedupeSet = new Set<string>();

  files.forEach((file, index) => {
    const relativePath = normalizeRelativePath(relativePaths[index] || file.name);
    const validationError = validateUploadFile(file, mode);
    if (validationError) {
      rejected.push({
        fileName: file.name,
        reason: validationError,
      });
      return;
    }

    const signature = `${relativePath}|${file.size}|${file.lastModified}`;
    if (dedupeSet.has(signature)) {
      rejected.push({
        fileName: file.name,
        reason: "重复文件已自动跳过",
      });
      return;
    }

    dedupeSet.add(signature);
    acceptedFiles.push(file);
    acceptedRelativePaths.push(relativePath || file.name);
  });

  return {
    acceptedFiles,
    acceptedRelativePaths,
    rejected,
    mode,
    resetSelection: false,
  };
}
