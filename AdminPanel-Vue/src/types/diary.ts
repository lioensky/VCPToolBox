export interface Note {
  file: string;
  title?: string;
  modified: string;
  content?: string;
  preview?: string;
}

export interface Folder {
  name: string;
  path: string;
  noteCount?: number;
  createdAt?: string;
  modifiedAt?: string;
}

export interface RagTagsConfig {
  thresholdEnabled: boolean;
  threshold: number;
  tags: string[];
}
